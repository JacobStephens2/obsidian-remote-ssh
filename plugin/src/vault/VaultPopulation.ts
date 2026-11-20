import { errorMessage } from '../util/errorMessage';
import { logger } from '../util/logger';
import { BulkWalker, type BulkWalkerDeps, type BulkWalkResult } from './BulkWalker';
import type { BuildResult, RemoteEntry, VaultModelBuilder } from './VaultModelBuilder';

export type PopulationTransport = Pick<BulkWalkerDeps, 'adapter' | 'rpcConnection' | 'ignoreDirs'>;

export type PopulationOutcome = { kind: 'cancelled' } | {
  kind: 'complete' | 'incomplete';
  summary: string;
  entries: number;
  hiddenCount: number;
  truncated: boolean;
};

export interface PopulationProgress {
  kind: 'indexing' | 'complete' | 'incomplete';
  files: number;
  folders: number;
}

interface PopulationDeps {
  builder: VaultModelBuilder;
  lazy: boolean;
  onProgress: (progress: PopulationProgress) => void;
  chunkSize?: number;
  yieldChunk?: () => Promise<void>;
  yieldIdle?: () => Promise<void>;
}

interface Generation {
  abort: AbortController;
  walker: BulkWalker;
  transport: PopulationTransport;
  loaded: Map<string, string[]>;
  pending: Map<string, Promise<FolderLoad>>;
}

interface FolderLoad {
  walk: BulkWalkResult;
  build: BuildResult;
  children: string[];
  complete: boolean;
}

interface Startup {
  label: string;
  resolve: (result: PopulationOutcome) => void;
  reject: (error: unknown) => void;
}

/**
 * Owns initial registration, File Explorer expansion and background registration
 * for one shadow-vault connection. The initial request survives a transport
 * pause. Folder bookkeeping belongs to each transport generation, while entries
 * already published to Obsidian survive both pauses and terminal stops.
 * Covers path registration. Obsidian reads file contents for its own metadata cache.
 */
export class VaultPopulation {
  private generation: Generation | null = null;
  private stopped = false;
  private startup: Startup | null = null;
  private initialResult: Promise<PopulationOutcome> | null = null;
  private background: 'unrequested' | 'unfinished' | 'complete' = 'unrequested';

  constructor(private readonly deps: PopulationDeps) {}

  populate(label: string): Promise<PopulationOutcome> {
    if (this.stopped) return Promise.resolve({ kind: 'cancelled' });
    if (this.initialResult) return this.initialResult;
    let resolve!: Startup['resolve'];
    let reject!: Startup['reject'];
    const promise = new Promise<PopulationOutcome>((onResult, onError) => {
      resolve = onResult;
      reject = onError;
    });
    this.initialResult = promise;
    this.startup = { label, resolve, reject };
    if (this.generation) void this.runStartup(this.generation, this.startup);
    return promise;
  }

  async expand(path: string): Promise<void> {
    const run = this.generation;
    if (!run || !this.initialResult || run.loaded.has(path)) return;
    try {
      await this.loadFolder(run, path, run.walker);
    } catch (e) {
      if (run.abort.signal.aborted) return;
      logger.warn(`Vault population: expand "${path}" failed: ${errorMessage(e)}`);
    }
  }

  pause(): void {
    const run = this.generation;
    this.generation = null;
    run?.abort.abort();
  }

  resume(transport: PopulationTransport): void {
    if (this.stopped || this.generation) return;
    const abort = new AbortController();
    const binding = { ...transport, ignoreDirs: transport.ignoreDirs?.slice() };
    const run: Generation = {
      abort, transport: binding, walker: new BulkWalker({ ...binding, signal: abort.signal }),
      loaded: new Map(), pending: new Map(),
    };
    this.generation = run;
    if (this.startup) void this.runStartup(run, this.startup);
    else if (this.background === 'unfinished') void this.index(run);
  }

  stop(): void {
    this.stopped = true;
    this.pause();
    this.startup?.resolve({ kind: 'cancelled' });
    this.startup = null;
  }

  private async runStartup(run: Generation, startup: Startup): Promise<void> {
    const start = Date.now();
    const { label } = startup;
    const { lazy } = this.deps;
    const { signal } = run.abort;
    try {
      const { walk, build, complete } = lazy
        ? await this.loadFolder(run, '', run.walker, 500)
        : await this.loadTree(run);
      signal.throwIfAborted();
      const errors = walk.failedListings.length + build.errors.length;
      logger.info(
        `populateVaultFromRemote(${label}): ${walk.source}, ${walk.entries.length} entries ` +
        `(${walk.hiddenCount} hidden) in ${walk.walkMs}ms (pages=${walk.pages})${lazy ? ' [lazy: root level]' : ''}` +
        (walk.fastPathError ? ` (fs.walk: ${walk.fastPathError})` : ''),
      );
      this.startup = null;
      startup.resolve({
        kind: complete ? 'complete' : 'incomplete',
        summary: `${build.filesAdded}f + ${build.foldersAdded}d built, ` +
          `${build.skipped} skipped, ${errors} errors (${Date.now() - start}ms)`,
        entries: walk.entries.length, hiddenCount: walk.hiddenCount, truncated: walk.truncated,
      });
      if (lazy) {
        this.background = 'unfinished';
        void this.index(run);
      }
    } catch (e) {
      if (signal.aborted) return;
      this.startup = null;
      startup.reject(e);
    }
  }

  private loadFolder(run: Generation, path: string, walker: BulkWalker, chunkSize = 100): Promise<FolderLoad> {
    const pending = run.pending.get(path);
    if (pending) return pending;
    const load = this.buildFolder(run, path, walker, chunkSize).finally(() => {
      run.pending.delete(path);
    });
    run.pending.set(path, load);
    return load;
  }

  private async buildFolder(run: Generation, path: string, walker: BulkWalker, chunkSize: number): Promise<FolderLoad> {
    const { signal } = run.abort;
    const walk = await walker.walk(path, false);
    const build = await this.build(run, walk.entries, chunkSize);
    signal.throwIfAborted();
    const children = walk.entries.filter(entry => entry.isDirectory).map(entry => entry.path);
    const complete = !walk.truncated && walk.failedListings.length === 0 && build.errors.length === 0;
    if (complete) run.loaded.set(path, children);
    this.logBuildErrors(build);
    return { walk, build, children, complete };
  }

  private async loadTree(run: Generation): Promise<FolderLoad> {
    const walk = await run.walker.walk();
    const build = await this.build(run, walk.entries, 500);
    run.abort.signal.throwIfAborted();
    this.logBuildErrors(build);
    if (!walk.truncated && build.errors.length === 0) this.recordTree(run, walk);
    return {
      walk, build, children: [],
      complete: !walk.truncated && walk.failedListings.length === 0 && build.errors.length === 0,
    };
  }

  private build(run: Generation, entries: RemoteEntry[], chunkSize: number): Promise<BuildResult> {
    return this.deps.builder.buildChunked(
      entries, this.deps.chunkSize ?? chunkSize, run.abort.signal, this.deps.yieldChunk,
    );
  }

  private async index(run: Generation): Promise<void> {
    const start = Date.now();
    const counts = { files: 0, folders: 0 };
    const { signal } = run.abort;
    const reportBuild = (build: BuildResult) => {
      signal.throwIfAborted();
      counts.files += build.filesAdded;
      counts.folders += build.foldersAdded;
      this.deps.onProgress({ ...counts, kind: 'indexing' });
    };
    let complete = false;
    try {
      await this.yieldIdle(run);
      const walk = await this.walkForIndex(run);
      complete = walk
        ? await this.indexTree(run, walk, reportBuild)
        : await this.indexFolders(run, reportBuild);
    } catch (e) {
      if (signal.aborted) return;
      logger.warn(`Vault population: index failed: ${errorMessage(e)}`);
    }
    if (signal.aborted) return;
    if (complete) this.background = 'complete';
    const kind = complete ? 'complete' : 'incomplete';
    logger.info(
      `Vault population: index ${kind} — ${counts.files}f + ${counts.folders}d indexed in ${Date.now() - start}ms`,
    );
    this.deps.onProgress({ ...counts, kind });
  }

  private async walkForIndex(run: Generation): Promise<BulkWalkResult | undefined> {
    const { signal } = run.abort;
    signal.throwIfAborted();
    if (!run.walker.hasFastPath()) return;
    try {
      return await run.walker.walk('', true, false);
    } catch (e) {
      signal.throwIfAborted();
      logger.warn(`Vault population: recursive fs.walk failed (${errorMessage(e)}); indexing folder by folder`);
    }
  }

  private async indexTree(
    run: Generation, walk: BulkWalkResult, reportBuild: (build: BuildResult) => void,
  ): Promise<boolean> {
    run.abort.signal.throwIfAborted();
    const byDepth = new Map<number, RemoteEntry[]>();
    for (const entry of walk.entries) {
      const depth = entry.path.split('/').length;
      const bucket = byDepth.get(depth);
      if (bucket) bucket.push(entry);
      else byDepth.set(depth, [entry]);
    }
    let complete = !walk.truncated;
    for (const depth of [...byDepth.keys()].sort((a, b) => a - b)) {
      const build = await this.build(run, byDepth.get(depth)!, 100);
      run.abort.signal.throwIfAborted();
      this.logBuildErrors(build);
      if (build.errors.length) complete = false;
      reportBuild(build);
      await this.yieldIdle(run);
    }
    if (complete) this.recordTree(run, walk);
    return complete;
  }

  private async indexFolders(run: Generation, reportBuild: (build: BuildResult) => void): Promise<boolean> {
    const { signal } = run.abort;
    const walker = run.walker.hasFastPath()
      ? new BulkWalker({ adapter: run.transport.adapter, signal })
      : run.walker;
    // Sets preserve discovery order and visit newly added folders once.
    const queue = new Set(['']);
    let complete = true;
    for (const path of queue) {
      signal.throwIfAborted();
      let children = run.loaded.get(path);
      if (!children) {
        const result = await this.loadFolder(run, path, walker);
        signal.throwIfAborted();
        if (!result.complete) complete = false;
        children = result.children;
        reportBuild(result.build);
      }
      for (const child of children) queue.add(child);
      await this.yieldIdle(run);
    }
    return complete;
  }

  private recordTree(run: Generation, walk: BulkWalkResult): void {
    run.abort.signal.throwIfAborted();
    const failed = new Set(walk.failedListings.map(failure => failure.path));
    const folders = new Map<string, string[]>([['', []]]);
    for (const { path, isDirectory } of walk.entries) {
      if (!isDirectory) continue;
      if (!folders.has(path)) folders.set(path, []);
      const parent = path.slice(0, Math.max(0, path.lastIndexOf('/')));
      if (!folders.has(parent)) folders.set(parent, []);
      folders.get(parent)!.push(path);
    }
    for (const [path, children] of folders) {
      if (!failed.has(path)) run.loaded.set(path, children);
    }
  }

  private async yieldIdle(run: Generation): Promise<void> {
    run.abort.signal.throwIfAborted();
    await (this.deps.yieldIdle ?? idleYield)();
    run.abort.signal.throwIfAborted();
  }

  private logBuildErrors(build: BuildResult): void {
    if (build.errors.length) {
      logger.warn(`Vault population: first 5 build errors: ${JSON.stringify(build.errors.slice(0, 5))}`);
    }
  }
}

function idleYield(): Promise<void> {
  return new Promise(resolve => {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(() => resolve(), { timeout: 500 });
    } else {
      window.setTimeout(resolve, 0);
    }
  });
}
