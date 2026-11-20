import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/ui/RemoteTerminalView', () => ({
  RemoteTerminalView: class {}, VIEW_TYPE_REMOTE_TERMINAL: 'remote-terminal',
}));
import { App, clearNotices, recordedNotices } from 'obsidian';
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
  const conn = { activeProfile: profile, reconnectManager: { isActive: () => true }, rpcConnection: null,
    cancelReconnect: vi.fn(), startReconnect, disconnectTransport: vi.fn(async () => {}),
    isAlive: () => false };
  p.conn = conn;
  p.adapterMgr = { restore, isPatched: () => true, dataAdapter: { setReconnecting, list }, replayOfflineQueue };
  p.statusBar = { remove: vi.fn() };
  p.population = { stop, pause, resume };
  p.state = SyncState.IDLE;
  p.setState = vi.fn((state) => { p.state = state; });
  plugin.app.workspace.detachLeavesOfType = vi.fn();
  return { plugin, p, settings, conn, restore, stop, pause, resume, startReconnect, list, setReconnecting, replayOfflineQueue };
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
});
