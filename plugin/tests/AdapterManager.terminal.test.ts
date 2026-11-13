import { describe, expect, it, vi } from 'vitest';
vi.mock('../src/ui/RemoteTerminalView', () => ({
  RemoteTerminalView: class {}, VIEW_TYPE_REMOTE_TERMINAL: 'remote-terminal',
}));
import { App } from 'obsidian';
import RemoteSshPlugin from '../src/main';
import { SyncState } from '../src/types';

function harness() {
  const plugin = new RemoteSshPlugin(new App() as never);
  const restore = vi.fn();
  const startReconnect = vi.fn(async () => {});
  // Terminal wiring is intentionally tested with the lifetime owner substituted;
  // physical ownership is covered by AdapterManager.test.ts.
  const p = plugin as unknown as {
    settings: unknown; conn: unknown; adapterMgr: unknown; statusBar: unknown;
    state: SyncState; setState: (s: SyncState) => void;
    cancelReconnect(): void; startReconnect(): Promise<void>;
    onReconnectStateChange(s: unknown): void; debugRestoreAdapter(): void;
  };
  p.settings = { activeProfileId: null, reconnectMaxRetries: 0 };
  p.conn = { activeProfile: { id: 'p' }, reconnectManager: { isActive: () => true },
    cancelReconnect: vi.fn(), startReconnect, disconnectTransport: vi.fn(async () => {}),
    isAlive: () => false };
  p.adapterMgr = { restore, isPatched: () => true, dataAdapter: { setReconnecting: vi.fn() } };
  p.statusBar = { remove: vi.fn() };
  p.state = SyncState.IDLE;
  p.setState = vi.fn();
  plugin.app.workspace.detachLeavesOfType = vi.fn();
  return { plugin, p, restore, startReconnect };
}

describe('plugin terminal adapter lifetimes', () => {
  it('restores when reconnect is cancelled', () => {
    const h = harness(); h.p.cancelReconnect(); expect(h.restore).toHaveBeenCalledOnce();
  });
  it('restores when retries are disabled', async () => {
    const h = harness(); await h.p.startReconnect(); expect(h.restore).toHaveBeenCalledOnce();
    expect(h.startReconnect).not.toHaveBeenCalled();
  });
  it('restores when reconnect fails', () => {
    const h = harness(); h.p.onReconnectStateChange({ kind: 'failed', reason: 'connection lost' });
    expect(h.restore).toHaveBeenCalledOnce();
  });
  it('restores on disconnect', async () => {
    const h = harness(); await h.plugin.disconnect(); expect(h.restore).toHaveBeenCalledOnce();
  });
  it('restores synchronously on unload', async () => {
    const h = harness(); h.plugin.onunload(); expect(h.restore).toHaveBeenCalled();
    await Promise.resolve(); await Promise.resolve();
  });
  it('restores through the manual command', () => {
    const h = harness(); h.p.debugRestoreAdapter(); expect(h.restore).toHaveBeenCalledOnce();
  });
});
