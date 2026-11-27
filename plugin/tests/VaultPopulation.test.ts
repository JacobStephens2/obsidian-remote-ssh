import type { ListedFiles, Vault } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import type { RemoteFsClient } from '../src/adapter/RemoteFsClient';
import { SftpDataAdapter } from '../src/adapter/SftpDataAdapter';
import { DirCache } from '../src/cache/DirCache';
import { ReadCache } from '../src/cache/ReadCache';
import type { WalkParams, WalkResult } from '../src/proto/types';
import { VaultModelBuilder, type ObsidianClassDeps } from '../src/vault/VaultModelBuilder';
import { VaultPopulation, type PopulationProgress } from '../src/vault/VaultPopulation';
import { deferred } from './helpers/deferred';

class FakeFile {
  constructor(readonly vault: Vault, readonly path: string) {}
}

class FakeFolder extends FakeFile {
  children: FakeFile[] = [];
}

function harness(lazy = true, yields: { chunk?: () => Promise<void>; idle?: () => Promise<void> } = {}) {
  const root = new FakeFolder({} as Vault, '');
  const fileMap: Record<string, FakeFile> = {};
  const trigger = vi.fn<(event: string, file: FakeFile) => void>();
  const vault = {
    fileMap, trigger,
    getRoot: () => root,
    getAbstractFileByPath: (path: string) => fileMap[path] ?? null,
  };
  const classes = { TFile: FakeFile, TFolder: FakeFolder } as unknown as ObsidianClassDeps;
  const builder = new VaultModelBuilder(vault as unknown as Vault, classes);
  const progress = vi.fn<(value: PopulationProgress) => void>();
  const makePopulation = () => new VaultPopulation({
    builder, lazy, onProgress: progress, yieldChunk: yields.chunk, chunkSize: 2,
    yieldIdle: yields.idle ?? (() => Promise.resolve()),
  });
  const population = makePopulation();
  return {
    population, makePopulation, progress, fileMap, trigger,
    pathsCreated: () => trigger.mock.calls.map(([, file]) => file.path),
  };
}

function listing(folders: string[] = [], files: string[] = []): ListedFiles {
  return { folders, files };
}

function page(paths: string[], truncated = false): WalkResult {
  return {
    entries: paths.map(path => ({ path, type: path.endsWith('.md') ? 'file' : 'folder', mtime: 1, size: 2 })),
    truncated,
  };
}

function rpcTransport(call: (method: 'fs.walk', params: WalkParams) => Promise<WalkResult>) {
  return { adapter: { list: vi.fn().mockResolvedValue(listing()) },
    rpcConnection: { rpc: { call }, info: { capabilities: ['fs.walk'] } } };
}

describe('Vault population', () => {
  it('settles startup on stop and discards an outstanding page without issuing another request', async () => {
    const h = harness(false);
    const pending = deferred<WalkResult>();
    const call = vi.fn().mockReturnValue(pending.promise);
    const transport = rpcTransport(call);
    h.population.resume(transport);
    const startup = h.population.populate('test');
    expect(call).toHaveBeenCalledOnce();

    h.population.stop();
    await expect(startup).resolves.toEqual({ kind: 'cancelled' });
    pending.resolve(page(['folder', 'folder/a.md'], true));
    await pending.promise;
    await h.population.expand('folder');
    expect(call).toHaveBeenCalledOnce();
    expect(transport.adapter.list).not.toHaveBeenCalled();
    expect(h.pathsCreated()).toEqual([]);
    expect(h.progress).not.toHaveBeenCalled();
  });

  it('returns after the lazy root and shares an in-flight expansion with SFTP indexing', async () => {
    const idle = deferred<void>();
    const child = deferred<ListedFiles>();
    const h = harness(true, { idle: () => idle.promise });
    const list = vi.fn((path: string) => {
      if (path === '') return Promise.resolve(listing(['a', 'b', '.hidden'], ['root.md']));
      if (path === 'a') return child.promise;
      if (path === 'b') return Promise.resolve(listing([], ['b/unopened.md']));
      throw new Error(`Unexpected list ${path}`);
    });
    h.population.resume({ adapter: { list } });
    await h.population.expand('a');
    expect(list).not.toHaveBeenCalled();
    await expect(h.population.populate('lazy')).resolves.toMatchObject({ kind: 'complete', entries: 3 });
    expect(h.pathsCreated()).toEqual(['a', 'b', 'root.md']);
    expect(list.mock.calls.map(([path]) => path)).toEqual(['']);

    const first = h.population.expand('a');
    const second = h.population.expand('a');
    idle.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    child.resolve(listing([], ['a/expanded.md']));
    await Promise.all([first, second]);
    await vi.waitFor(() => expect(h.progress).toHaveBeenLastCalledWith({ kind: 'complete', files: 2, folders: 0 }));
    expect(list.mock.calls.map(([path]) => path)).toEqual(['', 'a', 'b']);
    expect(h.pathsCreated()).toEqual(['a', 'b', 'root.md', 'a/expanded.md', 'b/unopened.md']);
    expect(h.trigger.mock.calls.every(([event]) => event === 'create')).toBe(true);
  });

  it.each([true, false])('leaves a failed folder retryable while committing empty folders and siblings (lazy=%s)', async lazy => {
    const h = harness(lazy);
    let brokenCalls = 0;
    const list = vi.fn(async (path: string) => {
      if (path === '') return listing(['broken', 'empty', 'good']);
      if (path === 'broken' && ++brokenCalls === 1) throw new Error('permission denied');
      if (path === 'empty') return listing();
      return listing([], [`${path}/note.md`]);
    });
    h.population.resume({ adapter: { list } });
    const result = await h.population.populate('siblings');
    if (lazy) {
      expect(result.kind).toBe('complete');
      await vi.waitFor(() => expect(h.progress).toHaveBeenLastCalledWith({ kind: 'incomplete', files: 1, folders: 0 }));
    } else {
      expect(result).toMatchObject({ kind: 'incomplete', summary: expect.stringContaining('1 errors') });
      expect(h.progress).not.toHaveBeenCalled();
    }
    expect(h.pathsCreated()).toEqual(['broken', 'empty', 'good', 'good/note.md']);

    await h.population.expand('empty');
    await h.population.expand('good');
    await h.population.expand('broken');
    await h.population.expand('broken');
    expect(list.mock.calls.map(([path]) => path)).toEqual(['', 'broken', 'empty', 'good', 'broken']);
    expect(h.pathsCreated().at(-1)).toBe('broken/note.md');
  });

  it('resumes interrupted eager startup on the rebound SFTP transport', async () => {
    const h = harness(false);
    const pending = deferred<WalkResult>();
    const oldCall = vi.fn().mockReturnValue(pending.promise);
    const old = rpcTransport(oldCall);
    h.population.resume(old);
    const startup = h.population.populate('eager');
    const settled = vi.fn();
    void startup.then(settled);
    h.population.pause();
    await h.population.expand('unavailable');
    expect(settled).not.toHaveBeenCalled();

    const list = vi.fn(async (path: string) => path === '' ? listing(['new']) : listing([], ['new/ok.md']));
    h.population.resume({ adapter: { list } });
    await expect(startup).resolves.toMatchObject({ kind: 'complete', entries: 2 });
    pending.reject(new Error('old transport died'));
    await pending.promise.catch(() => {});
    expect(oldCall).toHaveBeenCalledOnce();
    expect(old.adapter.list).not.toHaveBeenCalled();
    expect(list.mock.calls.map(([path]) => path)).toEqual(['', 'new']);
    expect(h.pathsCreated()).toEqual(['new', 'new/ok.md']);
  });

  it('retains entries before a stopped chunk and leaves a replacement run isolated', async () => {
    const chunk = deferred<void>();
    const h = harness(false, { chunk: () => chunk.promise });
    const old = rpcTransport(vi.fn().mockResolvedValue(page(['a', 'a/first.md', 'a/stale.md'])));
    h.population.resume(old);
    const startup = h.population.populate('old');
    await vi.waitFor(() => expect(h.pathsCreated()).toEqual(['a', 'a/first.md']));
    h.population.stop();
    await expect(startup).resolves.toEqual({ kind: 'cancelled' });

    const replacement = h.makePopulation();
    const modern = rpcTransport(vi.fn().mockResolvedValue(page(['a', 'a/first.md', 'a/new.md'])));
    replacement.resume(modern);
    const result = replacement.populate('new');
    chunk.resolve();
    await expect(result).resolves.toMatchObject({ kind: 'complete' });
    expect(h.pathsCreated()).toEqual(['a', 'a/first.md', 'a/new.md']);
  });

  it('reads the rebound SFTP tree after pausing a partially built cached listing', async () => {
    const chunk = deferred<void>();
    const h = harness(false, { chunk: () => chunk.promise });
    const old = { list: vi.fn().mockResolvedValue([{ name: 'a.md' }, { name: 'b.md' }, { name: 'old.md' }]) };
    const rebound = { list: vi.fn().mockResolvedValue([{ name: 'a.md' }, { name: 'b.md' }, { name: 'new.md' }]) };
    const adapter = new SftpDataAdapter(
      old as unknown as RemoteFsClient, '/vault', new ReadCache(), new DirCache({ now: () => 0 }), 'v',
    );
    h.population.resume({ adapter });
    const startup = h.population.populate('cache');
    await vi.waitFor(() => expect(h.pathsCreated()).toEqual(['a.md', 'b.md']));

    h.population.pause();
    adapter.swapClient(rebound as unknown as RemoteFsClient);
    h.population.resume({ adapter });
    chunk.resolve();
    await expect(startup).resolves.toMatchObject({ kind: 'complete' });
    expect(h.pathsCreated()).toEqual(['a.md', 'b.md', 'new.md']);
    expect(rebound.list).toHaveBeenCalledWith('/vault');
  });

  it('discards a paused background chunk and finishes through the rebound generation', async () => {
    const chunk = deferred<void>();
    const h = harness(true, { chunk: () => chunk.promise });
    const oldCall = vi.fn(async (_method: 'fs.walk', params: WalkParams) => params.recursive
      ? page(['a', 'a/a.md', 'a/b.md', 'a/stale.md'])
      : page(['a']));
    h.population.resume(rpcTransport(oldCall));
    await h.population.populate('lazy');
    await vi.waitFor(() => expect(h.pathsCreated()).toEqual(['a', 'a/a.md', 'a/b.md']));
    h.population.pause();
    const reports = h.progress.mock.calls.length;
    chunk.resolve();
    await chunk.promise;
    expect(h.progress.mock.calls).toHaveLength(reports);
    expect(h.pathsCreated()).toEqual(['a', 'a/a.md', 'a/b.md']);

    const list = vi.fn(async (path: string) => path === ''
      ? listing(['a']) : listing([], ['a/a.md', 'a/b.md', 'a/new.md']));
    h.population.resume({ adapter: { list } });
    await vi.waitFor(() => expect(h.progress).toHaveBeenLastCalledWith({ kind: 'complete', files: 1, folders: 0 }));
    expect(h.pathsCreated()).toEqual(['a', 'a/a.md', 'a/b.md', 'a/new.md']);
    h.population.pause();
    h.population.resume({ adapter: { list } });
    expect(list.mock.calls.map(([path]) => path)).toEqual(['', 'a']);
  });

  it('drains paginated recursive RPC results alongside expansion without duplicate create events', async () => {
    const nextPage = deferred<WalkResult>();
    const h = harness();
    const ignoreDirs = ['ignored'];
    const call = vi.fn((_method: 'fs.walk', params: WalkParams) => {
      if (params.offset) return nextPage.promise;
      if (params.recursive) return Promise.resolve(page(['a', 'a/duplicate.md'], true));
      if (params.path === 'a') return Promise.resolve(page(['a/duplicate.md']));
      return Promise.resolve(page(['a']));
    });
    h.population.resume({ ...rpcTransport(call), ignoreDirs });
    ignoreDirs.length = 0;
    await h.population.populate('paged');
    await vi.waitFor(() => expect(call).toHaveBeenCalledWith('fs.walk', {
      path: '', recursive: true, offset: 2, ignore: ['ignored'],
    }));
    await h.population.expand('a');
    nextPage.resolve(page(['a/unopened', 'a/unopened/new.md', '.hidden.md']));
    await vi.waitFor(() => expect(h.progress).toHaveBeenLastCalledWith({ kind: 'complete', files: 1, folders: 1 }));
    expect(h.pathsCreated()).toEqual(['a', 'a/duplicate.md', 'a/unopened', 'a/unopened/new.md']);
    const calls = call.mock.calls.length;
    await h.population.expand('a/unopened');
    expect(call).toHaveBeenCalledTimes(calls);
  });

  it.each(['truncated', 'build error'])('leaves RPC folders retryable after a recursive %s', async failure => {
    const h = harness();
    const call = vi.fn(async (_method: 'fs.walk', params: WalkParams) => {
      if (params.offset) return page([], true);
      if (params.recursive && failure === 'truncated') return page(['a', 'a/partial.md'], true);
      if (params.recursive) return page(['a', 'a/partial.md', 'missing/orphan.md']);
      return params.path === 'a' ? page(['a/partial.md', 'a/retry.md']) : page(['a']);
    });
    h.population.resume(rpcTransport(call));
    await h.population.populate('partial');
    await vi.waitFor(() => expect(h.progress).toHaveBeenLastCalledWith({ kind: 'incomplete', files: 1, folders: 0 }));
    expect(h.pathsCreated()).toEqual(['a', 'a/partial.md']);
    await h.population.expand('a');
    expect(call).toHaveBeenLastCalledWith('fs.walk', { path: 'a', recursive: false });
    expect(h.pathsCreated()).toEqual(['a', 'a/partial.md', 'a/retry.md']);
  });
});
