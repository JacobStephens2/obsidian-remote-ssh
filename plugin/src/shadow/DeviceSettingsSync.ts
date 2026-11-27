import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEVICE_SETTINGS_FILES } from '../path/PathMapper';
import { errorMessage } from '../util/errorMessage';
import { logger } from '../util/logger';

type SettingFile = typeof DEVICE_SETTINGS_FILES[number];

interface SettingsLocation {
  localConfigDir: string;
  remoteConfigDir: string;
}

export interface DeviceSettingsReader {
  readDeviceSetting(path: string, signal: AbortSignal): Promise<string | null>;
}

interface DeviceSettingsRemote extends DeviceSettingsReader {
  writeDeviceSetting(path: string, content: string, signal: AbortSignal): Promise<string>;
}

interface SettingsDiagnostic {
  operation: 'pull' | 'send';
  files: readonly SettingFile[];
}

interface SettingsSyncOptions extends SettingsLocation {
  remote: DeviceSettingsRemote;
  watch?: (onChange: (filename: string | null) => void) => { close(): void };
  diagnose?: (diagnostic: SettingsDiagnostic) => void;
}

/** Stage settings with read-only remote access before the shadow window opens. */
export function stageDeviceSettings(
  location: SettingsLocation,
  remote: DeviceSettingsReader,
  signal = new AbortController().signal,
): Promise<{ pulled: SettingFile[]; failed: SettingFile[] }> {
  return pullSettings(location, remote, signal);
}

async function pullSettings(
  location: SettingsLocation,
  remote: DeviceSettingsReader,
  signal: AbortSignal,
  installed?: Map<SettingFile, string>,
): Promise<{ pulled: SettingFile[]; failed: SettingFile[] }> {
  const pulled: SettingFile[] = [];
  const failed: SettingFile[] = [];
  for (const basename of DEVICE_SETTINGS_FILES) {
    if (signal.aborted) break;
    try {
      const content = await remote.readDeviceSetting(`${location.remoteConfigDir}/${basename}`, signal);
      if (signal.aborted) break;
      if (content === null) continue;
      JSON.parse(content);
      fs.mkdirSync(location.localConfigDir, { recursive: true });
      replaceSetting(path.join(location.localConfigDir, basename), content);
      installed?.set(basename, content);
      pulled.push(basename);
    } catch (e) {
      if (signal.aborted) break;
      logger.warn(`Device settings pull: ${basename} (${errorMessage(e)})`);
      failed.push(basename);
    }
  }
  return { pulled, failed };
}

function readLocal(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return null;
    throw e;
  }
}

/** The local read and conditional rename share one synchronous filesystem turn. */
function replaceSetting(file: string, content: string, expected?: string): void {
  const previous = fs.lstatSync(file, { throwIfNoEntry: false });
  if (previous && !previous.isFile()) throw new Error('settings destination is not a regular file');
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', previous?.mode ?? 0o600);
  try {
    try {
      fs.writeFileSync(fd, content, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
    if (expected === undefined || readLocal(file) === expected) fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** Owns the connected shadow window's settings and their remote confirmations. */
export class DeviceSettingsSync {
  private controller: AbortController | null = new AbortController();
  private stopped = false;
  private watcher: { close(): void } | null = null;
  private timer: number | null = null;
  private flushing = false;
  private readonly confirmed = new Map<SettingFile, string>();
  private readonly dirty = new Set<SettingFile>();
  private readonly failed = new Set<SettingFile>();

  constructor(private readonly options: SettingsSyncOptions) {}

  async pull(): Promise<void> {
    const signal = this.controller?.signal;
    if (!signal) return;
    // Startup can continue as soon as the transport is lost, even if an
    // issued read takes longer to settle. The shared pull checks the signal
    // before writing to disk or issuing another read.
    let interrupt: () => void = () => {};
    const interrupted = new Promise<void>(resolve => { interrupt = resolve; });
    signal.addEventListener('abort', interrupt, { once: true });
    const install = async () => {
      const result = await pullSettings(this.options, this.options.remote, signal, this.confirmed);
      if (!signal.aborted) this.report('pull', result.failed);
    };
    try {
      await Promise.race([interrupted, install()]);
    } finally {
      signal.removeEventListener('abort', interrupt);
    }
  }

  startWatching(): void {
    if (this.stopped || this.watcher) return;
    try {
      const onChange = (filename: string | null) => this.onChange(filename);
      this.watcher = this.options.watch?.(onChange) ?? fs.watch(
        this.options.localConfigDir, { persistent: false },
        (_event, filename) => onChange(filename ? String(filename) : null),
      );
    } catch (e) {
      logger.warn(`Device settings watch: ${errorMessage(e)}`);
      return;
    }
    // Only installed settings have a baseline. Check for saves between
    // the pull and watcher startup without uploading older local copies.
    for (const basename of this.confirmed.keys()) this.dirty.add(basename);
    this.schedule();
  }

  pause(): void {
    this.controller?.abort();
    this.controller = null;
    this.clearTimer();
  }

  resume(): void {
    if (this.stopped || this.controller) return;
    this.controller = new AbortController();
    for (const basename of this.failed) this.dirty.add(basename);
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    this.pause();
    try { this.watcher?.close(); } catch { /* best effort */ }
    this.watcher = null;
    this.dirty.clear();
    this.failed.clear();
  }

  private onChange(filename: string | null): void {
    if (this.stopped) return;
    const leaf = filename?.replace(/^.*[\\/]/, '');
    if (filename === null) {
      for (const basename of DEVICE_SETTINGS_FILES) this.dirty.add(basename);
    } else {
      const basename = DEVICE_SETTINGS_FILES.find(file => file === leaf);
      if (!basename) return;
      this.dirty.add(basename);
    }
    this.clearTimer();
    this.schedule();
  }

  private clearTimer(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (!this.watcher || !this.controller || this.timer !== null || !this.dirty.size) return;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, 1500);
  }

  private async flush(): Promise<void> {
    const signal = this.controller?.signal;
    if (!signal || this.flushing) return;
    this.flushing = true;
    const candidates = [...this.dirty];
    this.dirty.clear();
    const failed: SettingFile[] = [];
    try {
      for (const basename of candidates) {
        if (signal.aborted) {
          if (!this.stopped) this.dirty.add(basename);
          continue;
        }
        // An event since this batch started has its own debounce window.
        if (this.dirty.has(basename)) continue;
        this.failed.delete(basename);
        try {
          await this.send(basename, signal);
        } catch (e) {
          if (signal.aborted) {
            if (!this.stopped) {
              // The disconnected write could have landed on the remote.
              this.confirmed.delete(basename);
              this.dirty.add(basename);
            }
            continue;
          }
          logger.warn(`Device settings send: ${basename} (${errorMessage(e)})`);
          this.failed.add(basename);
          failed.push(basename);
        }
      }
      if (!signal.aborted) this.report('send', failed);
    } finally {
      this.flushing = false;
      this.schedule();
    }
  }

  private async send(basename: SettingFile, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const local = path.join(this.options.localConfigDir, basename);
    const snapshot = readLocal(local);
    if (snapshot === null || snapshot === this.confirmed.get(basename)) return;
    JSON.parse(snapshot);
    const remote = `${this.options.remoteConfigDir}/${basename}`;
    let sent = snapshot;
    try {
      const committed = await this.options.remote.writeDeviceSetting(remote, snapshot, signal);
      signal.throwIfAborted();
      this.confirmed.set(basename, committed);
      if (committed !== snapshot) replaceSetting(local, committed, snapshot);
      sent = committed;
    } finally {
      if (!signal.aborted) {
        // A coalesced event can hide a newer save even when this send failed.
        const current = readLocal(local);
        if (current !== null && current !== sent) this.dirty.add(basename);
      }
    }
  }

  private report(operation: SettingsDiagnostic['operation'], files: SettingFile[]): void {
    if (files.length) this.options.diagnose?.({ operation, files });
  }
}
