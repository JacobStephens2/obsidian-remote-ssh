// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';
import * as obsidian from './__mocks__/obsidian';
import { DEFAULT_SETTINGS } from '../src/constants';
import type { AdapterManager } from '../src/adapter/AdapterManager';

class TFile {
  name: string;
  stat = { size: 4, mtime: 1000, ctime: 1000 };
  constructor(public vault: unknown, public path: string) { this.name = path.split('/').pop()!; }
}
class TFolder {
  name: string;
  children: (TFile | TFolder)[] = [];
  constructor(public vault: unknown, public path: string) { this.name = path.split('/').pop()!; }
  isRoot() { return this.path === ''; }
}

// Use production's CommonJS live-property imports: native ESM fs snapshots
// would hide self-interception by the compatibility patch.
const bundle = buildSync({
  entryPoints: ['src/adapter/AdapterManager.ts'], bundle: true, write: false,
  format: 'cjs', platform: 'node', target: 'node18', external: ['obsidian', 'ssh2'],
}).outputFiles[0].text;
const nodeRequire = createRequire(import.meta.url);
const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(f => f()); vi.useRealTimers(); });

function harness(settings = {}, eligible = true, filesystemBacked = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-lifetime-'));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const events: ((event: string, filename: string | null) => void)[] = [];
  const close = vi.fn();
  const surface = { ...fs, promises: { ...fs.promises }, watch: vi.fn((_root, _opts, cb) => {
    events.push(cb); return { close };
  }) };
  const module = { exports: {} as { AdapterManager: typeof AdapterManager } };
  new Function('require', 'module', 'exports', bundle)((id: string) => {
    if (id === 'fs') return surface;
    if (id === 'fs/promises') return surface.promises;
    if (id === 'obsidian') return { ...obsidian, TFile, TFolder };
    return nodeRequire(id);
  }, module, module.exports);
  const adapter = new obsidian.FileSystemAdapter();
  adapter.setBasePath(root);
  const folder = new TFolder(null, '');
  const note = new TFile(null, 'note.md');
  folder.children.push(note);
  const fileMap: Record<string, TFile | TFolder> = { '': folder, 'note.md': note };
  const vault = { adapter: filesystemBacked ? adapter : {}, configDir: '.custom', fileMap,
    getName: () => 'shadow', getRoot: () => folder,
    getAbstractFileByPath: (p: string) => fileMap[p] ?? null, trigger: vi.fn() };
  const remote = {
    stat: vi.fn(async () => ({ size: 4, mtime: 1000, isFile: true, isDirectory: false })),
    readBinary: vi.fn(async () => Buffer.from('warm')),
    writeBinary: vi.fn(async () => {}), mkdirp: vi.fn(async () => {}),
    remove: vi.fn(async () => {}), exists: vi.fn(async () => true),
  };
  const conn = { activeRemoteBasePath: '/remote', activeProfile: { id: 'p' },
    rpcConnection: null, buildFsClient: () => remote };
  const unsubscribe = vi.fn();
  const mgr = new module.exports.AdapterManager(
    { vault } as never, { id: 'remote-ssh' } as never, conn as never,
    { unsubscribe, subscribe: vi.fn() } as never, { startPolling: vi.fn() } as never,
    () => ({ ...DEFAULT_SETTINGS, autoConnectProfileId: eligible ? 'p' : null, ...settings }),
  );
  vi.stubGlobal('window', { require: (id: string) => id === 'fs' ? surface : nodeRequire(id),
    setTimeout: (cb, ms) => setTimeout(cb, ms), clearTimeout: h => clearTimeout(h) });
  cleanup.push(() => vi.unstubAllGlobals());
  cleanup.push(() => mgr.restore());
  return { mgr, root, surface, remote, adapter, vault, events, close, unsubscribe, conn };
}

describe('AdapterManager filesystem lifetime', () => {
  it.each([[false, true], [true, false]])('keeps ordinary adapters when eligible=%s filesystem=%s', async (eligible, disk) => {
    const h = harness({}, eligible, disk);
    expect(await h.mgr.patch()).toBe(true);
    expect(h.surface.watch).not.toHaveBeenCalled();
    expect(h.surface.existsSync(path.join(h.root, 'note.md'))).toBe(false);
    expect(await h.mgr.dataAdapter!.read('note.md')).toBe('warm');
    expect(fs.existsSync(path.join(h.root, 'note.md'))).toBe(false);
  });

  it.each([
    [false, true], [true, false], [false, false],
  ])('keeps switches independent: write-back=%s Node patch=%s', async (localWriteBack, fsModulePatch) => {
    const h = harness({ localWriteBack, fsModulePatch });
    expect(await h.mgr.patch()).toBe(true);
    expect(h.surface.watch).toHaveBeenCalledTimes(localWriteBack ? 1 : 0);
    expect(h.surface.existsSync(path.join(h.root, 'note.md'))).toBe(fsModulePatch);
  });

  it('scans physical files, suppresses mirrored echoes, reflects raw writes and preserves edits', async () => {
    const h = harness();
    await h.mgr.patch();
    vi.useFakeTimers();
    h.events[0]('change', null);
    await vi.advanceTimersByTimeAsync(800);
    expect(h.remote.writeBinary).not.toHaveBeenCalled();
    expect(h.remote.readBinary).not.toHaveBeenCalled();
    await h.mgr.dataAdapter!.read('note.md');
    h.events[0]('change', 'note.md');
    await vi.advanceTimersByTimeAsync(800);
    expect(h.remote.writeBinary).not.toHaveBeenCalled();
    fs.writeFileSync(path.join(h.root, 'note.md'), 'user edit');
    fs.writeFileSync(path.join(h.root, 'new.md'), 'new note');
    fs.mkdirSync(path.join(h.root, '.custom'), { recursive: true });
    fs.writeFileSync(path.join(h.root, '.custom', 'app.json'), '{}');
    fs.writeFileSync(path.join(h.root, 'ignored.tmp'), 'temp');
    h.events[0]('change', null);
    await vi.advanceTimersByTimeAsync(400);
    expect(h.remote.writeBinary).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(400);
    expect(h.remote.writeBinary).toHaveBeenCalledTimes(2);
    expect(h.remote.writeBinary.mock.calls[0].slice(0, 2)).toEqual(['/remote/new.md', Buffer.from('new note')]);
    expect(h.vault.fileMap['new.md']).toBeInstanceOf(TFile);
    fs.rmSync(path.join(h.root, 'new.md'));
    h.events[0]('rename', 'new.md');
    await vi.advanceTimersByTimeAsync(400);
    expect(h.remote.remove).toHaveBeenCalledWith('/remote/new.md');
    h.mgr.restore();
    expect(fs.readFileSync(path.join(h.root, 'note.md'), 'utf8')).toBe('user edit');
    h.events[0]('change', 'note.md');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not materialise late reads into a restored or replacement lifetime', async () => {
    const h = harness();
    await h.mgr.patch();
    let finish!: (data: Buffer) => void;
    h.remote.readBinary.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const old = h.surface.promises.readFile(path.join(h.root, 'note.md')).catch(e => e.code);
    h.mgr.restore();
    await h.mgr.patch();
    finish(Buffer.from('late'));
    expect(await old).toBe('ENOENT');
    expect(fs.existsSync(path.join(h.root, 'note.md'))).toBe(false);
    h.mgr.restore();
  });

  it.each([{ fsCacheMB: 0 }, { fsCacheMaxFileMB: 0 }])('refuses oversized async reads before fetching: %j', async limits => {
    const h = harness(limits);
    await h.mgr.patch();
    await expect(h.surface.promises.readFile(path.join(h.root, 'note.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(h.remote.readBinary).not.toHaveBeenCalled();
    expect(() => h.surface.readFileSync(path.join(h.root, 'note.md'))).toThrow();
    expect(h.remote.readBinary).not.toHaveBeenCalled();
  });

  it('unwinds a failed core installation and can patch again', async () => {
    const h = harness();
    const getName = h.vault.getName;
    h.vault.getName = () => { throw new Error('core failure'); };
    expect(await h.mgr.patch()).toBe(false);
    expect(h.mgr.dataAdapter).toBeNull();
    expect(h.surface.watch).not.toHaveBeenCalled();
    h.vault.getName = getName;
    expect(await h.mgr.patch()).toBe(true);
  });

  it('degrades independently when watching or Node patch activation fails', async () => {
    const h = harness();
    h.surface.watch.mockImplementation(() => { throw new Error('watch unavailable'); });
    const original = h.surface.readFileSync;
    Object.defineProperty(h.surface, 'statSync', { value: h.surface.statSync, writable: false });
    expect(await h.mgr.patch()).toBe(true);
    expect(h.surface.readFileSync).toBe(original);
    expect(obsidian.recordedNotices().some(s => s.includes('local writes cannot be watched'))).toBe(true);
    expect(await h.mgr.dataAdapter!.read('note.md')).toBe('warm');
    h.mgr.restore();
    expect(fs.existsSync(path.join(h.root, 'note.md'))).toBe(false);
  });

  it('continues restoring after an unsubscribe failure', async () => {
    const h = harness();
    await h.mgr.patch();
    await h.mgr.dataAdapter!.read('note.md');
    h.unsubscribe.mockImplementation(() => { throw new Error('unsubscribe failure'); });
    h.mgr.restore();
    expect(h.mgr.isPatched()).toBe(false);
    expect(h.mgr.dataAdapter).toBeNull();
    expect(h.close).toHaveBeenCalled();
    expect(h.surface.existsSync(path.join(h.root, 'note.md'))).toBe(false);
  });

  it('keeps compatibility across transient client replacement and stops queued pushes on restore', async () => {
    const h = harness();
    await h.mgr.patch();
    const da = h.mgr.dataAdapter!;
    const replacement = { ...h.remote, writeBinary: vi.fn(async () => {}) };
    da.setReconnecting(true);
    da.swapClient(replacement as never);
    da.setReconnecting(false);
    expect(h.mgr.dataAdapter).toBe(da);
    expect(h.surface.watch).toHaveBeenCalledTimes(1);
    vi.useFakeTimers();
    let finish!: () => void;
    replacement.writeBinary.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    for (const name of ['a.md', 'b.md']) {
      fs.writeFileSync(path.join(h.root, name), name);
      h.events[0]('change', name);
    }
    await vi.advanceTimersByTimeAsync(800);
    expect(replacement.writeBinary).toHaveBeenCalledTimes(1);
    h.mgr.restore();
    finish();
    await vi.advanceTimersByTimeAsync(2000);
    expect(replacement.writeBinary).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('owns virtual visibility and physical materialisation across two lifetimes', async () => {
    const h = harness();
    const syncRead = h.surface.readFileSync;
    const promiseRead = h.surface.promises.readFile;
    h.mgr.restore();
    expect(await h.mgr.patch()).toBe(true);
    expect(h.surface.existsSync(path.join(h.root, 'note.md'))).toBe(true);
    expect(fs.existsSync(path.join(h.root, 'note.md'))).toBe(false);
    expect(h.remote.readBinary).not.toHaveBeenCalled();
    await h.mgr.dataAdapter!.read('note.md');
    fs.rmSync(path.join(h.root, 'note.md'));
    expect(h.surface.readFileSync(path.join(h.root, 'note.md'), 'utf8')).toBe('warm');
    expect(fs.readFileSync(path.join(h.root, 'note.md'), 'utf8')).toBe('warm');
    h.mgr.restore();
    h.mgr.restore();
    expect(h.surface.readFileSync).toBe(syncRead);
    expect(h.surface.promises.readFile).toBe(promiseRead);
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(h.root, 'note.md'))).toBe(false);
    expect(h.surface.existsSync(path.join(h.root, 'note.md'))).toBe(false);
    expect(await h.mgr.patch()).toBe(true);
    expect(await h.surface.promises.readFile(path.join(h.root, 'note.md'), 'utf8')).toBe('warm');
    h.mgr.restore();
    expect(h.close).toHaveBeenCalledTimes(2);
  });
});
