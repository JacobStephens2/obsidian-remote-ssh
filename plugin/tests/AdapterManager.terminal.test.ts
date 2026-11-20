import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/ui/RemoteTerminalView', () => ({
  RemoteTerminalView: class {}, VIEW_TYPE_REMOTE_TERMINAL: 'remote-terminal',
}));
import { App, clearNotices, recordedNotices, type ListedFiles } from 'obsidian';
import type { RemoteFsClient } from '../src/adapter/RemoteFsClient';
import { SftpDataAdapter } from '../src/adapter/SftpDataAdapter';
import { DirCache } from '../src/cache/DirCache';
import { ReadCache } from '../src/cache/ReadCache';
import type { ConnectionManager } from '../src/ConnectionManager';
import RemoteSshPlugin from '../src/main';
import { ShadowStartupCoordinator } from '../src/shadow/ShadowStartupCoordinator';
import { ShadowVaultBootstrap } from '../src/shadow/ShadowVaultBootstrap';
import { SyncState } from '../src/types';

type ReconnectOptions = Parameters<ConnectionManager['startReconnect']>[0];

function harness() {
  const plugin = new RemoteSshPlugin(new App() as never);
  const restore = vi.fn();
  const stop = vi.fn();
  const pause = vi.fn();
  const resume = vi.fn();
  const list = vi.fn();
  const setReconnecting = vi.fn();
  const replayOfflineQueue = vi.fn();
  const startReconnect = vi.fn<(opts: ReconnectOptions) => Promise<void>>().mockResolvedValue(undefined);
  // Terminal wiring is intentionally tested with the lifetime owner substituted;
  // physical ownership is covered by AdapterManager.test.ts.
  const p = plugin as unknown as {
    settings: unknown; conn: unknown; adapterMgr: unknown; statusBar: unknown;
    population: unknown;
    state: SyncState; setState: (s: SyncState) => void;
    cancelReconnect(): void; startReconnect(): Promise<void>;
    onReconnectStateChange(s: unknown): void; debugRestoreAdapter(): void;
    runAutoConnect(tag: 'layout-ready' | 'reconnect'): Promise<void>;
    runShadowStartup(): Promise<void>;
  };
  const profile = { id: 'p', name: 'Test', walkIgnoreDirs: [] };
  const settings = { profiles: [profile], autoConnectProfileId: 'p', activeProfileId: null, reconnectMaxRetries: 0 };
  p.settings = settings;
  const conn = { activeProfile: profile, reconnectManager: { isActive: () => true },
    activeRemoteBasePath: '/vault', rpcConnection: null,
    cancelReconnect: vi.fn(), startReconnect, disconnectTransport: vi.fn(async () => {}),
    isAlive: () => false };
  p.conn = conn;
  const adapterMgr = {
    restore, isPatched: () => true, replayOfflineQueue,
    dataAdapter: { setReconnecting, list } as Partial<SftpDataAdapter> | null,
  };
  p.adapterMgr = adapterMgr;
  p.statusBar = { remove: vi.fn(), update: vi.fn() };
  p.population = { stop, pause, resume };
  p.state = SyncState.IDLE;
  p.setState = vi.fn((state) => { p.state = state; });
  plugin.app.workspace.detachLeavesOfType = vi.fn();
  return { plugin, p, settings, conn, adapterMgr, restore, stop, pause, resume, startReconnect, list, setReconnecting, replayOfflineQueue };
}

afterEach(() => { vi.restoreAllMocks(); clearNotices(); });

describe('plugin terminal adapter lifetimes', () => {
  it('restores when reconnect is cancelled', () => {
    const h = harness(); h.p.cancelReconnect(); expect(h.restore).toHaveBeenCalledOnce();
    expect(h.stop).toHaveBeenCalledBefore(h.restore);
  });
  it('restores when retries are disabled', async () => {
    const h = harness(); await h.p.startReconnect(); expect(h.restore).toHaveBeenCalledOnce();
    expect(h.stop).toHaveBeenCalledBefore(h.restore);
    expect(h.startReconnect).not.toHaveBeenCalled();
  });
  it('restores when reconnect fails', () => {
    const h = harness(); h.p.onReconnectStateChange({ kind: 'failed', reason: 'connection lost' });
    expect(h.restore).toHaveBeenCalledOnce();
    expect(h.stop).toHaveBeenCalledBefore(h.restore);
  });
  it('restores on disconnect', async () => {
    const h = harness(); await h.plugin.disconnect(); expect(h.restore).toHaveBeenCalledOnce();
    expect(h.stop).toHaveBeenCalledBefore(h.restore);
    expect(h.restore).toHaveBeenCalledBefore(h.conn.disconnectTransport);
  });
  it('restores synchronously on unload', async () => {
    const h = harness(); h.plugin.onunload(); expect(h.restore).toHaveBeenCalled();
    expect(h.stop).toHaveBeenCalledBefore(h.restore);
    await Promise.resolve(); await Promise.resolve();
  });
  it('restores through the manual command', () => {
    const h = harness(); h.p.debugRestoreAdapter();
    expect(h.stop).toHaveBeenCalledBefore(h.restore);
    expect(h.restore).toHaveBeenCalledOnce();
  });

  it('invalidates layout startup while the initial plugin preparation is pending', async () => {
    const h = harness();
    h.p.population = null;
    let prepared!: () => void;
    const pending = new Promise<void>(resolve => { prepared = resolve; });
    vi.spyOn(ShadowStartupCoordinator.prototype, 'prepareForAutoConnect').mockReturnValue(pending);
    const connect = vi.spyOn(h.plugin, 'connectProfile').mockResolvedValue(undefined);
    const startup = h.p.runShadowStartup();
    await h.plugin.disconnect();
    prepared();
    await startup;
    expect(connect).not.toHaveBeenCalled();
  });

  it('discards the post-config continuation when the adapter is restored during the pull', async () => {
    const h = harness();
    h.p.population = null;
    h.conn.reconnectManager.isActive = () => false;
    vi.spyOn(h.plugin, 'connectProfile').mockImplementation(() => {
      h.p.setState(SyncState.CONNECTED);
      return Promise.resolve();
    });
    type ConfigResult = Awaited<ReturnType<typeof ShadowVaultBootstrap.pullSharedObsidianConfig>>;
    let pulled!: (result: ConfigResult) => void;
    const pending = new Promise<ConfigResult>(resolve => { pulled = resolve; });
    const pull = vi.spyOn(ShadowVaultBootstrap, 'pullSharedObsidianConfig').mockReturnValue(pending);
    const community = vi.spyOn(ShadowVaultBootstrap, 'pullCommunityPlugins');

    const startup = h.p.runAutoConnect('reconnect');
    await vi.waitFor(() => expect(pull).toHaveBeenCalledOnce());
    h.p.debugRestoreAdapter();
    pulled({ pulled: [], skipped: [], errored: ['app.json'] });
    await startup;
    expect(community).not.toHaveBeenCalled();
    expect(h.list).not.toHaveBeenCalled();
    expect(recordedNotices()).toEqual(['Remote SSH: adapter restored']);
  });

  it('suppresses Ready when the initial listing settles after a terminal restore', async () => {
    const h = harness();
    h.conn.reconnectManager.isActive = () => false;
    Object.assign(h.plugin.app.vault, { adapter: {} });
    let settle!: (files: ListedFiles) => void;
    h.list.mockReturnValue(new Promise<ListedFiles>(resolve => { settle = resolve; }));
    Object.assign(h.adapterMgr.dataAdapter!, { isReconnecting: () => false });
    vi.spyOn(h.plugin, 'connectProfile').mockImplementation(() => {
      h.p.setState(SyncState.CONNECTED);
      return Promise.resolve();
    });

    const startup = h.p.runAutoConnect('reconnect');
    await vi.waitFor(() => expect(h.list).toHaveBeenCalledOnce());
    h.p.debugRestoreAdapter();
    await startup;
    settle({ files: [], folders: [] });
    expect(recordedNotices()).toEqual(['Remote SSH: adapter restored']);
  });

  it('pauses before starting retries and resumes after the same adapter is unblocked', async () => {
    const h = harness();
    h.settings.reconnectMaxRetries = 3;
    const rpc = { rpc: { call: vi.fn() }, info: { capabilities: ['fs.walk'] } };
    await h.p.startReconnect();
    expect(h.pause).toHaveBeenCalledBefore(h.startReconnect);
    const [{ onState, setAdapterReconnecting }] = h.startReconnect.mock.calls[0];
    setAdapterReconnecting(true);
    Object.assign(h.conn, { rpcConnection: rpc });
    onState({ kind: 'recovered' });
    expect(h.setReconnecting).toHaveBeenLastCalledWith(false);
    expect(h.setReconnecting).toHaveBeenCalledBefore(h.resume);
    expect(h.resume).toHaveBeenCalledWith({ adapter: { list: expect.any(Function) }, rpcConnection: rpc, ignoreDirs: [] });
    expect(h.replayOfflineQueue).toHaveBeenCalledWith('after-reconnect');
  });

  it('ignores late reconnect callbacks after cancellation', async () => {
    const h = harness();
    h.settings.reconnectMaxRetries = 3;
    await h.p.startReconnect();
    const [{ onState }] = h.startReconnect.mock.calls[0];
    h.p.cancelReconnect();
    onState({ kind: 'recovered' });
    expect(h.p.state).toBe(SyncState.ERROR);
    expect(h.resume).not.toHaveBeenCalled();
    expect(h.replayOfflineQueue).not.toHaveBeenCalled();
    expect(recordedNotices()).toEqual(['Remote SSH: reconnect cancelled']);
  });

  it('uses the profile root when the same RPC adapter resumes over SFTP', async () => {
    const h = harness();
    h.settings.reconnectMaxRetries = 3;
    const list = vi.fn().mockResolvedValue([]);
    const client = { list } as unknown as RemoteFsClient;
    h.adapterMgr.dataAdapter = new SftpDataAdapter({} as RemoteFsClient, '', new ReadCache(), new DirCache(), 'vault');
    h.resume.mockImplementation(({ adapter }) => adapter.list('notes'));

    await h.p.startReconnect();
    const [retry] = h.startReconnect.mock.calls[0];
    retry.setAdapterReconnecting(true);
    retry.hooks.swapClient(client);
    retry.onState({ kind: 'recovered' });
    await h.resume.mock.results[0].value;
    expect(list).toHaveBeenCalledWith('/vault/notes');
  });

  it('rebinds an adapter installed during an automatic retry', async () => {
    const h = harness();
    h.settings.reconnectMaxRetries = 3;
    const adapter = { setReconnecting: vi.fn(), swapClient: vi.fn(), list: vi.fn() };
    h.adapterMgr.dataAdapter = null;
    await h.p.startReconnect();
    const [retry] = h.startReconnect.mock.calls[0];
    retry.setAdapterReconnecting(true);
    h.adapterMgr.dataAdapter = adapter;
    const client = {} as RemoteFsClient;
    retry.hooks.swapClient(client);
    retry.onState({ kind: 'recovered' });

    expect(adapter.swapClient).toHaveBeenCalledWith(client, '/vault');
    expect(adapter.setReconnecting.mock.calls).toEqual([[true], [false]]);
    expect(adapter.swapClient).toHaveBeenCalledBefore(h.resume);
    expect(h.p.state).toBe(SyncState.CONNECTED);
  });

  it('surfaces exhausted retries after the adapter is manually restored', async () => {
    const h = harness();
    h.settings.reconnectMaxRetries = 3;
    h.restore.mockImplementation(() => { h.adapterMgr.dataAdapter = null; });
    await h.p.startReconnect();
    const [retry] = h.startReconnect.mock.calls[0];
    h.p.debugRestoreAdapter();
    retry.onState({ kind: 'failed', reason: 'connection lost' });

    expect(h.p.state).toBe(SyncState.ERROR);
    expect(h.resume).not.toHaveBeenCalled();
  });
});
