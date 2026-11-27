import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DeviceSettingsSync, stageDeviceSettings } from '../src/shadow/DeviceSettingsSync';
import { deferred } from './helpers/deferred';

const configDir = 'custom-config';
const app = `${configDir}/app.json`;
const appearance = `${configDir}/appearance.json`;
const core = `${configDir}/core-plugins.json`;
const hotkeys = `${configDir}/hotkeys.json`;

describe('DeviceSettingsSync', () => {
  let localConfigDir: string;
  let sync: DeviceSettingsSync;
  let onChange: (filename: string | null) => void;
  const diagnose = vi.fn();
  const close = vi.fn();
  const write = vi.fn(async (_path: string, content: string, _signal: AbortSignal) => content);
  const read = vi.fn(async (_path: string, _signal: AbortSignal): Promise<string | null> => null);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    localConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-settings-'));
    sync = new DeviceSettingsSync({
      localConfigDir, remoteConfigDir: configDir,
      remote: { readDeviceSetting: read, writeDeviceSetting: write },
      watch: (callback) => { onChange = callback; return { close }; },
      diagnose,
    });
  });

  afterEach(() => {
    sync.stop();
    vi.useRealTimers();
    fs.rmSync(localConfigDir, { recursive: true, force: true });
  });

  function save(basename: string, content: string): void {
    fs.writeFileSync(path.join(localConfigDir, basename), content);
  }

  function local(basename: string): string {
    return fs.readFileSync(path.join(localConfigDir, basename), 'utf8');
  }

  const debounce = () => vi.advanceTimersByTimeAsync(1500);
  const requests = () => write.mock.calls.map(([file, content]) => [file, content]);

  it('retries the same failed bytes on a later event without resending the successful sibling', async () => {
    save('app.json', '{"changed": true}');
    save('hotkeys.json', '{ "saved": true }\n');
    write.mockRejectedValueOnce(new Error('remote rejected app.json'));
    sync.startWatching();
    onChange('app.json');
    onChange(null);
    expect(write).not.toHaveBeenCalled();
    await debounce();
    expect(requests()).toEqual([[app, '{"changed": true}'], [hotkeys, '{ "saved": true }\n']]);
    expect(diagnose).toHaveBeenCalledWith({ operation: 'send', files: ['app.json'] });

    await vi.advanceTimersByTimeAsync(3000);
    expect(write).toHaveBeenCalledTimes(2);
    onChange(null);
    await debounce();
    expect(requests().slice(2)).toEqual([[app, '{"changed": true}']]);
  });

  it('debounces a fresh sibling save during an older in-flight flush', async () => {
    const pending = deferred<string>();
    const appValue = '{"app":1}';
    write.mockReturnValueOnce(pending.promise);
    save('app.json', appValue);
    save('hotkeys.json', '{"keys":1}');
    sync.startWatching();
    onChange(null);
    await debounce();
    expect(write).toHaveBeenCalledOnce();

    save('hotkeys.json', '{"keys":2}');
    onChange('hotkeys.json');
    pending.resolve(appValue);
    await vi.advanceTimersByTimeAsync(100);
    expect(write).toHaveBeenCalledOnce();

    save('hotkeys.json', '{"keys":3}');
    onChange('hotkeys.json');
    await debounce();
    expect(requests()).toEqual([[app, appValue], [hotkeys, '{"keys":3}']]);
  });

  it('stages exact JSON and leaves each failed or missing local copy alone', async () => {
    save('app.json', '{"local": true}');
    save('appearance.json', '{"theme": "local"}');
    fs.mkdirSync(path.join(localConfigDir, 'core-plugins.json'));
    const formatted = '{\r\n  "hotkeys" : [ "é" ]\r\n}\r\n';
    read.mockImplementation(async (file) => {
      if (file === app) throw new Error('remote read failed');
      if (file === appearance) return '{ incomplete';
      if (file === core) return '[]';
      return formatted;
    });

    const result = await stageDeviceSettings({ localConfigDir, remoteConfigDir: configDir }, { readDeviceSetting: read });
    expect(result).toEqual({ pulled: ['hotkeys.json'], failed: ['app.json', 'appearance.json', 'core-plugins.json'] });
    expect(local('app.json')).toBe('{"local": true}');
    expect(local('appearance.json')).toBe('{"theme": "local"}');
    expect(local('hotkeys.json')).toBe(formatted);
    expect(fs.readdirSync(localConfigDir).sort()).toEqual(['app.json', 'appearance.json', 'core-plugins.json', 'hotkeys.json']);

    read.mockResolvedValue(null);
    await expect(stageDeviceSettings({ localConfigDir, remoteConfigDir: configDir }, { readDeviceSetting: read }))
      .resolves.toEqual({ pulled: [], failed: [] });
    expect(local('hotkeys.json')).toBe(formatted);
  });

  it('cannot publish an in-flight staging read after cancellation', async () => {
    const controller = new AbortController();
    const pending = deferred<string>();
    read.mockReturnValueOnce(pending.promise);
    save('app.json', '{"local":true}');
    const staging = stageDeviceSettings({ localConfigDir, remoteConfigDir: configDir }, { readDeviceSetting: read }, controller.signal);
    expect(read).toHaveBeenCalledOnce();
    controller.abort();
    pending.resolve('{"stale":true}');
    await staging;
    expect(local('app.json')).toBe('{"local":true}');
    expect(read).toHaveBeenCalledOnce();
  });

  it('checks for edits between pull and watch, then ignores confirmed bytes and non-settings files', async () => {
    const pulled = '{ "from": "remote" }\n';
    const edited = '{ "from": "local" }\n';
    save('hotkeys.json', '{"old":true}');
    read.mockResolvedValueOnce(pulled).mockResolvedValueOnce(pulled);
    await sync.pull();
    expect(local('app.json')).toBe(pulled);
    save('appearance.json', edited);
    sync.startWatching();
    await debounce();
    expect(requests()).toEqual([[appearance, edited]]);

    save('app.json', pulled);
    onChange('app.json');
    onChange('appearance.json');
    onChange('workspace.json');
    await debounce();
    expect(write).toHaveBeenCalledOnce();
    expect(diagnose).not.toHaveBeenCalled();
  });

  it('skips missing settings and reports invalid settings without sending them', async () => {
    save('app.json', '{broken');
    save('core-plugins.json', '[ "graph" ]\n');
    sync.startWatching();
    onChange(null);
    await debounce();
    expect(requests()).toEqual([[core, '[ "graph" ]\n']]);
    expect(diagnose).toHaveBeenCalledWith({ operation: 'send', files: ['app.json'] });
    fs.rmSync(path.join(localConfigDir, 'core-plugins.json'));
    onChange('core-plugins.json');
    await debounce();
    expect(write).toHaveBeenCalledOnce();
    expect(diagnose).toHaveBeenCalledOnce();
  });

  it.each([true, false])('sends a newer edit after the pending write settles (watch event: %s)', async (eventDelivered) => {
    const pending = deferred<string>();
    const first = '{"edit":1}';
    const second = '{"edit":2}';
    write.mockReturnValueOnce(pending.promise);
    save('app.json', first);
    sync.startWatching();
    onChange('app.json');
    await debounce();
    save('app.json', second);
    if (eventDelivered) onChange('app.json');
    await debounce();
    expect(requests()).toEqual([[app, first]]);
    pending.resolve('{ "approvedMerge": true }\n');
    await Promise.resolve();
    expect(local('app.json')).toBe(second);
    await debounce();
    expect(requests()).toEqual([[app, first], [app, second]]);
    expect(local('app.json')).toBe(second);
  });

  it('installs and acknowledges the exact approved merge where the submitted snapshot is still on disk', async () => {
    const submitted = '{"mine":true}';
    const merged = '{\r\n  "mine": true, "theirs" : 1\r\n}\r\n';
    write.mockResolvedValueOnce(merged);
    save('app.json', submitted);
    sync.startWatching();
    onChange('app.json');
    await debounce();
    expect(local('app.json')).toBe(merged);
    onChange('app.json');
    await debounce();
    expect(requests()).toEqual([[app, submitted]]);
  });

  it('sends a coalesced newer edit even when the previous snapshot was rejected', async () => {
    const pending = deferred<string>();
    write.mockReturnValueOnce(pending.promise);
    save('app.json', '{"edit":1}');
    sync.startWatching();
    onChange('app.json');
    await debounce();
    save('app.json', '{"edit":2}');
    pending.reject(new Error('remote rejected edit 1'));
    await debounce();
    expect(requests()).toEqual([[app, '{"edit":1}'], [app, '{"edit":2}']]);
  });

  it('preserves the settings installed before a transport loss and ends that pull', async () => {
    const pending = deferred<string>();
    read.mockResolvedValueOnce('{ "installed": true }\n').mockReturnValueOnce(pending.promise);
    const pulling = sync.pull();
    await Promise.resolve();
    expect(local('app.json')).toBe('{ "installed": true }\n');
    sync.pause();
    await pulling;
    expect(read.mock.calls[1][1].aborted).toBe(true);

    const edited = '{"savedWhileOffline":true}';
    save('app.json', edited);
    save('appearance.json', '{"local":true}');
    sync.startWatching();
    sync.resume();
    pending.resolve('{"late":true}');
    await debounce();
    expect(local('appearance.json')).toBe('{"local":true}');
    expect(read).toHaveBeenCalledTimes(2);
    expect(requests()).toEqual([[app, edited]]);
    expect(diagnose).not.toHaveBeenCalled();
  });

  it('retries pending and failed settings from current disk bytes after recovery', async () => {
    const pending = deferred<string>();
    write.mockRejectedValueOnce(new Error('write failed')).mockReturnValueOnce(pending.promise);
    save('app.json', '{"app":1}');
    save('hotkeys.json', '{"hotkeys":1}');
    sync.startWatching();
    onChange(null);
    await debounce();
    sync.pause();
    expect(write.mock.calls[1][2].aborted).toBe(true);
    save('app.json', '{"app":2}');
    save('hotkeys.json', '{"hotkeys":2}');
    onChange('hotkeys.json');
    pending.resolve('{"lateMerge":true}');
    await debounce();
    expect(write).toHaveBeenCalledTimes(2);
    expect(local('hotkeys.json')).toBe('{"hotkeys":2}');
    expect(diagnose).not.toHaveBeenCalled();

    sync.resume();
    await debounce();
    expect(requests().slice(2)).toEqual([[hotkeys, '{"hotkeys":2}'], [app, '{"app":2}']]);
  });

  it('stops the watch and suppresses late installs, sibling sends, and diagnostics after teardown', async () => {
    const pending = deferred<string>();
    write.mockReturnValueOnce(pending.promise);
    save('app.json', '{"mine":true}');
    save('hotkeys.json', '[]');
    sync.startWatching();
    onChange(null);
    await debounce();
    sync.stop();
    expect(close).toHaveBeenCalledOnce();
    expect(write.mock.calls[0][2].aborted).toBe(true);
    pending.resolve('{"lateMerge":true}');
    sync.resume();
    onChange('hotkeys.json');
    await debounce();
    expect(local('app.json')).toBe('{"mine":true}');
    expect(write).toHaveBeenCalledOnce();
    expect(diagnose).not.toHaveBeenCalled();
  });
});
