import type { ListedFiles } from 'obsidian';
import { logger } from '../util/logger';
import type { RemoteEntry } from './VaultModelBuilder';
import type { WalkParams, WalkResult, ServerInfo } from '../proto/types';
import { errorMessage } from "../util/errorMessage";

/**
 * The listing operation BulkWalker needs for its fallback path. Vault
 * population binds it to the data adapter for the transport generation.
 */
export interface AdapterListSlice {
  list(normalizedPath: string, signal?: AbortSignal): Promise<ListedFiles>;
}

/**
 * The slice of an established RPC connection BulkWalker needs to
 * decide whether the fast path is available and to drive it.
 */
export interface RpcConnectionSlice {
  rpc: { call(method: 'fs.walk', params: WalkParams): Promise<WalkResult> };
  info: Pick<ServerInfo, 'capabilities'>;
}

export interface BulkWalkerDeps {
  adapter: AdapterListSlice;
  /**
   * When set AND its `info.capabilities` advertises `fs.walk`, the
   * walker prefers a single RPC over the per-folder list loop. SFTP
   * sessions and pre-walk daemons leave this undefined.
   */
  rpcConnection?: RpcConnectionSlice;
  signal?: AbortSignal;
  /**
   * Cap for the fast path's MaxEntries. Defaults to the daemon's own
   * default (50_000). Tests pass small values to exercise the
   * pagination without needing a real big vault.
   */
  maxEntries?: number;
  /**
   * Directory basenames to prune from the walk (e.g. `node_modules`,
   * `.git`). Passed straight through to `fs.walk`'s `ignore` so the
   * daemon never descends/transfers them. Only the fast path honours
   * this; the per-folder fallback (SFTP / no daemon) does not yet.
   */
  ignoreDirs?: string[];
}

/** Outcome telemetry from a single `walk()` call. */
export interface BulkWalkResult {
  entries: RemoteEntry[];
  /**
   * `'rpc-walk'` when the daemon's `fs.walk` produced the result;
   * `'fallback-list'` when we used the BFS-via-`adapter.list` path
   * (no RPC, daemon doesn't advertise the capability, or the RPC
   * walk threw). A truncated page is NO LONGER a fallback trigger —
   * the fast path now paginates and drains every page.
   */
  source: 'rpc-walk' | 'fallback-list';
  /**
   * `true` only when the returned set is still INCOMPLETE — i.e. the
   * fast path hit the defensive page guard on a pathologically huge
   * tree (we return the large partial set rather than nothing).
   * Normal completion (all pages drained) is `false`.
   */
  truncated: boolean;
  /** Wall-clock for the walk itself, milliseconds. */
  walkMs: number;
  /** rpc-walk only: number of `fs.walk` pages drained (1 for small trees). */
  pages: number;
  /** When `fallback-list` because of a fast-path error, the error message; else null. */
  fastPathError: string | null;
  /** Fallback folders whose listing failed. Successful siblings are still returned. */
  failedListings: Array<{ path: string; message: string }>;
  /**
   * Count of entries dropped by the hidden-file (dot-prefix) filter before
   * `entries` was returned. Lets the caller tell a genuinely empty remote
   * apart from "everything walked was hidden" (e.g. all content nested under
   * a dot-dir) instead of firing a misleading "0 files — check remotePath".
   */
  hiddenCount: number;
}

/**
 * Walks a remote vault tree into a flat `RemoteEntry[]` ready for
 * `VaultModelBuilder.build`. Prefers the daemon's `fs.walk` (one RPC,
 * stat included) but transparently falls back to the legacy
 * BFS-via-`adapter.list` traversal when the fast path is unavailable
 * or unreliable.
 *
 * Fallback triggers (any one):
 *   - No RPC connection injected (= SFTP transport).
 *   - Daemon doesn't advertise `fs.walk` in its capabilities.
 *   - RPC call throws.
 *
 * A `truncated: true` page is NOT a fallback trigger. The old
 * behaviour (discard the partial result and do an unbounded
 * per-folder BFS) never completed on a huge remote tree — e.g. a
 * profile pointed at `~/work` with 50 000+ files — so the vault
 * stayed empty and "files that exist on the remote can't be opened".
 * The fast path now PAGINATES: it re-issues `fs.walk` with an
 * increasing `offset` and drains every page, so the full tree loads
 * in bounded-size chunks regardless of size.
 *
 * The fallback's per-entry `mtime` / `size` stay at 0 (matching the
 * pre-walker behaviour) — Obsidian fills those in lazily on file
 * access. The fast path emits real values, which the model can use
 * straight away.
 */
export class BulkWalker {
  private static readonly FAST_PATH_CAPABILITY = 'fs.walk';

  constructor(private readonly deps: BulkWalkerDeps) {}

  /**
   * Defensive ceiling so a misbehaving daemon that always answers
   * `truncated:true` (or never advances the offset) can't spin
   * forever. At the daemon's default 50 000-entry page this is
   * 50 000 000 entries — far past any real vault — so a legitimate
   * tree never hits it; only a broken daemon does.
   */
  private static readonly MAX_PAGES = 1_000;

  /**
   * Walk `rootPath`. With `recursive` true (default) the whole subtree is
   * returned; with `recursive` false only `rootPath`'s IMMEDIATE children are
   * returned — the primitive the lazy per-folder loader uses to deepen one
   * level on demand instead of pulling a huge deep tree at connect.
   * Background indexing can disable inline fallback to schedule failed RPC
   * walks as individual folder loads through its shared ledger.
   */
  async walk(rootPath = '', recursive = true, allowFallback = true): Promise<BulkWalkResult> {
    const { signal } = this.deps;
    signal?.throwIfAborted();
    const start = Date.now();
    if (this.canUseFastPath()) {
      try {
        const result = await this.fastPath(rootPath, recursive);
        signal?.throwIfAborted();
        const visible = this.visibleEntries(result.entries);
        return {
          ...result,
          entries: visible,
          hiddenCount: result.entries.length - visible.length,
          walkMs: Date.now() - start,
          failedListings: [],
          // `truncated` here means we stopped at the page guard on a
          // pathological tree — surface it so populate can Notice the
          // partial load instead of silently showing a clipped vault.
          fastPathError: result.truncated ? 'page-guard' : null,
        };
      } catch (e) {
        signal?.throwIfAborted();
        if (!allowFallback) throw e;
        return this.walkFallback(rootPath, recursive, start, errorMessage(e));
      }
    }
    return this.walkFallback(rootPath, recursive, start, null);
  }

  private async walkFallback(
    rootPath: string, recursive: boolean, start: number, fastPathError: string | null,
  ): Promise<BulkWalkResult> {
    if (fastPathError !== null) {
      logger.warn(`BulkWalker: fs.walk failed (${fastPathError}); falling back to per-folder list`);
    }
    const fallback = await this.fallbackPath(rootPath, recursive);
    this.deps.signal?.throwIfAborted();
    const visible = this.visibleEntries(fallback.entries);
    return {
      ...fallback,
      entries: visible,
      hiddenCount: fallback.entries.length - visible.length,
      walkMs: Date.now() - start,
      fastPathError,
    };
  }

  /**
   * True when the daemon's paginated `fs.walk` is available, i.e. a full
   * recursive `walk('', true)` costs one RPC per 50 000-entry page rather than
   * one `adapter.list` round-trip per directory.
   *
   * Callers that must CHOOSE a traversal strategy up-front need this, because
   * `walk()` only reports which path it took (`BulkWalkResult.source`) after the
   * expensive part is already done. Vault population uses it to pick between
   * one recursive walk and a yielding folder-at-a-time BFS.
   */
  hasFastPath(): boolean {
    return this.canUseFastPath();
  }

  /**
   * Drop dot-prefixed entries so hidden files/dirs never reach the File
   * Explorer — matching Obsidian's own default of hiding dot-names. An entry
   * is hidden when ANY of its path segments starts with `.`, so a dot-DIR
   * (`.julia`, `.git`, …) hides its whole subtree. The vault config dir
   * (`.obsidian`) is deliberately included: Obsidian loads config directly
   * off the local shadow disk, NOT from this walked model, so dropping it
   * costs nothing AND keeps every client's per-device `<configDir>/user/<id>/`
   * subtree out of the tree (a foreign client's state must never surface as
   * editable files). Applies to the full walk AND every lazy per-folder
   * deepen (both route through here).
   */
  private visibleEntries(entries: RemoteEntry[]): RemoteEntry[] {
    return entries.filter((e) => !BulkWalker.isHiddenPath(e.path));
  }

  private static isHiddenPath(vaultPath: string): boolean {
    return vaultPath.split('/').some((seg) => seg.startsWith('.'));
  }

  // ─── internals ──────────────────────────────────────────────────────────

  private canUseFastPath(): boolean {
    const conn = this.deps.rpcConnection;
    if (!conn) return false;
    return conn.info.capabilities.includes(BulkWalker.FAST_PATH_CAPABILITY);
  }

  private async fastPath(rootPath: string, recursive: boolean): Promise<{
    entries: RemoteEntry[];
    source: 'rpc-walk';
    truncated: boolean;
    pages: number;
  }> {
    // canUseFastPath() guarded the caller, but assert for the type
    // narrowing flow analysis.
    if (!this.deps.rpcConnection) {
      throw new Error('BulkWalker.fastPath called without rpcConnection');
    }
    const all: RemoteEntry[] = [];
    let offset = 0;
    let pages = 0;
    for (;;) {
      this.deps.signal?.throwIfAborted();
      const params: WalkParams = { path: rootPath, recursive };
      if (this.deps.maxEntries != null) params.maxEntries = this.deps.maxEntries;
      if (offset > 0) params.offset = offset;
      if (this.deps.ignoreDirs?.length) params.ignore = this.deps.ignoreDirs;
      const page = await this.deps.rpcConnection.rpc.call('fs.walk', params);
      this.deps.signal?.throwIfAborted();
      for (const e of page.entries) {
        all.push({
          path:        e.path,
          isDirectory: e.type === 'folder',
          ctime:       e.mtime, // daemon has no separate ctime; mtime is the closest signal
          mtime:       e.mtime,
          size:        e.size,
        });
      }
      pages++;
      if (!page.truncated) {
        return { entries: all, source: 'rpc-walk', truncated: false, pages };
      }
      if (page.entries.length === 0) {
        // truncated=true but nothing delivered → the daemon cannot
        // advance past this offset. Returning what we have (flagged
        // incomplete) beats spinning forever.
        logger.warn(
          'BulkWalker: fs.walk reported truncated with an empty page; ' +
          `stopping at ${all.length} entries (incomplete)`,
        );
        return { entries: all, source: 'rpc-walk', truncated: true, pages };
      }
      offset += page.entries.length;
      if (pages >= BulkWalker.MAX_PAGES) {
        logger.warn(
          `BulkWalker: fs.walk exceeded ${BulkWalker.MAX_PAGES} pages ` +
          `(${all.length} entries); stopping (tree pathologically large)`,
        );
        return { entries: all, source: 'rpc-walk', truncated: true, pages };
      }
    }
  }

  private async fallbackPath(rootPath: string, recursive: boolean): Promise<{
    entries: RemoteEntry[];
    source: 'fallback-list';
    truncated: false;
    pages: number;
    failedListings: BulkWalkResult['failedListings'];
  }> {
    const entries: RemoteEntry[] = [];
    const failedListings: BulkWalkResult['failedListings'] = [];
    const { signal } = this.deps;
    const queue: string[] = [rootPath];
    while (queue.length > 0) {
      signal?.throwIfAborted();
      const folder = queue.shift()!;
      let listing: ListedFiles;
      try {
        listing = await (signal ? this.deps.adapter.list(folder, signal) : this.deps.adapter.list(folder));
      } catch (e) {
        signal?.throwIfAborted();
        const message = errorMessage(e);
        logger.warn(`BulkWalker.fallbackPath: list("${folder}") failed: ${message}`);
        if (!BulkWalker.isHiddenPath(folder)) failedListings.push({ path: folder, message });
        continue;
      }
      signal?.throwIfAborted();
      for (const sub of listing.folders) {
        if (!sub) continue;
        entries.push({ path: sub, isDirectory: true, ctime: 0, mtime: 0, size: 0 });
        if (recursive) queue.push(sub);   // one level only when non-recursive
      }
      for (const file of listing.files) {
        if (!file) continue;
        entries.push({ path: file, isDirectory: false, ctime: 0, mtime: 0, size: 0 });
      }
    }
    return { entries, source: 'fallback-list', truncated: false, pages: 0, failedListings };
  }
}
