import { Plugin, Notice, Modal, FileSystemAdapter, TFile, TFolder, requestUrl } from 'obsidian';
import type { PluginSettings, SshProfile } from './types';
import { SyncState } from './types';
import { DEFAULT_SETTINGS, DEFAULT_WALK_IGNORE_DIRS } from './constants';
import { SftpClient } from './ssh/SftpClient';
import { AuthResolver } from './ssh/AuthResolver';
import { HostKeyStore } from './ssh/HostKeyStore';
import { SecretStore } from './ssh/SecretStore';
import { KbdInteractiveModal } from './ui/KbdInteractiveModal';
import { HostKeyMismatchModal } from './ui/HostKeyMismatchModal';
import { PendingEditsBar } from './ui/PendingEditsBar';
import { RpcRemoteFsClient } from './adapter/RpcRemoteFsClient';
import { AdapterManager } from './adapter/AdapterManager';
import type { SftpDataAdapter } from './adapter/SftpDataAdapter';
import { establishRpcConnection } from './transport/RpcConnection';
import { ServerDeployer } from './transport/ServerDeployer';
import type { ReconnectState } from './transport/ReconnectManager';
import * as fs from 'fs';
import { StatusBar } from './ui/StatusBar';
import { ConnectModal } from './ui/ConnectModal';
import { RemoteTerminalView, VIEW_TYPE_REMOTE_TERMINAL } from './ui/RemoteTerminalView';
import { SettingsTab } from './settings/SettingsTab';
import { logger } from './util/logger';
import { classifyToNotice } from './transport/errorTaxonomy';
import { VaultModelBuilder } from './vault/VaultModelBuilder';
import { FsChangeListener } from './vault/FsChangeListener';
import { VaultPopulation, type PopulationProgress } from './vault/VaultPopulation';
import { RenameLeafFollower } from './vault/RenameLeafFollower';
import { ObsidianRegistry } from './shadow/ObsidianRegistry';
import { ShadowVaultBootstrap } from './shadow/ShadowVaultBootstrap';
import type { SharedConfigReader, BootstrapResult } from './shadow/ShadowVaultBootstrap';
import { SharedConfigWatcher } from './shadow/SharedConfigWatcher';
import { ShadowVaultManager } from './shadow/ShadowVaultManager';
import { WindowSpawner } from './shadow/WindowSpawner';
import { ShadowStartupCoordinator } from './shadow/ShadowStartupCoordinator';
import * as os from 'os';
import { ObservabilityInstaller } from './util/ObservabilityInstaller';
import { normalizeRemotePath } from './util/pathUtils';
import { PathMapper } from './path/PathMapper';
import { preSpawnRemotePath } from './shadow/preSpawnPaths';
import { withTimeout } from './util/withTimeout';
import * as path from 'path';
import { errorMessage } from "./util/errorMessage";
import { ConnectionManager, DaemonUnavailableError } from "./ConnectionManager";
import {
  detectRemoteTarget,
  ensureDaemonBinary as downloadDaemonBinary,
  resolveDaemonConsent,
  DaemonVerificationError,
  binaryFilename,
} from './transport/DaemonDownloader';
import { createHash } from 'crypto';
import { TransferTracker } from "./util/TransferTracker";
import { LargeTransferBar } from "./ui/LargeTransferBar";
import { OnboardingModal } from "./ui/OnboardingModal";
import { telemetry, telemetryLogPath } from "./util/Telemetry";

/** GitHub `owner/repo` the daemon binaries are released from. */
const DAEMON_RELEASE_REPO = 'sotashimozono/obsidian-remote-ssh';

/**
 * Everything this plugin keeps OUTSIDE any vault, on every OS:
 * `~/.obsidian-remote/` — the shadow `vaults/` themselves, plus the
 * per-device, never-synced `state/` (the community-plugins base
 * snapshots; see `ShadowVaultBootstrap.communityPluginsBasePath`).
 * `os.homedir()` resolves at runtime — no hardcoded user.
 */
const shadowStateRoot = (): string => path.join(os.homedir(), '.obsidian-remote');

/** Where shadow vaults live: `~/.obsidian-remote/vaults/`. */
const shadowVaultsDir = (): string => path.join(shadowStateRoot(), 'vaults');

export default class RemoteSshPlugin extends Plugin {
  settings: PluginSettings = DEFAULT_SETTINGS;

  private secretStore  = new SecretStore();
  private authResolver = new AuthResolver(this.secretStore);
  private hostKeyStore = new HostKeyStore();
  private conn!: ConnectionManager;
  private adapterMgr!: AdapterManager;
  private statusBar!: StatusBar;
  private state: SyncState = SyncState.IDLE;
  /**
   * Re-entrancy guard for `openShadowVaultFor`. A spawned shadow
   * window can take several seconds to surface, during which Obsidian
   * keeps the source window focused; without this, every impatient
   * Connect re-click re-bootstraps + re-fires `obsidian://open`,
   * producing the WindowSpawner churn observed in the field.
   *
   * Asymmetric by design: held ~15s only after a *successful* spawn
   * (debounce the double/triple-click while the new window surfaces);
   * cleared *synchronously* on a failed spawn so a genuine retry is
   * instant and the user is never stranded behind a stale
   * "still opening" toast.
   */
  private shadowSpawnInFlight = false;
  /**
   * Status-bar indicator for queued offline edits (E2-β.4). Hidden
   * when the queue is empty; click opens `PendingEditsModal`.
   */
  private pendingEditsBar!: PendingEditsBar;
  /**
   * Tracks in-flight large (>1 MB) file transfers so the StatusBar
   * can show the user something is happening (#127). Pure in-memory.
   */
  private transferTracker: TransferTracker = new TransferTracker();
  /** Status-bar indicator wired to the transferTracker. */
  private largeTransferBar: LargeTransferBar | null = null;
  /** Owns the daemon fs.watch subscription + notification dispatch. */
  private fsChangeListener!: FsChangeListener;
  /**
   * #342 push half: watches the shadow vault's local config dir and
   * pushes shared-config edits to the remote. Lives only for the
   * duration of a connected session (started after the connect pull,
   * stopped on disconnect/unload).
   */
  private sharedConfigWatcher: SharedConfigWatcher | null = null;
  private observability: ObservabilityInstaller | null = null;
  /**
   * #149 — re-entrant guard for `openRemoteTerminal()`. The
   * `addCommand` checkCallback doesn't debounce, so rapid command-
   * palette activations would otherwise both pass the
   * `getLeavesOfType(...).length === 0` check (because the first
   * call's `await leaf.setViewState` is still pending) and create
   * two terminal leaves with two RemoteShell channels.
   */
  private openingTerminal = false;

  async onload() {
    await this.loadSettings();

    logger.setDebug(this.settings.enableDebugLog);
    logger.setMaxLines(this.settings.maxLogLines);
    const adapter = this.app.vault.adapter;
    const basePath = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
    this.observability = new ObservabilityInstaller(this.manifest, basePath, this.app.vault.configDir);
    this.observability.install();

    // F22 — opt-in anonymous telemetry. Counters live next to other
    // plugin state under the vault's configDir. Wires no-op when
    // basePath is null (mobile / unusual builds) or the toggle is off.
    if (this.settings.telemetryEnabled && basePath) {
      void telemetry.setEnabled(
        true,
        telemetryLogPath(basePath, this.app.vault.configDir, this.manifest.id),
      );
    }

    this.fsChangeListener = new FsChangeListener(this.app);

    const client = new SftpClient(
      this.authResolver,
      this.hostKeyStore,
      (prompts) => new KbdInteractiveModal(this.app, prompts).prompt(),
      (info) => new HostKeyMismatchModal(this.app, info).prompt(),
    );
    client.onClose(({ unexpected }) => {
      if (unexpected) {
        new Notice('Remote SSH: connection lost — reconnecting…');
        void this.startReconnect();
      }
    });
    this.conn = new ConnectionManager(client, {
      locateDaemonBinary: () => this.locateDaemonBinary(),
      ensureDaemonBinary: (c) => this.ensureDaemonBinary(c),
    });
    this.conn.activeRemoteBasePath = null;

    this.addSettingTab(new SettingsTab(this.app, this));

    this.statusBar = new StatusBar(this, () => this.onStatusBarClick());
    this.statusBar.update(this.state);

    // Pending-edits indicator: shown only when the offline queue has
    // entries. Click opens the read-only listing + "discard all"
    // button. The bar starts hidden; replayOfflineQueue (inside
    // AdapterManager) and the queue-aware adapter writes call into
    // this bar's refresh helper.
    this.pendingEditsBar = new PendingEditsBar(this, () => void this.adapterMgr.showPendingEditsModal());

    // Large transfer indicator (#127) — shown only when >1 MB
    // file transfers are in flight. Subscribes to transferTracker.
    this.largeTransferBar = new LargeTransferBar(this, this.transferTracker);

    this.adapterMgr = new AdapterManager(
      this.app,
      this.manifest,
      this.conn,
      this.fsChangeListener,
      this.pendingEditsBar,
      () => this.settings,
      this.transferTracker,
    );

    // #341 follow-up: a writer rename reflects into the model fine,
    // but Obsidian's own post-adapter `Vault.rename` reconcile crashes
    // on this build and orphans the open tab. Own the editor-follow:
    // if the file was open and Obsidian dropped it, re-open it. Gated
    // by `isPatched` so an unconnected local vault is untouched.
    const renameFollower = new RenameLeafFollower(
      {
        isPathOpen: (p) =>
          this.app.workspace
            .getLeavesOfType('markdown')
            .some(
              (l) =>
                (l.view as unknown as { file?: { path?: string } } | undefined)
                  ?.file?.path === p,
            ),
        reopen: (p) => {
          const af = this.app.vault.getAbstractFileByPath(p);
          if (af instanceof TFile) {
            void this.app.workspace.getLeaf('tab').openFile(af);
          }
        },
      },
      () => this.adapterMgr.isPatched(),
      (cb) => { window.setTimeout(cb, 0); },
    );
    this.registerEvent(
      this.app.vault.on('rename', (file) => renameFollower.handleRename(file)),
    );

    this.addCommand({
      id: 'connect',
      name: 'Connect to remote vault',
      callback: () => this.promptConnect(),
    });

    this.addCommand({
      id: 'disconnect',
      name: 'Disconnect from remote vault',
      callback: () => this.disconnect(),
    });

    this.addCommand({
      id: 'cancel-reconnect',
      name: 'Cancel ongoing reconnect',
      checkCallback: (checking) => {
        const active = this.conn.reconnectManager?.isActive() ?? false;
        if (checking) return active;
        if (active) this.cancelReconnect();
        return true;
      },
    });

    this.addCommand({
      id: 'debug-patch-adapter',
      name: 'Debug: patch app.vault.adapter onto SFTP (read-side only)',
      callback: () => this.debugPatchAdapter(),
    });

    this.addCommand({
      id: 'debug-restore-adapter',
      name: 'Debug: restore app.vault.adapter to its original',
      callback: () => this.debugRestoreAdapter(),
    });

    this.addCommand({
      id: 'debug-list-root',
      name: 'Debug: list vault root via current adapter',
      callback: () => this.debugListRoot(),
    });

    this.addCommand({
      id: 'debug-test-rpc-tunnel',
      name: 'Debug: test daemon tunnel',
      callback: () => this.debugTestRpcTunnel(),
    });

    this.addCommand({
      id: 'reconnect',
      name: 'Reconnect to remote (shadow vault auto-connect)',
      checkCallback: (checking: boolean) => {
        // Only meaningful inside a shadow window (= a vault whose
        // data.json has the autoConnectProfileId marker). Outside
        // that, Reconnect doesn't have a target and the regular
        // Connect command applies.
        if (!this.settings.autoConnectProfileId) return false;
        if (!checking) void this.runAutoConnect('reconnect');
        return true;
      },
    });

    this.addCommand({
      id: 'show-onboarding',
      name: 'Set up first remote vault',
      callback: () => this.showOnboarding(),
    });

    // #149 — terminal pane. View registered unconditionally so a
    // shadow vault that's still warming up can re-open a leaf saved
    // in workspace.json before the connection completes; the View
    // itself handles the disconnected state.
    this.registerView(VIEW_TYPE_REMOTE_TERMINAL, leaf => new RemoteTerminalView(leaf, {
      getClient: () => this.conn.client.isAlive() ? this.conn.client : null,
      settings: this.settings,
    }));

    this.addCommand({
      id: 'open-terminal',
      name: 'Open remote terminal',
      checkCallback: (checking) => {
        const ready = this.conn.client.isAlive();
        if (checking) return ready;
        if (ready) void this.openRemoteTerminal();
        return true;
      },
    });

    // Phase 4 + 6C-prep: if this vault was opened with an
    // autoConnectProfileId marker (= a shadow vault from
    // `ShadowVaultBootstrap`):
    //   1. install any plugins listed in community-plugins.json that
    //      aren't yet on disk (marketplace download via
    //      `app.plugins.installPlugin`),
    //   2. then connect to the remote and populate the file model.
    // Done inside `onLayoutReady` so we wait for Obsidian's own
    // vault initialization to finish before touching plugins or the
    // adapter.
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.autoConnectProfileId) {
        this.installExpandHook();
        void this.runShadowStartup();
        return;
      }
      // F17 — first-launch onboarding. Opens the wizard when the user
      // has no profiles yet AND hasn't dismissed onboarding before.
      // Skipped on shadow vaults (auto-connect path above).
      if (this.settings.profiles.length === 0 && !this.settings.onboardingCompleted) {
        this.showOnboarding();
      }
    });
  }

  private showOnboarding() {
    new OnboardingModal(
      this.app,
      this.getProfileFormDeps(),
      async ({ profile, dismissOnboarding }) => {
        // Single coalesced saveSettings — push profile + flip the
        // dismiss flag in one disk write rather than two (M2 from
        // PR #222 review).
        let dirty = false;
        if (profile) {
          this.settings.profiles.push(profile);
          dirty = true;
        }
        if (dismissOnboarding && !this.settings.onboardingCompleted) {
          this.settings.onboardingCompleted = true;
          dirty = true;
        }
        if (dirty) await this.saveSettings();
      },
    ).open();
  }

  /**
   * Shadow window startup orchestration: prompt the user about any
   * pending plugin suggestions captured at bootstrap, fill in any
   * binaries missing from the shadow's community-plugins.json (safety
   * net for re-bootstraps), then auto-connect. Split from
   * `runAutoConnect` so the Reconnect command can re-run just the
   * connect half without re-fetching anything.
   */
  private async runShadowStartup(): Promise<void> {
    const attempt = this.stopPopulation();
    const coordinator = new ShadowStartupCoordinator(
      this.app, this.settings, () => this.saveSettings(),
    );
    await coordinator.prepareForAutoConnect();
    if (attempt === this.startupRevision) await this.runAutoConnect('layout-ready', attempt);
  }

  onunload() {
    // disconnect restores the adapter synchronously before transport teardown.
    void this.disconnect().catch(() => { /* ignore */ });
    this.statusBar?.remove();
    this.pendingEditsBar?.remove();
    this.largeTransferBar?.remove();
    this.observability?.uninstall();
    // F22 — flush any in-memory counters before the process tears down.
    void telemetry.setEnabled(false);
  }

  async loadSettings() {
    // `loadData()` returns `any`; cast through a known shape so downstream
    // accessors are typed. The fields we actually consume here are the
    // host-key map and the encrypted-secrets blob; everything else flows
    // into `Object.assign(...DEFAULT_SETTINGS, saved)` and is shape-checked
    // by `PluginSettings`.
    const saved = (await this.loadData()) as Partial<PluginSettings> & {
      hostKeyStore?: Record<string, string>;
      secrets?: Parameters<SecretStore['load']>[0];
    } | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved ?? {});
    // Migration (Phase 5): the old `autoPatchAdapter` field is gone
    // — Object.assign above doesn't pick it up because it's not in
    // DEFAULT_SETTINGS, but a stray copy could survive in saved data
    // and reappear via `saveData(...this.settings...)`. Force-strip
    // it via the cast so saveSettings doesn't write it back.
    delete (this.settings as unknown as Record<string, unknown>).autoPatchAdapter;
    // We never come back online already connected; activeProfileId from disk
    // is stale on startup and only confuses the settings UI.
    this.settings.activeProfileId = null;
    if (saved?.hostKeyStore) {
      this.hostKeyStore.load(saved.hostKeyStore);
    }
    if (saved?.secrets) {
      this.secretStore.load(saved.secrets);
    }
  }

  /** Expose auth deps for the ProfileForm's Browse button. */
  getProfileFormDeps() {
    return { authResolver: this.authResolver, hostKeyStore: this.hostKeyStore };
  }

  /** Daemon status for the settings panel. */
  getDaemonStatus(): { status: 'running' | 'down' | 'none'; version?: string; capabilities?: number } {
    if (!this.conn.rpcConnection) return { status: 'none' };
    try {
      const info = this.conn.rpcConnection.info;
      return { status: 'running', version: info.version, capabilities: info.capabilities.length };
    } catch {
      return { status: 'down' };
    }
  }

  /** Read the last N lines of the daemon log from the remote. */
  async readDaemonLog(lines = 50): Promise<string> {
    if (!this.conn.isAlive()) throw new Error('Not connected');
    const r = await this.conn.client.exec(`tail -n ${lines} ~/.obsidian-remote/server.log 2>/dev/null || echo '(no log file)'`);
    return r.stdout;
  }

  /** Restart the daemon: stop existing + redeploy. */
  async restartDaemon(): Promise<void> {
    const profile = this.conn.activeProfile;
    const basePath = this.conn.activeRemoteBasePath;
    if (!profile || !basePath) throw new Error('No active profile');
    if (this.conn.daemonDeployer && this.conn.isAlive()) {
      try { await this.conn.daemonDeployer.stop(); } catch { /* best effort */ }
    }
    if (this.conn.rpcConnection) {
      try { this.conn.rpcConnection.close(); } catch { /* already dead */ }
      this.conn.rpcConnection = null;
    }
    this.conn.daemonDeployer = null;
    await this.conn.startRpcSession(profile, basePath);
    // Rebind adapter to the fresh RPC client
    this.adapterMgr.dataAdapter?.swapClient(this.conn.buildFsClient());
  }

  async saveSettings() {
    await this.saveData({
      ...this.settings,
      hostKeyStore: this.hostKeyStore.serialize(),
      secrets: this.secretStore.serialize(),
    });
  }

  async connectProfile(profile: SshProfile, attempt = this.startupRevision) {
    if (this.conn.isAlive()) {
      new Notice('Remote SSH: already connected. Disconnect first.');
      return;
    }
    this.setState(SyncState.CONNECTING);
    try {
      await this.conn.connectSsh(profile);
    } catch (e) {
      if (attempt !== this.startupRevision) return;
      this.setState(SyncState.ERROR);
      const { notice, classified } = classifyToNotice(e);
      logger.error(`Connect failed: ${classified.title}`, {
        category: classified.category, code: classified.code,
        original: classified.original.message, profileId: profile.id,
      });
      new Notice(notice);
      try { await this.conn.client.disconnect(); } catch { /* ignore */ }
      return;
    }
    if (attempt !== this.startupRevision) return;

    let transport = profile.transport ?? 'sftp';
    let rpcSummary = '';
    if (transport === 'rpc') {
      try {
        await this.conn.startRpcSession(profile, this.conn.activeRemoteBasePath!);
        const caps = this.conn.rpcConnection?.info.capabilities.length ?? 0;
        const ver  = this.conn.rpcConnection?.info.version ?? '?';
        rpcSummary = ` — daemon ${ver}, ${caps} capabilities`;
      } catch (e) {
        if (attempt !== this.startupRevision) return;
        // The daemon is an optimization layer, not a requirement. Most
        // failures to bring it up degrade to SFTP rather than failing the
        // whole connect — a hard failure skips populate and strands the user
        // on an EMPTY vault. SFTP shares the same live SSH channel, so
        // read/write/sync still work (minus daemon-only features: fast walk,
        // thumbnails, live watch, image/PDF rendering).
        //
        // EXCEPTION: a daemon binary that fails integrity verification
        // (checksum mismatch / bad manifest) fails LOUD and does NOT
        // downgrade — silently falling back could mask a tampered or corrupt
        // binary (supply-chain safety, #406).
        if (e instanceof DaemonVerificationError) {
          this.setState(SyncState.ERROR);
          const { notice, classified } = classifyToNotice(e);
          logger.error(`RPC startup failed (verification): ${classified.title}`, {
            category: classified.category, code: classified.code,
            original: classified.original.message, profileId: profile.id,
          });
          new Notice(notice);
          try { await this.conn.client.disconnect(); } catch { /* ignore */ }
          return;
        }
        if (e instanceof DaemonUnavailableError) {
          // Expected: unsupported remote arch, or the user declined download.
          logger.warn(`RPC unavailable, falling back to SFTP: ${e.message}`);
          new Notice('Remote SSH: daemon unavailable — connected via SFTP (reduced features).');
        } else {
          // Unexpected daemon-start failure (deploy / token-write timeout /
          // handshake mismatch). Log the classified cause for diagnosis, but
          // still degrade to SFTP instead of leaving the vault empty.
          const { classified } = classifyToNotice(e);
          logger.warn(`RPC startup failed, falling back to SFTP: ${classified.title}`, {
            category: classified.category, code: classified.code,
            original: classified.original.message, profileId: profile.id,
          });
          new Notice('Remote SSH: daemon failed to start — connected via SFTP (reduced features). See console.log.');
        }
        transport = 'sftp';
      }
    }

    if (attempt !== this.startupRevision) return;
    this.setState(SyncState.CONNECTED);
    this.settings.activeProfileId = profile.id;
    await this.saveSettings();
    if (attempt !== this.startupRevision) return;

    const patched = await this.adapterMgr.patch();
    if (attempt !== this.startupRevision) return;
    if (!patched) {
      new Notice('Remote SSH: adapter patch failed — disconnecting');
      void this.disconnect().catch(() => { /* already errored */ });
      return;
    }

    const userLabel = ConnectionManager.formatUserLabel(this.settings);
    new Notice(
      `Remote SSH: Connected to ${profile.name} as ${userLabel} via ${transport.toUpperCase()}${rpcSummary}`,
    );
    void this.adapterMgr.replayOfflineQueue('after-connect');
  }

  /**
   * Phase 4 entry point: connect to the profile pointed at by
   * `settings.autoConnectProfileId`, then populate the empty shadow
   * vault from the remote tree via `VaultPopulation`. Called once
   * on `onLayoutReady` and again from the `Reconnect` command.
   *
   * `tag` shows up in the log line so we can tell whether a given
   * run came from the layout-ready hook or a manual reconnect.
   */
  private async runAutoConnect(
    tag: 'layout-ready' | 'reconnect', attempt = this.stopPopulation(),
  ): Promise<void> {
    const profileId = this.settings.autoConnectProfileId;
    if (!profileId) return;
    const profile = this.settings.profiles.find(p => p.id === profileId);
    if (!profile) {
      logger.warn(
        `runAutoConnect(${tag}): autoConnectProfileId=${profileId} but no matching ` +
        'profile in data.json; skipping',
      );
      new Notice(
        `Remote SSH: shadow-vault profile id ${profileId} not found in data.json — ` +
        'cannot auto-connect',
      );
      return;
    }

    // Connection setup uses the shared ConnectionManager. Let superseded
    // setup finish before a replacement can reuse or tear down its transport.
    if (this.connecting) await this.connecting.catch(() => {});
    if (this.disconnecting) await this.disconnecting.catch(() => {});
    if (attempt !== this.startupRevision) return;

    if (this.conn.isAlive() || this.conn.reconnectManager?.isActive()) {
      logger.info(`runAutoConnect(${tag}): client already alive — disconnecting first`);
      const plannedDisconnect = this.disconnect();
      const teardown = this.startupRevision;
      await plannedDisconnect.catch(() => {});
      if (teardown !== this.startupRevision) return;
      attempt = this.stopPopulation();
    }

    logger.info(`runAutoConnect(${tag}): connecting to profile ${profile.name}`);
    const connecting = this.connectProfile(profile, attempt);
    this.connecting = connecting;
    try {
      await connecting;
    } finally {
      if (this.connecting === connecting) this.connecting = null;
    }
    if (attempt !== this.startupRevision) return;

    const da = this.adapterMgr.dataAdapter;
    if (!da || (this.state !== SyncState.CONNECTED && this.state !== SyncState.RECONNECTING)) {
      // A shadow-window auto-connect failed. `connectProfile` ALREADY
      // emitted a classified, cause-specific Notice (auth / host /
      // remote-path / patch) into THIS same shadow window on every
      // failure path — a second generic toast here just stacks on top
      // of it and pushes the specific cause off-screen. Keep the log
      // line (the diagnostic trail the e2e oracle asserts on); do not
      // double-Notice.
      logger.warn(
        `runAutoConnect(${tag}): connect did not reach CONNECTED state ` +
        `(connectProfile surfaced the cause); skipping populate`,
      );
      return;
    }

    // Pull this device's Obsidian config (app.json / appearance.json /
    // core-plugins.json / hotkeys.json — now per-client via PathMapper)
    // from the remote onto the local shadow disk *before* the populate, so
    // the next time this window restarts Obsidian reads fresh settings
    // instead of the stale local copy (#342). Best-effort: a failure here
    // must not block rendering the vault.
    const isCurrent = () => attempt === this.startupRevision && this.adapterMgr.dataAdapter === da;
    const hostAdapter = this.app.vault.adapter;
    if (hostAdapter instanceof FileSystemAdapter) {
      const localConfigDir = path.join(
        hostAdapter.getBasePath(), this.app.vault.configDir,
      );
      const remoteConfigDir = this.app.vault.configDir;
      try {
        const cfg = await ShadowVaultBootstrap.pullSharedObsidianConfig(
          da, remoteConfigDir, localConfigDir,
        );
        if (!isCurrent()) return;
        if (cfg.errored.length > 0) {
          // The connection is up but some shared-config files the
          // remote *had* couldn't be pulled (transient SSH error /
          // corrupt file). Without a signal the user would just see
          // settings silently not update — the #342 symptom. Absent
          // files are not errored, so a fresh vault stays quiet.
          new Notice(
            `Remote SSH: ${cfg.errored.length} config file` +
            `${cfg.errored.length === 1 ? '' : 's'} (${cfg.errored.join(', ')}) ` +
            'could not be synced — settings may be stale until the next connect',
          );
        }
      } catch (e) {
        if (!isCurrent()) return;
        logger.warn(
          `runAutoConnect(${tag}): shared-config pull failed: ${errorMessage(e)}`,
        );
      }

      // #429 / #342 residual: round-trip the enabled community-plugins
      // list. Pull first so plugins set up on the remote load in the
      // shadow vault (the marketplace installer then fetches any missing
      // binaries); then push the converged result so a plugin enabled —
      // or UNINSTALLED — only here reaches the remote for other machines.
      // Kept out of the verbatim shared-config set because `remote-ssh`
      // must be force-preserved through the merge (a verbatim copy of a
      // remote list omitting it would disable this very plugin).
      //
      // Both halves take this device's BASE snapshot: the converged list
      // as of the last successful round-trip HERE. It is what turns the
      // old monotonic union into a real 3-way merge, so a local uninstall
      // propagates instead of being resurrected by the next pull. The
      // pull only reads it; the push commits it once both sides agree.
      const cpBasePath = ShadowVaultBootstrap.communityPluginsBasePath(
        shadowStateRoot(), profile.id,
      );
      try {
        await ShadowVaultBootstrap.pullCommunityPlugins(da, remoteConfigDir, localConfigDir, cpBasePath);
        if (isCurrent()) await ShadowVaultBootstrap.pushCommunityPlugins(da, remoteConfigDir, localConfigDir, cpBasePath);
      } catch (e) {
        logger.warn(
          `runAutoConnect(${tag}): community-plugins round-trip failed: ${errorMessage(e)}`,
        );
      }
      if (!isCurrent()) return;

      // #429b: the startup installer (prepareForAutoConnect) ran BEFORE
      // the pull above — and not at all on a reconnect — so a plugin the
      // pull just added to community-plugins.json has no binary staged yet
      // and won't load. Re-run the marketplace installer now the list is
      // current; `enablePluginAndSave` loads a marketplace plugin live, no
      // restart. Idempotent (already-installed ids are skipped). BRAT /
      // non-marketplace plugins still need their binary on the remote.
      try {
        await new ShadowStartupCoordinator(this.app, this.settings, () => this.saveSettings())
          .installMissingShadowPlugins();
      } catch (e) {
        logger.warn(`runAutoConnect(${tag}): post-pull plugin install failed: ${errorMessage(e)}`);
      }
      if (!isCurrent()) return;

      // #429b binary round-trip: the marketplace installer above can't
      // fetch a BRAT / sideloaded plugin (it isn't on the registry). Run
      // AFTER the installer so the plugins it just fetched are on disk —
      // the pull then only stages what's STILL missing (the non-market
      // ones), which keeps the installer's live load intact and also
      // acts as a fallback if a marketplace fetch failed. The push makes
      // the remote `.obsidian/plugins/` a complete vault so every machine
      // can pull. A pulled binary loads on the next vault open (Obsidian
      // scans the plugins dir at startup).
      try {
        const enabledIds = ShadowVaultBootstrap.readEnabledPluginIds(localConfigDir);
        await ShadowVaultBootstrap.pullPluginBinaries(da, remoteConfigDir, localConfigDir, enabledIds);
        if (isCurrent()) await ShadowVaultBootstrap.pushPluginBinaries(da, remoteConfigDir, localConfigDir, enabledIds);
      } catch (e) {
        logger.warn(`runAutoConnect(${tag}): plugin-binary round-trip failed: ${errorMessage(e)}`);
      }
      if (!isCurrent()) return;

      // #342 push half: pull only brought remote→local. Without this,
      // a settings change made HERE never reaches the remote, so the
      // next session's pull finds nothing and the change evaporates.
      // Watch the local config dir and push divergent shared files.
      this.sharedConfigWatcher?.stop();
      const watcher = new SharedConfigWatcher({
        watch: (onChange) => {
          const w = fs.watch(
            localConfigDir, { persistent: false },
            (_evt, filename) => onChange(filename ? String(filename) : null),
          );
          return { close: () => w.close() };
        },
        readLocal: (b) => {
          try { return fs.readFileSync(path.join(localConfigDir, b), 'utf-8'); }
          catch { return null; }
        },
        flush: async () => {
          const r = await ShadowVaultBootstrap.pushSharedObsidianConfig(
            da, remoteConfigDir, localConfigDir,
          );
          if (r.errored.length > 0) {
            new Notice(
              `Remote SSH: ${r.errored.length} config file` +
              `${r.errored.length === 1 ? '' : 's'} (${r.errored.join(', ')}) ` +
              'could not be pushed — settings change not yet saved remotely',
            );
          }
        },
        debounceMs: 1500,
        setTimer: (cb, ms) => window.setTimeout(cb, ms),
        clearTimer: (h) => window.clearTimeout(h as number),
      });
      // Seed the just-pulled bytes as the synced baseline so the
      // pull's own writes (and Obsidian re-saving an identical file
      // on open) don't immediately echo back to the remote.
      for (const base of ShadowVaultBootstrap.SHARED_OBSIDIAN_CONFIG_FILES) {
        try {
          watcher.markSynced(
            base, fs.readFileSync(path.join(localConfigDir, base), 'utf-8'),
          );
        } catch { /* absent locally — nothing to baseline */ }
      }
      watcher.start();
      this.sharedConfigWatcher = watcher;

    }

    const population = new VaultPopulation({
      lazy: this.settings.lazyFolderLoad !== false,
      builder: new VaultModelBuilder(this.app.vault, { TFile, TFolder }),
      onProgress: (p) => {
        if (isCurrent() && this.population === population) this.onPopulationProgress(p);
      },
    });
    this.population = population;
    if (!da.isReconnecting()) this.resumePopulation(da);
    try {
      const result = await population.populate(`shadow-${tag}`);
      if (!isCurrent() || result.kind === 'cancelled' || this.state !== SyncState.CONNECTED) return;
      if (result.kind === 'incomplete') {
        const detail = result.truncated ? 'the remote listing was truncated' : result.summary;
        new Notice(`Remote SSH: vault population incomplete — ${detail}. See console.log.`, 15_000);
        return;
      }
      if (result.entries === 0) {
        new Notice(
          result.hiddenCount > 0
            ? `Remote SSH: 0 visible files — all ${result.hiddenCount} walked entries are hidden dot-files.`
            : 'Remote SSH: 0 files found on the remote. Check the profile’s remotePath.',
          10_000,
        );
      }
      new Notice(`Remote SSH: ${profile.name} ready — ${result.summary}`);
    } catch (e) {
      if (!isCurrent()) return;
      const msg = errorMessage(e);
      logger.error(`runAutoConnect(${tag}): populate failed: ${msg}`);
      new Notice(`Remote SSH: connected but failed to populate vault — ${msg}`);
    }
  }

  private cancelReconnect(): void {
    if (!this.conn.reconnectManager?.isActive()) return;
    this.restoreAdapter();
    this.conn.cancelReconnect();
    this.setState(SyncState.ERROR);
    new Notice('Remote SSH: reconnect cancelled');
  }

  private async startReconnect(): Promise<void> {
    this.population?.pause();
    if (!this.conn.activeProfile) {
      logger.warn('startReconnect: no active profile to reconnect with');
      this.restoreAdapter();
      this.setState(SyncState.ERROR);
      return;
    }
    const maxRetries = this.settings.reconnectMaxRetries ?? DEFAULT_SETTINGS.reconnectMaxRetries;
    if (maxRetries <= 0) {
      logger.info('startReconnect: auto-reconnect disabled (reconnectMaxRetries <= 0)');
      this.restoreAdapter();
      this.setState(SyncState.ERROR);
      return;
    }
    if (this.reconnectRun) return;
    const run = {};
    this.reconnectRun = run;
    const da = this.adapterMgr.dataAdapter;
    const isCurrent = () => this.reconnectRun === run && this.adapterMgr.dataAdapter === da;
    this.setState(SyncState.RECONNECTING);
    await this.conn.startReconnect({
      maxRetries,
      setAdapterReconnecting: (on) => { if (isCurrent()) da?.setReconnecting(on); },
      onState: (s) => { if (isCurrent()) this.onReconnectStateChange(s); },
      hooks: {
        swapClient: (c) => { if (isCurrent()) da?.swapClient(c); },
        prepareListenerForReconnect: () => { if (isCurrent()) this.fsChangeListener.prepareForReconnect(); },
        resumeListenerAfterReconnect: async (rpc) => {
          if (da && isCurrent()) {
            await this.fsChangeListener.resumeAfterReconnect({
              rpcConnection: rpc,
              dataAdapter: da,
            });
          }
        },
      },
    });
  }

  /**
   * Project the manager's state onto the StatusBar + Notice surface
   * and, on terminal states, clean up.
   */
  private onReconnectStateChange(s: ReconnectState): void {
    // F22 — opt-in telemetry. No-op when disabled.
    telemetry.recordReconnect(s.kind);
    if (s.kind === 'waiting') {
      const seconds = Math.max(1, Math.round(s.delayMs / 1000));
      this.statusBar.update(
        SyncState.RECONNECTING,
        `Remote SSH: Reconnecting (${s.attempt}/${s.totalAttempts}) in ${seconds}s…`,
      );
    } else if (s.kind === 'attempting') {
      this.statusBar.update(
        SyncState.RECONNECTING,
        `Remote SSH: Reconnecting (attempt ${s.attempt}/${s.totalAttempts})…`,
      );
    } else if (s.kind === 'recovered') {
      const da = this.adapterMgr.dataAdapter;
      da?.setReconnecting(false);
      this.setState(SyncState.CONNECTED);
      if (da) this.resumePopulation(da);
      new Notice('Remote SSH: reconnected');
      this.reconnectRun = null;
      this.conn.reconnectManager = null;
      // Drain any writes that landed during the disconnect. Fire-and-
      // forget: the user's already-back state is independent of the
      // replay outcome, and individual op failures stay in the queue
      // for the next reconnect.
      void this.adapterMgr.replayOfflineQueue('after-reconnect');
    } else if (s.kind === 'failed') {
      // Give up: tear the patched adapter down so Obsidian falls
      // back to local file:// reads instead of blocking forever on a
      // dead transport. restore() clears dataAdapter so the
      // setReconnecting flag goes with it.
      this.restoreAdapter();
      this.setState(SyncState.ERROR);
      // s.reason is a string from ReconnectManager; wrap into Error
      // so classifyError can run pattern matching on the message
      // (e.g. host-key / timeout substrings still get caught).
      const { notice, classified } = classifyToNotice(new Error(s.reason));
      logger.error(`Reconnect failed: ${classified.title}`, {
        category: classified.category,
        code: classified.code,
        original: s.reason,
      });
      new Notice(notice);
      this.conn.reconnectManager = null;
    } else if (s.kind === 'cancelled') {
      this.restoreAdapter();
      this.conn.reconnectManager = null;
    }
  }

  /**
   * Idempotent: it always restores the adapter, drops the active SSH
   * client, clears `activeProfileId`, and parks the state machine on
   * IDLE. Calling it from a stale UI button (where state was already
   * IDLE because the plugin had just reloaded) is a supported flow.
   */
  disconnect(): Promise<void> {
    const wasActive = this.state !== SyncState.IDLE
      || this.conn.isAlive()
      || this.settings.activeProfileId !== null;
    this.restoreAdapter();
    this.conn.cancelReconnect();
    if (this.disconnecting) return this.disconnecting;
    // #149 — close the terminal pane(s) before tearing the SSH
    // session down so the shell channel close fires while the ssh2
    // Client is still around (cleaner teardown logs).
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_REMOTE_TERMINAL);
    const disconnecting = this.finishDisconnect(wasActive).finally(() => {
      this.disconnecting = null;
    });
    this.disconnecting = disconnecting;
    return disconnecting;
  }

  private async finishDisconnect(wasActive: boolean): Promise<void> {
    if (this.connecting) await this.connecting.catch(() => {});
    await this.conn.disconnectTransport();
    this.setState(SyncState.IDLE);
    if (this.settings.activeProfileId !== null) {
      this.settings.activeProfileId = null;
      await this.saveSettings();
    }
    if (wasActive) new Notice('Remote SSH: disconnected');
  }

  /**
   * Open or reveal the remote terminal pane in the right sidebar.
   * Re-using an existing leaf keeps the shell channel alive across
   * focus changes; opening a fresh leaf each time would reset
   * scrollback and lose any in-flight commands.
   *
   * Uses `setActiveLeaf` rather than `revealLeaf` because the latter
   * requires Obsidian v1.7.2 and our manifest declares
   * `minAppVersion: 1.4.0` — `setActiveLeaf` has the same observable
   * effect (focus + render) and has been stable since pre-1.0.
   */
  async openRemoteTerminal(): Promise<void> {
    if (this.openingTerminal) return;
    this.openingTerminal = true;
    try {
      const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_REMOTE_TERMINAL);
      if (existing.length > 0) {
        this.app.workspace.setActiveLeaf(existing[0], { focus: true });
        return;
      }
      const leaf = this.app.workspace.getRightLeaf(false);
      if (!leaf) {
        new Notice('Remote SSH: no available workspace leaf to open the terminal in');
        return;
      }
      await leaf.setViewState({ type: VIEW_TYPE_REMOTE_TERMINAL, active: true });
      this.app.workspace.setActiveLeaf(leaf, { focus: true });
    } finally {
      this.openingTerminal = false;
    }
  }

  private population: VaultPopulation | null = null;
  private startupRevision = 0;
  private connecting: Promise<void> | null = null;
  private disconnecting: Promise<void> | null = null;
  private reconnectRun: object | null = null;

  private stopPopulation(): number {
    this.startupRevision++;
    this.population?.stop();
    this.population = null;
    return this.startupRevision;
  }

  private restoreAdapter(): void {
    const hadPopulation = this.population !== null;
    this.stopPopulation();
    this.reconnectRun = null;
    // The config watcher pushes through the adapter being restored.
    this.sharedConfigWatcher?.stop();
    this.sharedConfigWatcher = null;
    this.adapterMgr.restore();
    if (hadPopulation && this.state === SyncState.CONNECTED) this.statusBar?.update(this.state);
  }

  private resumePopulation(da: SftpDataAdapter): void {
    this.population?.resume({
      adapter: { list: da.list.bind(da) },
      rpcConnection: this.conn.rpcConnection ?? undefined,
      // An explicit empty ignore list is valid. Older profiles use the defaults.
      ignoreDirs: this.conn.activeProfile?.walkIgnoreDirs ?? [...DEFAULT_WALK_IGNORE_DIRS],
    });
  }

  private onPopulationProgress(p: PopulationProgress): void {
    if (this.state !== SyncState.CONNECTED) return;
    if (p.kind === 'indexing') {
      this.statusBar?.update(SyncState.CONNECTED, `Remote SSH: Indexing… ${p.files} files`);
      return;
    }
    this.statusBar?.update(SyncState.CONNECTED);
    if (p.kind === 'incomplete') {
      new Notice('Remote SSH: vault index incomplete — some folders are still retryable. See console.log.');
    } else if (p.files + p.folders > 0) {
      new Notice(
        `Remote SSH: vault index complete — ${p.files} files, ${p.folders} folders. ` +
        'Search, graph and links now cover the whole vault.',
      );
    }
  }

  /**
   * Obsidian renders File Explorer from its model and exposes no public folder
   * expand event. One delegated listener serves all population lifetimes.
   */
  private installExpandHook(): void {
    this.registerDomEvent(activeDocument, 'click', (evt) => {
      const title = (evt.target as HTMLElement | null)?.closest?.('.nav-folder-title');
      const path = title?.getAttribute('data-path');
      if (path != null) void this.population?.expand(path);
    }, { capture: true });
  }

  /**
   * Settings UI Connect button handler (Phase 3) and the underlying
   * implementation of the shadow-vault flow.
   *
   * Bootstraps the shadow vault for `profile` (creates the dir,
   * installs the plugin per-file, writes data.json with the
   * auto-connect marker, registers the path in obsidian.json) and
   * opens it in a new Obsidian window via the
   * `obsidian://open?path=…` URL scheme.
   *
   * Does NOT require an SSH connection — the shadow vault setup is
   * a local-disk operation; the connect happens later, inside the
   * shadow window (Phase 4).
   */
  async openShadowVaultFor(profile: SshProfile): Promise<void> {
    // Connect clicked from INSIDE the shadow window for this same
    // profile (Settings row button / connect modal). This vault IS the
    // shadow — there is no second window to spawn, and re-running the
    // bootstrap from here would make installPlugin's rm+symlink cycle
    // target its own files (src == dst), turning main.js/manifest.json
    // into self-referential symlinks that brick the install on the
    // next start. Reconnect in place instead.
    if (this.settings.autoConnectProfileId === profile.id) {
      await this.runAutoConnect('reconnect');
      return;
    }

    // Source dir: where this running plugin lives, so the shadow
    // vault's plugin install symlinks the same bundle.
    const sourcePluginDir = this.pluginDir();
    if (!sourcePluginDir) {
      new Notice('Remote SSH: vault is not file-system-backed; cannot locate plugin source');
      return;
    }

    // The spawned window can take several seconds to surface while
    // Obsidian keeps THIS (source) window focused. Without this guard
    // an impatient re-click re-bootstraps + re-fires obsidian://open,
    // and the user just sees more churn — never the new window.
    if (this.shadowSpawnInFlight) {
      new Notice('Remote SSH: the remote vault is still opening — give it a moment');
      return;
    }
    this.shadowSpawnInFlight = true;

    // Shadow vaults live under ~/.obsidian-remote/vaults/ on every OS,
    // alongside ~/.obsidian-remote/state/ (never-synced per-device state).
    const registry = new ObsidianRegistry(ObsidianRegistry.defaultConfigPath());
    const bootstrap = new ShadowVaultBootstrap(
      shadowVaultsDir(), sourcePluginDir, registry, shadowStateRoot(),
    );
    const spawner = new WindowSpawner();
    const manager = new ShadowVaultManager(bootstrap, spawner);

    try {
      // #399: flush the in-memory SecretStore to the SOURCE data.json
      // BEFORE the bootstrap reads it. A password typed in ConnectModal
      // lives only in `secretStore` memory until a save; without this
      // the bootstrap seeds the shadow vault with empty secrets and its
      // auto-connect fails with "No password stored for profile",
      // opening an empty vault. Also persists the profile's freshly-set
      // passwordRef. On the Settings-button path (no password typed)
      // this is a harmless idempotent re-write of the current settings.
      // A transient save failure must NOT abort the spawn (the shadow
      // may still connect from previously-persisted secrets), so it is
      // logged and swallowed rather than surfaced as a spawn failure.
      try {
        await this.saveSettings();
      } catch (e) {
        logger.warn(`openShadowVaultFor: pre-spawn settings flush failed (${errorMessage(e)}); continuing to spawn`);
      }

      const result = await manager.openShadowFor(
        profile, this.settings.profiles,
        // #429b / Phase B-3: pull canonical .obsidian/ before the window
        // boots. Best-effort + time-boxed inside preSpawnPull; the manager
        // swallows any throw so a slow/failed pull never blocks the spawn.
        (r) => this.preSpawnPull(profile, r),
      );
      const how = result.pluginInstallMethod;
      const reg = result.registryCreated ? 'newly registered' : result.migrated ? 'migrated' : 'reused';
      logger.info(
        `openShadowVaultFor: profile=${profile.name}, vault=${result.layout.vaultDir}, ` +
        `registry id=${result.registryId} (${reg}), plugin=${how}`,
      );
      if (result.registryCreated || result.migrated) {
        // The vault's path in obsidian.json is new to the already-running
        // Obsidian (it only reads that file at startup), so the
        // obsidian://open we just fired is a no-op and no window appears.
        // This happens on a profile's first-ever open (registryCreated) and
        // the one-time legacy→friendly dir rename (migrated). Surface a
        // PERSISTENT notice (duration 0) telling the user to restart, rather
        // than the misleading "opened in new window" that never opened.
        const why = result.registryCreated
          ? `"${profile.name}" is a newly registered vault.`
          : `"${profile.name}" was renamed to a friendlier vault name.`;
        new Notice(
          `Remote SSH: ${why} Obsidian only loads vaults at startup, so it cannot ` +
          'open it this session — fully quit and reopen Obsidian, then click Connect ' +
          'again. (One-time.)',
          0,
        );
      } else {
        new Notice(`Remote SSH: opened ${profile.name} in new window (${how})`);
      }
      // Spawn SUCCEEDED. The new window can take several seconds to
      // surface while Obsidian keeps THIS one focused — hold the guard
      // ~15s so an impatient double/triple-click can't fire a second
      // spawn into that gap. `activeWindow.setTimeout` (not bare
      // setTimeout) for Obsidian popout-window compatibility.
      window.setTimeout(() => { this.shadowSpawnInFlight = false; }, 15_000);
    } catch (e) {
      // Spawn FAILED — nothing is opening. Clear the guard NOW so the
      // user can retry immediately; a 15s lockout here would strand
      // them on a failed connect behind a misleading "still opening"
      // (the original `finally` armed the timer on this path too).
      this.shadowSpawnInFlight = false;
      const msg = errorMessage(e);
      logger.error(`openShadowVaultFor: ${msg}`);
      new Notice(`Remote SSH: shadow vault failed — ${msg}`);
    }
  }

  /**
   * Pre-spawn pull (#429b / Phase B-3). Before the shadow window opens,
   * pull the remote `.obsidian/` — shared config (#342), the enabled-
   * plugins list, and plugin binaries (#429b) — into the freshly
   * bootstrapped shadow dir, so the window boots on the CANONICAL remote
   * config instead of a stale local copy (no mid-session settings reload).
   *
   * Strictly best-effort and time-boxed. It builds a STANDALONE
   * `SftpClient` that does NOT patch this (source) window's vault adapter,
   * so the user's real vault is never hijacked. The kbd-interactive and
   * host-key callbacks REJECT rather than prompt: pre-spawn must be
   * non-interactive, so a 2FA / unknown-host connect falls through to the
   * shadow window (which prompts exactly once) — no double prompt, no
   * surprise modal in the source window. On ANY error or timeout it logs
   * and returns; `ShadowVaultManager` then spawns and the shadow window's
   * own connect catches up. Never throws.
   */
  private async preSpawnPull(profile: SshProfile, result: BootstrapResult): Promise<void> {
    const localConfigDir = result.layout.configDir;
    const remoteConfigDir = this.app.vault.configDir; // ".obsidian"
    const remoteBase = normalizeRemotePath(profile.remotePath);
    // Apply the SAME per-client redirect the shadow window's adapter will use
    // (AdapterManager builds `new PathMapper(resolveClientId(settings), configDir)`),
    // so the four now-per-device config files (app/appearance/core-plugins/hotkeys)
    // are pulled from THIS client's `<configDir>/user/<id>/` subtree — NOT the dead
    // shared identity path. Without this, pre-spawn read the shared path and
    // clobbered the per-device config on every spawn, undoing the redirect.
    // `PathMapper.toRemote` is identity for non-private paths (community-plugins.json,
    // plugins/…), so those still round-trip shared, unchanged.
    const mapper = new PathMapper(ConnectionManager.resolveClientId(this.settings), remoteConfigDir);
    const toRemote = (p: string): string => preSpawnRemotePath(mapper, remoteBase, p);

    const client = new SftpClient(
      this.authResolver,
      this.hostKeyStore,
      () => Promise.reject(new Error('pre-spawn: keyboard-interactive deferred to shadow window')),
      () => Promise.reject(new Error('pre-spawn: host-key prompt deferred to shadow window')),
    );
    const reader: SharedConfigReader = {
      exists: (p) => client.exists(toRemote(p)),
      read: (p) => client.readText(toRemote(p)),
    };
    // Bound the whole connect+pull so a slow link can't stall the window
    // open — beyond the budget we fall back to spawn-and-catch-up.
    const budgetMs = (profile.connectTimeoutMs || 15_000) + 8_000;
    // Run as a standalone promise: if the budget fires first, `finally`
    // disconnects the client and any read still in flight then throws
    // "not connected". That settles `pull` a SECOND time, after the race
    // already lost — an unhandledrejection in the renderer unless we keep
    // a handler on it. The real-error diagnostics still flow through the
    // `withTimeout` race into the catch below; this handler only mops up
    // the expected post-disconnect noise.
    const pull = (async () => {
      await client.connect(profile);
      await ShadowVaultBootstrap.pullSharedObsidianConfig(reader, remoteConfigDir, localConfigDir);
      // Same base as the shadow window's own round-trip will use (same
      // device, same profile), so a removal another machine made is
      // applied here too and the window boots on the converged list.
      // `pullCommunityPlugins` never WRITES the base — only the push
      // does, once both sides hold it — so this pre-spawn pull cannot
      // make the real connect's push mistake this device's local
      // additions for remote removals, and re-running the merge over the
      // same base is idempotent: no removal is ever double-applied.
      await ShadowVaultBootstrap.pullCommunityPlugins(
        reader, remoteConfigDir, localConfigDir,
        ShadowVaultBootstrap.communityPluginsBasePath(shadowStateRoot(), profile.id),
      );
      const enabledIds = ShadowVaultBootstrap.readEnabledPluginIds(localConfigDir);
      await ShadowVaultBootstrap.pullPluginBinaries(reader, remoteConfigDir, localConfigDir, enabledIds);
    })();
    pull.catch(() => { /* post-timeout teardown error — handled via the race */ });
    try {
      await withTimeout(pull, budgetMs, 'pre-spawn pull');
      logger.info(`preSpawnPull: staged canonical .obsidian/ before spawn (${profile.name})`);
    } catch (e) {
      logger.warn(`preSpawnPull: skipped (${errorMessage(e)}); shadow window will sync after open`);
    } finally {
      try { await client.disconnect(); } catch { /* best effort */ }
    }
  }

  /**
   * Manual command-palette entry point for adapter patching. Used
   * during development to inspect pre-patch behaviour or to re-patch
   * after a manual restore.
   */
  private async debugPatchAdapter(): Promise<void> {
    if (this.state !== SyncState.CONNECTED || !this.conn.activeRemoteBasePath) {
      new Notice('Remote SSH: connect first');
      return;
    }
    if (this.adapterMgr.isPatched()) {
      new Notice('Remote SSH: adapter already patched');
      return;
    }
    const transportLabel = this.conn.rpcConnection ? 'RPC' : 'SFTP';
    const ok = await this.adapterMgr.patch();
    if (ok) {
      new Notice(`Remote SSH: adapter patched via ${transportLabel}`);
    } else {
      new Notice('Remote SSH: adapter patch failed (see console.log)');
    }
  }

  private debugRestoreAdapter(): void {
    const patched = this.adapterMgr.isPatched();
    this.restoreAdapter();
    new Notice(patched ? 'Remote SSH: adapter restored' : 'Remote SSH: adapter is not patched');
  }

  private async debugListRoot(): Promise<void> {
    try {
      const out = await this.app.vault.adapter.list('');
      const via = this.adapterMgr.isPatched() ? 'PATCHED (SFTP)' : 'ORIGINAL (local)';
      logger.info(`debugListRoot via ${via}: ${out.files.length} files, ${out.folders.length} folders`);
      logger.info(`  files (first 5): ${out.files.slice(0, 5).join(', ')}`);
      logger.info(`  folders (first 5): ${out.folders.slice(0, 5).join(', ')}`);
      new Notice(`List via ${via}: ${out.files.length} files, ${out.folders.length} folders (see console.log)`);
    } catch (e) {
      logger.error(`debugListRoot failed: ${errorMessage(e)}`);
      new Notice(`debugListRoot failed: ${errorMessage(e)}`);
    }
  }

  /**
   * Full α-path round-trip with auto-deploy:
   *   1. Locate the staged daemon binary inside the plugin folder.
   *   2. Upload it over the existing SFTP session, kill any prior
   *      daemon, start the new one with `nohup`, wait for the token
   *      to land on disk.
   *   3. Open a unix-socket Duplex through the same SSH connection.
   *   4. Run `auth` + `server.info`.
   *   5. Smoke-list `activeRemoteBasePath` via `RpcRemoteFsClient`.
   *
   * Each step logs to `console.log` so the daemon and plugin can be
   * debugged in tandem. Optional overrides on the active profile
   * (`rpcSocketPath`, `rpcTokenPath`) are honoured; both default to
   * `.obsidian-remote/{server.sock,token}` (home-relative).
   */
  private async debugTestRpcTunnel(): Promise<void> {
    if (this.state !== SyncState.CONNECTED || !this.conn.client.isAlive()) {
      new Notice('Remote SSH: connect first (the tunnel rides on SFTP)');
      return;
    }
    const activeId = this.settings.activeProfileId;
    const profile = this.settings.profiles.find(p => p.id === activeId);
    if (!profile) {
      new Notice('Remote SSH: no active profile');
      return;
    }

    const localBinaryPath = this.locateDaemonBinary();
    if (!localBinaryPath) {
      new Notice(
        'Remote SSH: daemon binary not staged. ' +
        'Run `npm run build:server` (or `build:full`) and reload the plugin.',
      );
      return;
    }

    const remoteVaultRoot = normalizeRemotePath(profile.remotePath);
    const remoteBinaryPath = '.obsidian-remote/server';
    const remoteSocketPath = profile.rpcSocketPath?.trim() || '.obsidian-remote/server.sock';
    const remoteTokenPath  = profile.rpcTokenPath?.trim()  || '.obsidian-remote/token';

    logger.info(`debugTestRpcTunnel: local binary = ${localBinaryPath}`);
    logger.info(`debugTestRpcTunnel: remote vault = ${remoteVaultRoot}`);
    logger.info(`debugTestRpcTunnel: remote socket = ${remoteSocketPath}`);

    let connection: Awaited<ReturnType<typeof establishRpcConnection>> | null = null;
    try {
      const deployer = new ServerDeployer(this.conn.client);
      const deploy = await deployer.deploy({
        localBinaryPath,
        remoteBinaryPath,
        remoteVaultRoot,
        remoteSocketPath,
        remoteTokenPath,
      });
      logger.info(`debugTestRpcTunnel: daemon up; token len=${deploy.token.length}`);

      const stream = await this.conn.client.openUnixStream(deploy.remoteSocketPath);
      connection = await establishRpcConnection({ stream, token: deploy.token });

      const rpcFs = new RpcRemoteFsClient(connection.rpc);
      const entries = await rpcFs.list(remoteVaultRoot);
      logger.info(`debugTestRpcTunnel: list("${remoteVaultRoot}") returned ${entries.length} entries`);
      for (const e of entries.slice(0, 5)) {
        logger.info(`  - ${e.name} (${e.isDirectory ? 'dir' : 'file'}, ${e.size}B, mtime ${e.mtime})`);
      }
      new Notice(
        `RPC OK: daemon ${connection.info.version}, ${entries.length} entries at "${remoteVaultRoot}" ` +
        `(see console.log)`,
      );
    } catch (e) {
      const msg = errorMessage(e);
      logger.error(`debugTestRpcTunnel failed: ${msg}`);
      new Notice(`RPC test failed: ${msg}`);
    } finally {
      try { connection?.close(); } catch { /* ignore */ }
    }
  }

  /**
   * Absolute path to THIS running plugin's folder
   * (`<vault>/.obsidian/plugins/<id>`), or `null` when the vault isn't
   * file-system-backed. Single source for the call sites that need it
   * (shadow-vault plugin source, dev binary, daemon binary cache).
   */
  private pluginDir(): string | null {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return null;
    return path.join(adapter.getBasePath(), this.app.vault.configDir, 'plugins', this.manifest.id);
  }

  /**
   * Resolve the staged Linux/amd64 daemon binary that lives next to
   * `main.js` in the plugin's vault folder — the dev-build path (`npm run
   * build:server` populates it). Returns the absolute path or `null` if
   * absent; `ensureDaemonBinary` then downloads the matching per-arch
   * binary at connect time.
   */
  private locateDaemonBinary(): string | null {
    const pluginDir = this.pluginDir();
    if (!pluginDir) return null;
    const serverBin = path.join(pluginDir, 'server-bin');
    // Only treat a staged binary as a genuine DEV build when dev-install
    // marked it (`.dev-daemon`). Without this, a *downloaded* binary at the
    // same filename would masquerade as a dev build and bypass the version /
    // sha refresh in ensureDaemonBinary — the exact reason a plugin upgrade
    // kept re-deploying a stale (dynamically-linked) daemon.
    if (!fs.existsSync(path.join(serverBin, '.dev-daemon'))) return null;
    const candidate = path.join(serverBin, 'obsidian-remote-server-linux-amd64');
    return fs.existsSync(candidate) ? candidate : null;
  }

  /**
   * sha256 (hex) of a cached daemon binary, or null if it can't be read.
   * Used by the connect fast-path to re-validate the cached bytes without a
   * network round-trip. Reads the whole file (a daemon binary is a few MB) —
   * cheap next to the SSH connect it gates.
   */
  private async sha256File(abs: string): Promise<string | null> {
    try {
      const buf = await fs.promises.readFile(abs);
      return createHash('sha256').update(buf).digest('hex');
    } catch {
      return null;
    }
  }

  /**
   * Acquire a daemon binary for the REMOTE's os/arch when one isn't staged
   * locally. Community-store installs don't ship `server-bin/`, so we probe
   * the remote with `uname`, download the matching binary from this plugin's
   * GitHub release, and verify it against `daemon-manifest.json` (sha256)
   * before caching it under `server-bin/`. Returns `null` (→ caller
   * downgrades to SFTP) for an unsupported arch, a failed probe, a declined
   * download, or a benign download failure. A sha256/integrity failure is
   * NOT swallowed — it throws so the connect surfaces it loudly.
   */
  private async ensureDaemonBinary(client: SftpClient): Promise<string | null> {
    // Probe the remote os/arch. A FAILED probe (non-zero exit / SSH exec
    // error) is logged distinctly from an UNSUPPORTED arch — both stay on
    // SFTP, but conflating them hid real exec failures behind a misleading
    // "unsupported arch" message (#406 review).
    let target: Awaited<ReturnType<typeof detectRemoteTarget>>;
    try {
      target = await detectRemoteTarget(async (cmd) => {
        const r = await client.exec(cmd);
        if (r.exitCode !== 0) {
          throw new Error(`'${cmd}' exited ${r.exitCode}: ${r.stderr.trim() || '(no stderr)'}`);
        }
        return r.stdout;
      });
    } catch (e) {
      logger.warn(`ensureDaemonBinary: remote uname probe failed (${errorMessage(e)}); staying on SFTP`);
      return null;
    }
    if (!target) {
      logger.warn('ensureDaemonBinary: unsupported remote os/arch; staying on SFTP');
      return null;
    }

    const pluginDir = this.pluginDir();
    if (!pluginDir) return null;
    const cacheDir = path.join(pluginDir, 'server-bin');

    // R3: `server-bin` must be a REAL per-shadow dir. Older installs (and dev
    // symlink installs) could leave it as a junction to ANOTHER vault's
    // server-bin (installPlugin used to propagate it); if that target vault was
    // later deleted, the junction dangles and mkdir throws a raw ENOENT — the
    // connect then silently degrades to SFTP. Try a plain mkdir first (a valid
    // dir/junction is fine); on failure, unlink a stale reparse point (never
    // following into / deleting its target) and recreate a real dir. Only give
    // up to SFTP if even that fails.
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
    } catch (firstErr) {
      let repaired = false;
      try {
        // lstat succeeds for a dangling junction; unlink drops the link only.
        if (fs.lstatSync(cacheDir).isSymbolicLink()) {
          fs.unlinkSync(cacheDir);
          fs.mkdirSync(cacheDir, { recursive: true });
          repaired = true;
        }
      } catch { /* fall through to the SFTP path below */ }
      if (!repaired) {
        logger.error(
          `ensureDaemonBinary: server-bin unusable (${errorMessage(firstErr)}); staying on SFTP. ` +
          'If this persists, delete the shadow vault dir under ~/.obsidian-remote/vaults and reconnect.',
        );
        new Notice(
          'Remote SSH: the daemon cache dir is broken — staying on SFTP. If this persists, ' +
          'delete the vault dir under ~/.obsidian-remote/vaults and reconnect.',
        );
        return null;
      }
      logger.warn(`ensureDaemonBinary: repaired a stale server-bin link at ${cacheDir}`);
    }

    // Fast path: reuse the cached binary without a GitHub round-trip when it
    // was provisioned for THIS plugin version AND its bytes still hash to the
    // recorded sha. The sha re-check upholds the "never deploy an unverified
    // binary" invariant even here — a file corrupted/truncated after its
    // verified download is caught (network-free) and re-fetched below. A
    // version mismatch, missing marker, or sha mismatch falls through to the
    // manifest sha re-check / download.
    const dest = path.join(cacheDir, binaryFilename(target));
    if (
      this.settings.daemonBinaryVersion === this.manifest.version &&
      this.settings.daemonBinarySha &&
      (await this.sha256File(dest)) === this.settings.daemonBinarySha
    ) {
      logger.info(`ensureDaemonBinary: cached daemon validated for ${this.manifest.version}; reusing`);
      return dest;
    }

    // Consent gate (asked once; the decision — accept OR decline — is
    // persisted so a decline doesn't re-prompt on every connect / restart).
    const consented = await resolveDaemonConsent(
      this.settings.daemonDownloadConsented === true,
      () => this.confirmDaemonDownload(this.manifest.version),
      async (c) => { this.settings.daemonDownloadConsented = c; await this.saveSettings(); },
    );
    if (!consented) {
      logger.info('ensureDaemonBinary: user declined daemon download; staying on SFTP');
      return null;
    }

    try {
      const local = await downloadDaemonBinary(
        {
          fetchBinary: async (url) => new Uint8Array((await requestUrl({ url })).arrayBuffer),
          fetchText: async (url) => (await requestUrl({ url })).text,
          cacheDir,
          readCached: async (abs) => {
            try { return new Uint8Array(await fs.promises.readFile(abs)); }
            catch { return null; }
          },
          writeExecutable: async (abs, bytes) => {
            // Atomic: write a temp sibling, chmod, then rename. A crash
            // mid-write can't then leave a torn binary that a later sha
            // re-check would hand back unverified (#406 review).
            await fs.promises.mkdir(path.dirname(abs), { recursive: true });
            const tmp = `${abs}.${process.pid}.tmp`;
            await fs.promises.writeFile(tmp, bytes);
            await fs.promises.chmod(tmp, 0o755);
            await fs.promises.rename(tmp, abs);
          },
          repo: DAEMON_RELEASE_REPO,
          version: this.manifest.version,
        },
        target,
      );
      // Record the version + sha this cached binary is validated for, so the
      // next same-version connect takes the network-free fast path above.
      // Non-fatal: the binary is verified on disk, so a marker-persist failure
      // must NOT be reported as a download failure — we just re-verify on the
      // next connect.
      try {
        this.settings.daemonBinaryVersion = this.manifest.version;
        this.settings.daemonBinarySha = (await this.sha256File(local)) ?? undefined;
        await this.saveSettings();
      } catch (e) {
        logger.warn(
          `ensureDaemonBinary: daemon ready but failed to persist cache marker ` +
          `(${errorMessage(e)}); will re-verify on the next connect`,
        );
      }
      new Notice(`Remote SSH: daemon ready for ${target.os}/${target.arch}.`);
      return local;
    } catch (e) {
      // A sha256 mismatch / malformed manifest (DaemonVerificationError) is a
      // tamper/integrity signal — rethrow so the connect surfaces it loudly
      // (ERROR state + classified Notice) instead of a quiet "Using SFTP".
      // Only benign failures (network / 404) downgrade silently.
      if (e instanceof DaemonVerificationError) throw e;
      logger.error(`ensureDaemonBinary: download failed: ${errorMessage(e)}`);
      new Notice(`Remote SSH: daemon download failed — ${errorMessage(e)}. Using SFTP.`);
      return null;
    }
  }

  /** One-time consent dialog for the daemon auto-download. */
  private confirmDaemonDownload(version: string): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = new Modal(this.app);
      modal.titleEl.setText('Download remote daemon?');
      modal.contentEl.createEl('p', {
        text:
          `Remote SSH can download a small helper daemon (release ${version}) from ` +
          'this plugin’s GitHub release. It is uploaded to your SSH host and ' +
          'verified by sha256, and enables faster directory listing, live file ' +
          'watch, and image/PDF previews. Decline to stay on plain SFTP (these ' +
          'extras are then off).',
      });
      let decided = false;
      const buttons = modal.contentEl.createDiv({ cls: 'modal-button-container' });
      const ok = buttons.createEl('button', { text: 'Download', cls: 'mod-cta' });
      ok.addEventListener('click', () => { decided = true; resolve(true); modal.close(); });
      const no = buttons.createEl('button', { text: 'Use SFTP' });
      no.addEventListener('click', () => { decided = true; resolve(false); modal.close(); });
      modal.onClose = () => { if (!decided) resolve(false); };
      modal.open();
    });
  }

  isConnected(): boolean {
    return this.state === SyncState.CONNECTED;
  }

  private setState(s: SyncState) {
    this.state = s;
    this.statusBar?.update(s);
  }

  /**
   * Command-palette / status-bar entry point that mirrors the
   * Settings UI's Connect button: pick a profile, then open it as a
   * shadow vault in a new Obsidian window. The original window is
   * never patched in-place anymore.
   */
  private promptConnect() {
    const { profiles } = this.settings;
    if (profiles.length === 0) {
      new Notice('Remote SSH: no profiles configured. Open settings to add one.');
      return;
    }
    new ConnectModal(
      this.app,
      profiles,
      this.authResolver,
      profile => this.openShadowVaultFor(profile),
    ).open();
  }

  private onStatusBarClick() {
    if (this.state === SyncState.IDLE || this.state === SyncState.ERROR) {
      this.promptConnect();
    } else if (this.state === SyncState.CONNECTED) {
      void this.disconnect();
    }
  }
}

