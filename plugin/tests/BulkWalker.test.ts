import { describe, it, expect, vi } from 'vitest';
import { BulkWalker, type AdapterListSlice, type RpcConnectionSlice } from '../src/vault/BulkWalker';
import type { WalkResult } from '../src/proto/types';

/**
 * Build a fake adapter whose `list(p)` returns a stubbed
 * `{files, folders}` per path. Unknown paths reply empty.
 */
function makeAdapter(map: Record<string, { files?: string[]; folders?: string[] }>): AdapterListSlice {
  return {
    async list(p: string) {
      const entry = map[p];
      return {
        files:   entry?.files ?? [],
        folders: entry?.folders ?? [],
      };
    },
  };
}

/**
 * Build a fake RPC connection that advertises `capabilities` and
 * answers `fs.walk` from `walkResult`. Either `walkResult` is a
 * static value or a function we can use to throw.
 */
function makeRpc(
  capabilities: string[],
  walkResult: WalkResult | (() => Promise<WalkResult>),
): { rpc: RpcConnectionSlice; calls: number } {
  let calls = 0;
  const rpc: RpcConnectionSlice = {
    info: { capabilities },
    rpc: {
      call: vi.fn(async (method, params) => {
        calls++;
        expect(method).toBe('fs.walk');
        expect(params.recursive).toBe(true);
        return typeof walkResult === 'function' ? walkResult() : walkResult;
      }) as RpcConnectionSlice['rpc']['call'],
    },
  };
  return { rpc, calls: 0 } as unknown as { rpc: RpcConnectionSlice; calls: number };
  // (we mutate `calls` indirectly via the closure; assertion sites use rpc.rpc.call.mock.calls.length)
}

describe('BulkWalker', () => {
  // ─── fast path (rpc-walk) ───────────────────────────────────────────────

  it('uses fs.walk when the daemon advertises the capability', async () => {
    const adapter = makeAdapter({});
    const { rpc } = makeRpc(['fs.list', 'fs.walk', 'fs.stat'], {
      entries: [
        { path: 'docs',         type: 'folder', mtime: 1000, size: 0 },
        { path: 'docs/note.md', type: 'file',   mtime: 2000, size: 17 },
        { path: 'README.md',    type: 'file',   mtime: 3000, size: 42 },
      ],
      truncated: false,
    });
    const walker = new BulkWalker({ adapter, rpcConnection: rpc });

    const result = await walker.walk('');

    expect(result.source).toBe('rpc-walk');
    expect(result.truncated).toBe(false);
    expect(result.fastPathError).toBeNull();
    expect(result.entries).toHaveLength(3);
    expect(result.entries[0]).toMatchObject({ path: 'docs',         isDirectory: true,  mtime: 1000, size: 0 });
    expect(result.entries[1]).toMatchObject({ path: 'docs/note.md', isDirectory: false, mtime: 2000, size: 17 });
    expect(result.entries[2]).toMatchObject({ path: 'README.md',    isDirectory: false, mtime: 3000, size: 42 });
  });

  it('hides ALL dot-prefixed entries (incl the config dir) and reports hiddenCount', async () => {
    const adapter = makeAdapter({});
    const { rpc } = makeRpc(['fs.walk'], {
      entries: [
        { path: 'Notes',                     type: 'folder', mtime: 1, size: 0 },
        { path: 'Notes/keep.md',             type: 'file',   mtime: 2, size: 1 },
        { path: '.julia',                    type: 'folder', mtime: 3, size: 0 },
        { path: '.julia/registry.md',        type: 'file',   mtime: 4, size: 1 },
        { path: 'Notes/.secret.md',          type: 'file',   mtime: 5, size: 1 },
        { path: '.obsidian/app.json',        type: 'file',   mtime: 6, size: 1 },
        { path: '.obsidian/user/box/app.json', type: 'file', mtime: 7, size: 1 },
      ],
      truncated: false,
    });
    const walker = new BulkWalker({ adapter, rpcConnection: rpc });

    const result = await walker.walk('');

    // `.julia` + its subtree, a nested dotfile, AND the whole `.obsidian`
    // config dir (incl any client's per-device `user/<id>/` subtree) are
    // dropped — config is loaded off the local disk, never from this model.
    expect(result.entries.map(e => e.path)).toEqual(['Notes', 'Notes/keep.md']);
    expect(result.hiddenCount).toBe(5);
  });

  it('applies the same dotfile filter on the fallback (adapter.list) path', async () => {
    const adapter = makeAdapter({
      '':      { folders: ['Notes', '.git'], files: ['README.md'] },
      'Notes': { folders: [],                files: ['Notes/keep.md', 'Notes/.secret.md'] },
      '.git':  { folders: [],                files: ['.git/config'] },
    });
    const walker = new BulkWalker({ adapter /* no rpcConnection → fallback */ });

    const result = await walker.walk('');

    expect(result.source).toBe('fallback-list');
    // `.git` (+ its file) and the nested `.secret.md` are dropped, exactly
    // as on the fast path — the filter lives in walk(), shared by both.
    expect(result.entries.map(e => e.path).sort()).toEqual(['Notes', 'Notes/keep.md', 'README.md']);
    expect(result.hiddenCount).toBe(3);
  });

  it('passes through the maxEntries override when set', async () => {
    const adapter = makeAdapter({});
    const callSpy = vi.fn(async () => ({ entries: [], truncated: false } as WalkResult));
    const rpc: RpcConnectionSlice = {
      info: { capabilities: ['fs.walk'] },
      rpc: { call: callSpy as unknown as RpcConnectionSlice['rpc']['call'] },
    };
    const walker = new BulkWalker({ adapter, rpcConnection: rpc, maxEntries: 7 });

    await walker.walk('');

    expect(callSpy).toHaveBeenCalledWith('fs.walk', { path: '', recursive: true, maxEntries: 7 });
  });

  it('passes ignoreDirs through to fs.walk as `ignore`', async () => {
    const adapter = makeAdapter({});
    const callSpy = vi.fn(async () => ({ entries: [], truncated: false } as WalkResult));
    const rpc: RpcConnectionSlice = {
      info: { capabilities: ['fs.walk'] },
      rpc: { call: callSpy as unknown as RpcConnectionSlice['rpc']['call'] },
    };
    const walker = new BulkWalker({
      adapter, rpcConnection: rpc, ignoreDirs: ['node_modules', '.git'],
    });

    await walker.walk('');

    expect(callSpy).toHaveBeenCalledWith('fs.walk', {
      path: '', recursive: true, ignore: ['node_modules', '.git'],
    });
  });

  it('omits `ignore` when ignoreDirs is empty or unset', async () => {
    const adapter = makeAdapter({});
    const callSpy = vi.fn(async () => ({ entries: [], truncated: false } as WalkResult));
    const rpc: RpcConnectionSlice = {
      info: { capabilities: ['fs.walk'] },
      rpc: { call: callSpy as unknown as RpcConnectionSlice['rpc']['call'] },
    };
    const walker = new BulkWalker({ adapter, rpcConnection: rpc, ignoreDirs: [] });

    await walker.walk('');

    expect(callSpy).toHaveBeenCalledWith('fs.walk', { path: '', recursive: true });
  });

  // ─── fast path pagination + fallback-on-error ───────────────────────────

  it('paginates: drains every page with an increasing offset, no fallback', async () => {
    // The bug this guards: a truncated page used to be DISCARDED and
    // replaced by an unbounded per-folder BFS that never finished on a
    // huge tree → empty vault. Now it must page through and return the
    // FULL stitched tree via rpc-walk.
    const pages: WalkResult[] = [
      { entries: [
        { path: 'a.md', type: 'file', mtime: 1, size: 1 },
        { path: 'b.md', type: 'file', mtime: 2, size: 2 },
      ], truncated: true },
      { entries: [
        { path: 'c.md', type: 'file', mtime: 3, size: 3 },
        { path: 'd.md', type: 'file', mtime: 4, size: 4 },
      ], truncated: true },
      { entries: [
        { path: 'e.md', type: 'file', mtime: 5, size: 5 },
      ], truncated: false },
    ];
    const seenOffsets: Array<number | undefined> = [];
    const call = vi.fn(async (_m: string, p: { offset?: number }) => {
      seenOffsets.push(p.offset);
      return pages.shift()!;
    });
    const rpc: RpcConnectionSlice = {
      info: { capabilities: ['fs.walk'] },
      rpc: { call: call as unknown as RpcConnectionSlice['rpc']['call'] },
    };
    const walker = new BulkWalker({ adapter: makeAdapter({}), rpcConnection: rpc });

    const result = await walker.walk('');

    expect(result.source).toBe('rpc-walk');
    expect(result.truncated).toBe(false);
    expect(result.fastPathError).toBeNull();
    expect(result.pages).toBe(3);
    expect(result.entries.map(e => e.path)).toEqual(['a.md', 'b.md', 'c.md', 'd.md', 'e.md']);
    // Real mtime/size preserved across pages (fast path, not the zeroed fallback).
    expect(result.entries[4]).toMatchObject({ path: 'e.md', mtime: 5, size: 5 });
    // Page 1 has no offset; pages 2/3 carry the running total.
    expect(seenOffsets).toEqual([undefined, 2, 4]);
  });

  it('stops at the empty-page guard when the daemon truncates but delivers nothing', async () => {
    const pages: WalkResult[] = [
      { entries: [{ path: 'a.md', type: 'file', mtime: 1, size: 1 }], truncated: true },
      { entries: [], truncated: true }, // daemon can't advance — must not spin
    ];
    const call = vi.fn(async () => pages.shift()!);
    const rpc: RpcConnectionSlice = {
      info: { capabilities: ['fs.walk'] },
      rpc: { call: call as unknown as RpcConnectionSlice['rpc']['call'] },
    };
    const walker = new BulkWalker({ adapter: makeAdapter({}), rpcConnection: rpc });

    const result = await walker.walk('');

    expect(call).toHaveBeenCalledTimes(2);
    expect(result.source).toBe('rpc-walk');
    expect(result.truncated).toBe(true);          // incomplete, surfaced
    expect(result.fastPathError).toBe('page-guard');
    expect(result.entries.map(e => e.path)).toEqual(['a.md']);
  });

  it('falls back when the fs.walk RPC throws', async () => {
    const adapter = makeAdapter({
      '': { folders: ['x'], files: ['y.md'] },
      'x': { files: ['x/z.md'] },
    });
    const { rpc } = makeRpc(['fs.walk'], async () => { throw new Error('connection reset'); });
    const walker = new BulkWalker({ adapter, rpcConnection: rpc });

    const result = await walker.walk('');

    expect(result.source).toBe('fallback-list');
    expect(result.fastPathError).toBe('connection reset');
    expect(result.entries.map(e => e.path).sort()).toEqual(['x', 'x/z.md', 'y.md']);
  });

  // ─── no fast path available ─────────────────────────────────────────────

  it('skips the fast path when no RPC connection is injected (= SFTP transport)', async () => {
    const adapter = makeAdapter({
      '':    { folders: ['notes'] },
      'notes': { files: ['notes/today.md'] },
    });
    const walker = new BulkWalker({ adapter /* no rpcConnection */ });

    const result = await walker.walk('');

    expect(result.source).toBe('fallback-list');
    expect(result.fastPathError).toBeNull();
    expect(result.entries.map(e => e.path).sort()).toEqual(['notes', 'notes/today.md']);
  });

  it('skips the fast path when the daemon does not advertise fs.walk', async () => {
    const adapter = makeAdapter({ '': { files: ['a.md'] } });
    const callSpy = vi.fn();
    const rpc: RpcConnectionSlice = {
      info: { capabilities: ['fs.list', 'fs.stat'] },  // no fs.walk
      rpc: { call: callSpy as unknown as RpcConnectionSlice['rpc']['call'] },
    };
    const walker = new BulkWalker({ adapter, rpcConnection: rpc });

    const result = await walker.walk('');

    expect(callSpy).not.toHaveBeenCalled();
    expect(result.source).toBe('fallback-list');
    expect(result.entries.map(e => e.path)).toEqual(['a.md']);
  });

  // ─── fallback resilience ────────────────────────────────────────────────

  it('fallback skips folders whose list() throws and keeps walking siblings', async () => {
    let listCalls = 0;
    const adapter: AdapterListSlice = {
      async list(p: string) {
        listCalls++;
        if (p === 'broken') throw new Error('permission denied');
        if (p === '')       return { files: ['ok.md'], folders: ['broken', 'good'] };
        if (p === 'good')   return { files: ['good/inside.md'], folders: [] };
        return { files: [], folders: [] };
      },
    };
    const walker = new BulkWalker({ adapter });

    const result = await walker.walk('');

    expect(result.source).toBe('fallback-list');
    expect(result.entries.map(e => e.path).sort()).toEqual(['broken', 'good', 'good/inside.md', 'ok.md']);
    expect(result.failedListings).toEqual([{ path: 'broken', message: expect.any(String) }]);
    expect(listCalls).toBeGreaterThan(0);
  });

  // ─── walkMs timing ──────────────────────────────────────────────────────

  it('records a non-negative walkMs', async () => {
    const adapter = makeAdapter({ '': { files: ['x.md'] } });
    const walker = new BulkWalker({ adapter });
    const result = await walker.walk('');
    expect(result.walkMs).toBeGreaterThanOrEqual(0);
  });
});
