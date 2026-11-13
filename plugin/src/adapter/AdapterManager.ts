import type { App, PluginManifest } from 'obsidian';
import { FileSystemAdapter, Notice, TFile, TFolder } from 'obsidian';
import { VaultModelBuilder } from '../vault/VaultModelBuilder';
import { LocalOpRegistry } from './LocalOpRegistry';
import type { PluginSettings } from '../types';
import { ReadCache } from '../cache/ReadCache';
import { DirCache } from '../cache/DirCache';
import { SftpDataAdapter } from './SftpDataAdapter';
import { MaterializedCache } from './MaterializedCache';
import { LocalWriteWatcher, makeLocalWriteIgnore } from './LocalWriteWatcher';
import { FsModulePatcher } from './FsModulePatcher';
import { capturePhysicalFs, type PhysicalFs } from './PhysicalFs';
import { watchTree, listTreeFiles, physicalWatchTreeDeps } from '../util/watchTree';
import { DEFAULT_WALK_IGNORE_DIRS } from '../constants';
import { AdapterPatcher } from './AdapterPatcher';
import { ResourceBridge } from './ResourceBridge';
import { WriteConflictModal } from '../ui/WriteConflictModal';
import { ThreeWayMergeModal } from '../ui/ThreeWayMergeModal';
import { AncestorTracker } from '../conflict/AncestorTracker';
import { ConflictResolver } from '../conflict/ConflictResolver';
import { OfflineQueue } from '../offline/OfflineQueue';
import { QueueReplayer } from '../offline/QueueReplayer';
import { PendingEditsBar } from '../ui/PendingEditsBar';
import { PendingEditsModal } from '../ui/PendingEditsModal';
import type { ConnectionManager } from '../ConnectionManager';
import { ConnectionManager as CM } from '../ConnectionManager';
import type { FsChangeListener } from '../vault/FsChangeListener';
import type { TransferTracker } from '../util/TransferTracker';
import { PathMapper } from '../path/PathMapper';
import { logger } from '../util/logger';
import { errorMessage } from '../util/errorMessage';
import * as path from 'path';

/**
 * The set of FileSystemAdapter methods that get monkey-patched onto
 * `app.vault.adapter` when the plugin is connected. Kept here so
 * the list and the patching logic live in the same file.
 */
export const PATCHED_METHODS = [
  // read-side
  'getName', 'exists', 'stat', 'list', 'read', 'readBinary',
  // write-side
  'write', 'writeBinary', 'append', 'appendBinary', 'process',
  // fs ops
  'mkdir', 'remove', 'rmdir', 'rename', 'copy',
  // trash
  'trashSystem', 'trashLocal',
  // resources (binary URL for <img> / <iframe> / <audio>)
  'getResourcePath',
  // basePath surface — patched so plugins that join paths against
  // it (Templater's tp.file.path, Kanban clipboard paste, Importer,
  // Copilot — see docs/en/user-guide/plugin-compatibility.md "basePath compat
  // survey") get the shadow-vault local root explicitly. The natural
  // FileSystemAdapter getter already returns this value, but routing
  // through the replacement makes the contract explicit and gives
  // tests a single hook to assert on. #170, follow-up to #133.
  'basePath', 'getBasePath',
  // Path surface — the stock FileSystemAdapter versions join onto the
  // local base and so hand out a path to nothing, because the note tree
  // is virtual (#429). The replacements materialise the file first,
  // within the cache budget, so what they return actually resolves.
  'getFullPath', 'getFilePath',
] as const;

/**
 * Manages the lifetime of the monkey-patched `app.vault.adapter`,
 * its bounded disk cache, local write-back, Node fs compatibility,
 * the ResourceBridge, and the OfflineQueue. Extracted from main.ts
 * so that adapter-lifecycle concerns are cohesive and independently
 * testable (issue #197).
 *
 * Call {@link patch} after a successful SSH connect; call
 * {@link restore} on disconnect or plugin unload.
 */
export class AdapterManager {
  private patcher: AdapterPatcher<Record<string, unknown>> | null = null;
  private _dataAdapter: SftpDataAdapter | null = null;
  private readCache: ReadCache | null = null;
  private dirCache: DirCache | null = null;
  private ancestorTracker: AncestorTracker | null = null;
  private offlineQueue: OfflineQueue | null = null;
  private resourceBridge: ResourceBridge | null = null;
  private materializedCache: MaterializedCache | null = null;
  private localWriteWatcher: LocalWriteWatcher | null = null;
  private fsModulePatcher: FsModulePatcher | null = null;
  private lifetime: { active: boolean } | null = null;

  constructor(
    private readonly app: App,
    private readonly manifest: PluginManifest,
    private readonly conn: ConnectionManager,
    private readonly fsChangeListener: FsChangeListener,
    private readonly pendingEditsBar: PendingEditsBar,
    private readonly getSettings: () => PluginSettings,
    private readonly transferTracker: TransferTracker | null = null,
  ) {}

  get dataAdapter(): SftpDataAdapter | null {
    return this._dataAdapter;
  }

  isPatched(): boolean {
    return this.patcher?.isPatched() ?? false;
  }

  /**
   * Build the SftpDataAdapter, start the ResourceBridge, monkey-patch
   * `app.vault.adapter`, and subscribe to fs.watch when the active
   * transport is RPC.
   *
   * Returns true on success, false on failure. Silent — the caller
   * decides what notice (if any) to surface.
   */
  async patch(): Promise<boolean> {
    if (this.lifetime) return this.isPatched();
    const lifetime = { active: true };
    this.lifetime = lifetime;
    try {
      const installed = await this.install(lifetime);
      if (!installed && this.lifetime === lifetime) this.restore();
      return installed;
    } catch (e) {
      logger.error(`Adapter patch failed: ${errorMessage(e)}`);
      if (this.lifetime === lifetime) this.restore();
      return false;
    }
  }

  private async install(lifetime: { active: boolean }): Promise<boolean> {
    if (!this.conn.activeRemoteBasePath) {
      logger.warn('AdapterManager.patch: no active remote base path');
      return false;
    }
    if (this.patcher?.isPatched()) {
      logger.info('AdapterManager.patch: adapter already patched');
      return true;
    }
    const targetAdapter = this.app.vault.adapter as unknown as Record<string, unknown>;
    // Capture the shadow vault's local root *before* patching. The
    // running window is the shadow window, so its FileSystemAdapter
    // already points at `~/.obsidian-remote/vaults/<P-id>/`; we feed
    // that value back into SftpDataAdapter so the patched basePath /
    // getBasePath surface returns it explicitly. Falls back to '' if
    // the host adapter isn't a FileSystemAdapter (mobile / unusual
    // builds) — plugins that read basePath in those environments
    // already had no useful answer. #170.
    const shadowBasePath = this.app.vault.adapter instanceof FileSystemAdapter
      ? this.app.vault.adapter.getBasePath()
      : '';
    const physical = capturePhysicalFs();
    const settings = { ...this.getSettings() };
    const configDir = this.app.vault.configDir;
    const profile = this.conn.activeProfile;
    const eligible = Boolean(shadowBasePath && profile
      && settings.autoConnectProfileId === profile.id);
    const ignoreDirs = [...(profile?.walkIgnoreDirs ?? DEFAULT_WALK_IGNORE_DIRS)];
    this.readCache = new ReadCache();
    this.dirCache = new DirCache();
    // Pick the transport that matches the active session: when an
    // RPC tunnel is up, route everything through the daemon; otherwise
    // fall back to the direct-SFTP wrapper. The adapter itself is
    // unaware of the choice — both clients implement RemoteFsClient.
    const fsClient = this.conn.buildFsClient();
    const transportLabel = this.conn.rpcConnection ? 'RPC' : 'SFTP';
    // Per-client path remapping: client-private files like
    // .obsidian/workspace.json get redirected into a per-client subtree
    // on the remote so two machines on the same vault don't trample
    // each other's UI state. Phase 4-J0.
    const clientId = CM.resolveClientId(this.getSettings());
    // Pass `app.vault.configDir` so PathMapper builds its private-subtree
    // routing against the user's actual config directory (defaults to
    // `.obsidian` but is configurable in Obsidian's appearance settings).
    const mapper = new PathMapper(clientId, this.app.vault.configDir);
    logger.info(`PathMapper: clientId="${clientId}"`);

    // Spin up the localhost binary bridge so getResourcePath has
    // somewhere to send Obsidian. The bridge is best-effort: if it
    // fails to bind we still patch and just lose image rendering.
    //
    // When the active session is RPC AND the daemon advertises
    // `fs.thumbnail`, also wire the thumbnail fetcher — image-extension
    // requests get served from the daemon's resize path (small, cached)
    // instead of pulling the full original on every <img>.
    const bridge = new ResourceBridge();
    this.resourceBridge = bridge;
    const fetchThumbnail = this.makeThumbnailFetcherIfSupported();
    const fetchBinaryRange = this.makeBinaryRangeFetcherIfSupported();
    try {
      await bridge.start(
        p => this.fetchBinaryForBridge(p),
        fetchThumbnail ?? undefined,
        fetchBinaryRange ?? undefined,
      );
      if (!lifetime.active) {
        await bridge.stop();
        return false;
      }
      if (fetchThumbnail) {
        logger.info('ResourceBridge: thumbnail fast path enabled (daemon supports fs.thumbnail)');
      }
      if (fetchBinaryRange) {
        logger.info('ResourceBridge: range fast path enabled (daemon supports fs.readBinaryRange)');
      }
    } catch (e) {
      logger.warn(`ResourceBridge: start failed: ${errorMessage(e)}`);
      await bridge.stop().catch(() => {});
      if (!lifetime.active) return false;
      this.resourceBridge = null;
    }

    // The Go daemon already knows the absolute vault root via its
    // `--vault-root` flag, so RPC clients must send paths RELATIVE to
    // that root (empty string for the root itself). Sending the same
    // `work/VaultDev` prefix the SFTP path needs would double up:
    // daemon-side `Resolve(absRoot, "work/VaultDev")` becomes
    // `<absRoot>/work/VaultDev`, missing the real vault entirely
    // (or — when a stale doubled mirror exists — quietly listing it).
    // The SFTP transport has no such root-knowing server; it does need
    // the prefix to anchor calls at the vault.
    const adapterRemoteBase = this.conn.rpcConnection ? '' : this.conn.activeRemoteBasePath;
    // Per-session ancestor snapshot store. Powers the 3-way merge UI;
    // cleared on disconnect with the rest of the patched-adapter state.
    this.ancestorTracker = new AncestorTracker();
    // Persistent offline-write queue. Survives Electron restarts and
    // adapter restores so an in-flight disconnect doesn't drop user
    // edits. Lazily-opened the first time the adapter is patched;
    // reused on subsequent patches so the queue isn't re-replayed.
    if (!this.offlineQueue) {
      try {
        const openedQueue = await this.openOfflineQueue();
        if (!lifetime.active) return false;
        this.offlineQueue = openedQueue;
        const stats = this.offlineQueue.stats();
        if (stats.entries > 0) {
          logger.info(
            `OfflineQueue: opened with ${stats.entries} pending entries (${stats.bytes} bytes) ` +
            'from a previous session — the QueueReplayer will drain them on connect',
          );
        }
        // Wire the status-bar indicator to this queue. Polls every
        // 2 s; cheap (Map.size) and the user expects an at-a-glance
        // count rather than per-event live updates.
        const queue = this.offlineQueue;
        this.pendingEditsBar.startPolling(() => queue.pending().length);
      } catch (e) {
        if (!lifetime.active) return false;
        logger.warn(`OfflineQueue: open failed (${errorMessage(e)}); offline writes will throw`);
        this.offlineQueue = null;
      }
    }
    if (!lifetime.active) return false;
    const conflictResolver = new ConflictResolver(
      fsClient,
      this.readCache,
      this.ancestorTracker,
      (vaultPath, panes) => new ThreeWayMergeModal(this.app, { path: vaultPath, ...panes }).prompt(),
      (vaultPath) => new WriteConflictModal(this.app, vaultPath).prompt(),
    );
    this._dataAdapter = new SftpDataAdapter(
      fsClient,
      adapterRemoteBase,
      this.readCache,
      this.dirCache,
      this.app.vault.getName(),
      mapper,
      this.resourceBridge,
      conflictResolver,
      this.ancestorTracker,
      this.offlineQueue,
      shadowBasePath,
      this.transferTracker,
      physical,
    );
    this.patcher = new AdapterPatcher(targetAdapter, this._dataAdapter);
    try {
      this.patcher.patch(PATCHED_METHODS);
      logger.info(`Adapter patched via ${transportLabel}: [${PATCHED_METHODS.join(', ')}]`);
    } catch (e) {
      logger.error(`Adapter patch failed: ${errorMessage(e)}`);
      throw e;
    }

    // Writer self-reflect (#341) — transport-independent. The adapter
    // mirrors every applied write/rename/remove/mkdir into the
    // writer's own vault.fileMap + trigger bus *immediately* and
    // records the op in a LocalOpRegistry. VaultModelBuilder is
    // stateless (only mutates the live Vault) and the adapter object
    // outlives a reconnect's swapClient, so wiring once here holds for
    // the whole patched lifetime — no per-swap re-policy needed.
    // Bounded on-demand disk cache behind getFullPath / getFilePath and
    // the read-through in read/readBinary. Zero budget switches the
    // whole thing off; nothing is ever pre-fetched either way.
    if (eligible) this.materializedCache = new MaterializedCache({
      absOf: (rel) => path.join(shadowBasePath, rel),
      writeFile: (abs, data) => {
        physical.mkdirSync(path.dirname(abs), { recursive: true });
        physical.writeFileSync(abs, data);
        const s = physical.statSync(abs, { throwIfNoEntry: false });
        return s ? { size: s.size, mtimeMs: s.mtimeMs } : null;
      },
      statFile: (abs) => {
        const s = physical.statSync(abs, { throwIfNoEntry: false });
        return s?.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : null;
      },
      deleteFile: (abs) => physical.rmSync(abs, { force: true }),
      budgetBytes: shadowBasePath
        ? Math.max(0, settings.fsCacheMB ?? 128) * 1024 * 1024
        : 0,
      maxFileBytes: Math.max(0, settings.fsCacheMaxFileMB ?? 8) * 1024 * 1024,
    });
    this._dataAdapter.setMaterializedCache(this.materializedCache);

    const localOpRegistry = new LocalOpRegistry();
    this._dataAdapter.setWriterReflector(
      new VaultModelBuilder(this.app.vault, { TFile, TFolder }),
    );
    this._dataAdapter.setLocalOpRegistry(localOpRegistry);
    if (eligible) {
      this.activateCompatibility(this._dataAdapter, this.materializedCache!,
        shadowBasePath, configDir, settings, ignoreDirs, physical, lifetime);
    }

    // The live-update subscription is only meaningful on RPC (SFTP has
    // no notification channel). On RPC the daemon also echoes our own
    // writes back; the shared registry lets FsChangeListener drop that
    // echo so it doesn't double-fire what the reflector already did.
    // Multi-client changes never pass through `record`, so other
    // clients' echoes still apply.
    if (this.conn.rpcConnection) {
      void this.fsChangeListener.subscribe({
        rpcConnection: this.conn.rpcConnection,
        dataAdapter: this._dataAdapter,
        pathMapper: mapper,
        localOpRegistry,
      });
    }

    return true;
  }

  private activateCompatibility(
    da: SftpDataAdapter, cache: MaterializedCache, root: string,
    configDir: string, settings: PluginSettings, ignoreDirs: readonly string[],
    physical: PhysicalFs, lifetime: { active: boolean },
  ): void {
    const abs = (rel: string): string => path.join(root, rel);
    if (settings.localWriteBack !== false) {
      const ignore = makeLocalWriteIgnore(configDir, ignoreDirs);
      const watcher = new LocalWriteWatcher({
        watch: (onChange) => watchTree(root, onChange, ignore, physicalWatchTreeDeps(physical)),
        scan: () => listTreeFiles(root, ignore, physical),
        stat: (rel) => {
          const s = physical.statSync(abs(rel), { throwIfNoEntry: false });
          return s?.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : null;
        },
        read: (rel) => {
          try { return physical.readFileSync(abs(rel)); } catch { return null; }
        },
        push: async (rel, data) => {
          // Retain text conflict handling and immediate writer reflection.
          if (rel.toLowerCase().endsWith('.md')) await da.write(rel, data.toString('utf-8'));
          else await da.writeBinary(rel,
            data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
        },
        removeRemote: (rel) => da.remove(rel), ignore,
        isMirroredCopy: (rel, stat) => cache.isMirroredCopy(rel, stat),
        maxBytes: Math.max(1, settings.localWriteBackMaxMB ?? 32) * 1024 * 1024,
        debounceMs: 400,
        setTimer: (cb, ms) => window.setTimeout(cb, ms),
        clearTimer: (handle) => window.clearTimeout(handle as number),
        onError: (_rel, message) => new Notice(`Remote SSH: ${message}`),
      });
      try {
        watcher.start();
        this.localWriteWatcher = watcher;
      } catch (e) {
        watcher.stop();
        logger.warn(`Local write watcher unavailable: ${errorMessage(e)}`);
        new Notice(`Remote SSH: local writes cannot be watched — ${errorMessage(e)}`);
      }
    }
    if (settings.fsModulePatch !== false) {
      let patcher: FsModulePatcher | null = null;
      try {
        const req = (window as unknown as { require?: (m: string) => unknown }).require;
        const fsModule = typeof req === 'function' ? req('fs') : null;
        if (!fsModule) throw new Error('window.require fs unavailable');
        const asEntry = (f: unknown) => {
          if (f instanceof TFile) return { isDir: false, size: f.stat.size, mtimeMs: f.stat.mtime };
          if (f instanceof TFolder) return { isDir: true, size: 0, mtimeMs: 0 };
          return null;
        };
        patcher = new FsModulePatcher({
          fsModule: fsModule as Record<string, unknown>, root, configDir,
          tree: {
            children: (rel) => {
              const folder = rel === '' ? this.app.vault.getRoot() : this.app.vault.getAbstractFileByPath(rel);
              if (!(folder instanceof TFolder)) return null;
              return folder.children.flatMap(f => {
                const entry = asEntry(f);
                return entry ? [{ name: f.name, entry }] : [];
              });
            },
            entry: rel => asEntry(this.app.vault.getAbstractFileByPath(rel)),
          },
          materialize: rel => lifetime.active && da.materializeSync(rel),
          materializeAsync: async (rel) => {
            const f = this.app.vault.getAbstractFileByPath(rel);
            if (!lifetime.active || !(f instanceof TFile) || cache.disabled() || cache.tooBig(f.stat.size)) return false;
            await da.readBinary(rel);
            return lifetime.active && cache.has(rel);
          },
        });
        if (patcher.patch()) this.fsModulePatcher = patcher;
        else patcher.restore();
      } catch (e) {
        patcher?.restore();
        logger.warn(`Node fs compatibility unavailable: ${errorMessage(e)}`);
      }
    }
  }

  /**
   * Stop compatibility, drop the watch subscription, restore the original adapter, and
   * tear down the ResourceBridge. Idempotent.
   */
  restore(): void {
    if (this.lifetime) this.lifetime.active = false;
    this.lifetime = null;
    const clean = (label: string, action: () => void): void => {
      try { action(); } catch (e) { logger.error(`${label}: ${errorMessage(e)}`); }
    };
    clean('Local write watcher stop', () => this.localWriteWatcher?.stop());
    this.localWriteWatcher = null;
    clean('Node fs restore', () => this.fsModulePatcher?.restore());
    this.fsModulePatcher = null;
    clean('Detach materialised cache', () => this._dataAdapter?.setMaterializedCache(null));
    // Drop the watch subscription before tearing the adapter down so
    // any in-flight fs.changed callbacks find a still-valid adapter
    // (or, if the handler races, a null `dataAdapter` which it tolerates).
    clean('Remote watch unsubscribe', () => this.fsChangeListener.unsubscribe(this.conn.rpcConnection));
    const wasPatched = this.patcher?.isPatched() ?? false;
    if (wasPatched) {
      try {
        this.patcher!.restore();
        logger.info('Adapter restored');
      } catch (e) {
        logger.error(`Adapter restore failed: ${errorMessage(e)}`);
      }
    }
    this.patcher = null;
    this._dataAdapter = null;
    this.readCache = null;
    this.dirCache = null;
    // The disk cache is per-session: drop every untouched copy we put
    // on the shadow disk so a disconnect leaves behind only what the
    // user (or a plugin) actually created there. A copy somebody edited
    // is left alone — the watcher owns it now.
    clean('Materialised cache clear', () => this.materializedCache?.clear());
    this.materializedCache = null;
    clean('Ancestor clear', () => this.ancestorTracker?.clear());
    this.ancestorTracker = null;
    clean('Transfer tracker clear', () => this.transferTracker?.clear());
    // Bridge tears down asynchronously; we don't await here because
    // restore() must remain sync for the connection-close hook.
    void this.stopResourceBridge();
    // The legacy reconcileVaultRoot walk used to fire here to put
    // File Explorer back to the local view after un-patching, but
    // shadow vaults are torn down by closing their window — there's
    // no in-place "switch back" UX to support anymore.
  }

  /**
   * Drive the offline write queue against the live adapter. Called
   * on every connect (initial and post-reconnect). Idempotent: if
   * the queue is empty the run is a no-op; if entries error mid-
   * drain the rest stay queued for the next reconnect.
   */
  async replayOfflineQueue(label: 'after-connect' | 'after-reconnect'): Promise<void> {
    if (!this.offlineQueue || !this._dataAdapter) return;
    const pendingBefore = this.offlineQueue.pending().length;
    if (pendingBefore === 0) return;
    logger.info(`replayOfflineQueue(${label}): ${pendingBefore} pending entries`);
    try {
      const replayer = new QueueReplayer(this.offlineQueue, this._dataAdapter);
      const report = await replayer.run();
      const stillPending = this.offlineQueue.pending().length;
      const summary =
        `replayOfflineQueue(${label}) done: drained=${report.drained}, ` +
        `conflicts=${report.conflicts}, errors=${report.errors.length}, ` +
        `remaining=${stillPending}`;
      logger.info(summary);
      if (report.drained > 0) {
        new Notice(
          `Remote SSH: replayed ${report.drained} offline edit` +
          `${report.drained === 1 ? '' : 's'}` +
          (stillPending > 0 ? ` (${stillPending} pending)` : ''),
        );
      }
      if (report.errors.length > 0) {
        new Notice(
          `Remote SSH: ${report.errors.length} offline edit` +
          `${report.errors.length === 1 ? '' : 's'} failed to replay; will retry on next connect`,
        );
      }
    } catch (e) {
      logger.warn(`replayOfflineQueue(${label}) crashed: ${errorMessage(e)}`);
    }
  }

  /**
   * Show the pending-edits listing modal. Discarding clears the
   * queue (destructive — there's no undo). The listing is a snapshot
   * taken at modal-open time; if the queue mutates while the modal
   * is open the user just sees the next snapshot on their next click.
   */
  async showPendingEditsModal(): Promise<void> {
    if (!this.offlineQueue) return;
    const entries = this.offlineQueue.pending();
    if (entries.length === 0) return;
    const decision = await new PendingEditsModal(this.app, entries).prompt();
    if (decision.decision === 'discard-all') {
      const dropped = entries.length;
      try {
        await this.offlineQueue.clear();
        new Notice(`Remote SSH: discarded ${dropped} pending edit${dropped === 1 ? '' : 's'}`);
      } catch (e) {
        logger.warn(`PendingEditsModal: queue.clear() failed: ${errorMessage(e)}`);
        new Notice('Remote SSH: failed to clear the offline queue (see console.log)');
      }
    }
  }

  /**
   * Open the persistent offline-write queue under
   * `<vault>/.obsidian/plugins/<id>/queue/`. The dir lives next to
   * the plugin's other on-disk state (data.json, console.log, the
   * thumbnails cache the daemon writes elsewhere) so a vault move
   * carries the pending writes with it.
   */
  private async openOfflineQueue(): Promise<OfflineQueue> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error('vault is not FileSystemAdapter-backed');
    }
    const dir = path.join(
      adapter.getBasePath(),
      this.app.vault.configDir,
      'plugins',
      this.manifest.id,
      'queue',
    );
    return await OfflineQueue.open(dir);
  }

  /**
   * Bridge → adapter glue: fetch a binary asset through the patched
   * adapter so the bridge benefits from caching and PathMapper
   * translation. Returns `Uint8Array` as the bridge expects.
   */
  private async fetchBinaryForBridge(vaultPath: string): Promise<Uint8Array> {
    if (!this._dataAdapter) {
      throw new Error('adapter is not patched');
    }
    return this._dataAdapter.fetchBinaryForBridge(vaultPath);
  }

  /**
   * Build the bridge's thumbnail fetcher when the active session can
   * support it. Returns `null` for SFTP transports or for daemons
   * that don't advertise `fs.thumbnail` — the bridge then transparently
   * falls back to the full-binary path on `<img>` requests.
   */
  private makeThumbnailFetcherIfSupported(): null | ((vaultPath: string, maxDim: number) => Promise<{ bytes: Uint8Array; format: 'jpeg' | 'png' }>) {
    const conn = this.conn.rpcConnection;
    if (!conn) return null;
    if (!conn.info.capabilities.includes('fs.thumbnail')) return null;
    return async (vaultPath, maxDim) => {
      const result = await conn.rpc.call('fs.thumbnail', { path: vaultPath, maxDim });
      const buf = Buffer.from(result.contentBase64, 'base64');
      return {
        bytes:  new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
        format: result.format,
      };
    };
  }

  /**
   * Build the bridge's range fetcher when the active session can
   * support it (#134). Returns `null` for SFTP transports or for
   * daemons that don't advertise `fs.readBinaryRange` — the bridge
   * then transparently falls back to the full-binary path on every
   * `Range:` request, which still works but allocates the whole file
   * into memory just to slice.
   */
  private makeBinaryRangeFetcherIfSupported(): null | ((vaultPath: string, offset: number, length: number, expectedMtime?: number) => Promise<{ bytes: Uint8Array; mtime: number; totalSize: number }>) {
    const conn = this.conn.rpcConnection;
    if (!conn) return null;
    if (!conn.info.capabilities.includes('fs.readBinaryRange')) return null;
    return async (vaultPath, offset, length, expectedMtime) => {
      // Daemon's ReadBinaryRangeParams treats `expectedMtime` as
      // optional — only include it when the bridge actually has a
      // cached generation to pin against. The daemon rejects with
      // PreconditionFailed (-32020) when the remote mtime no longer
      // matches; ResourceBridge catches that and re-issues with
      // `expectedMtime: undefined`. #171.
      const result = await conn.rpc.call('fs.readBinaryRange', {
        path: vaultPath,
        offset,
        length,
        ...(expectedMtime !== undefined ? { expectedMtime } : {}),
      });
      const buf = Buffer.from(result.contentBase64, 'base64');
      return {
        bytes:     new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
        mtime:     result.mtime,
        totalSize: result.size,
      };
    };
  }

  /** Stop the resource bridge if running. Idempotent. */
  private async stopResourceBridge(): Promise<void> {
    const bridge = this.resourceBridge;
    if (!bridge) return;
    this.resourceBridge = null;
    try {
      await bridge.stop();
    } catch (e) {
      logger.warn(`ResourceBridge: stop failed: ${errorMessage(e)}`);
    }
  }
}
