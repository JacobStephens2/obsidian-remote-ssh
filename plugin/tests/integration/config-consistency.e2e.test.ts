import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ShadowVaultBootstrap } from '../../src/shadow/ShadowVaultBootstrap';
import { DeviceSettingsSync, stageDeviceSettings } from '../../src/shadow/DeviceSettingsSync';
import { ObsidianRegistry } from '../../src/shadow/ObsidianRegistry';
import { setupClientPair, TEST_PRIVATE_KEY, type TestClient } from './helpers/makeAdapter';
import type { SshProfile } from '../../src/types';

/**
 * Config consistency across connect cycles (#429 / #342).
 *
 * Layer 1 (integration, vitest + docker sshd, no Obsidian UI). Drives
 * the real bootstrap + pull/push round-trip against a real SSH server,
 * so the #429/#342 promise — "config and the enabled-plugins list stay
 * consistent across reconnects, and a push never clobbers a list
 * enabled on another machine" — is verified end-to-end, not just over
 * in-memory fakes. The remote vault's `.obsidian/` is the canonical
 * store; a fresh shadow vault is a new "session" / "machine".
 *
 * Runs only when the test keypair is staged (`npm run sshd:start`).
 */

if (!fs.existsSync(TEST_PRIVATE_KEY)) {
  throw new Error(
    `Integration test keypair missing at ${TEST_PRIVATE_KEY}. ` +
    'Run `npm run sshd:start` from the repo root before `npm run test:integration`.',
  );
}

const REMOTE_CFG = '.obsidian';
const CP = `${REMOTE_CFG}/community-plugins.json`;
const APP = `${REMOTE_CFG}/app.json`;

describe('Config consistency across connect cycles (#429 / #342)', () => {
  let pair: Awaited<ReturnType<typeof setupClientPair>>;
  let remoteClient: TestClient;
  let baseDir: string;
  let sourcePluginDir: string;
  let registryConfigPath: string;

  beforeAll(async () => {
    pair = await setupClientPair({ testLabel: 'config-consistency' });
    remoteClient = pair.a;

    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-consistency-base-'));
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-consistency-home-'));
    registryConfigPath = path.join(tmpHome, 'obsidian.json');
    fs.writeFileSync(registryConfigPath, JSON.stringify({ vaults: {} }) + '\n', 'utf-8');

    sourcePluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-consistency-source-'));
    fs.writeFileSync(path.join(sourcePluginDir, 'main.js'), '/* test stub */\n', 'utf-8');
    fs.writeFileSync(path.join(sourcePluginDir, 'manifest.json'),
      JSON.stringify({ id: 'remote-ssh', version: '0.0.0-test', name: 'Test', minAppVersion: '1.5.0' }) + '\n', 'utf-8');
    fs.writeFileSync(path.join(sourcePluginDir, 'styles.css'), '/* test stub */\n', 'utf-8');

    await remoteClient.adapter.mkdir(REMOTE_CFG);
  });

  afterAll(async () => {
    if (pair) await pair.cleanup();
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch { /* best effort */ }
    try { fs.rmSync(sourcePluginDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  /** A fresh shadow-vault session against the shared docker remote. */
  function freshSession(): ShadowVaultBootstrap {
    return new ShadowVaultBootstrap(baseDir, sourcePluginDir, new ObsidianRegistry(registryConfigPath));
  }
  function profileFor(caseId: string): SshProfile {
    return {
      id: `cfg-${caseId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: `Config consistency (${caseId})`,
      host: '127.0.0.1', port: 2222, username: 'tester',
      authMethod: 'privateKey', privateKeyPath: TEST_PRIVATE_KEY,
      remotePath: remoteClient.vaultRoot,
      connectTimeoutMs: 10_000, keepaliveIntervalMs: 0, keepaliveCountMax: 0,
    };
  }
  const readLocalCp = (dir: string): string[] =>
    JSON.parse(fs.readFileSync(path.join(dir, 'community-plugins.json'), 'utf-8'));

  it('community plugins enabled on the remote round-trip into a fresh shadow, keeping remote-ssh (#429/#342)', async () => {
    // Remote set up "on another machine": dataview enabled.
    await remoteClient.adapter.write(CP, JSON.stringify(['dataview']));

    const profile = profileFor('cp-pull');
    const { layout } = await freshSession().bootstrap(profile, [profile]);
    await ShadowVaultBootstrap.pullCommunityPlugins(remoteClient.adapter, REMOTE_CFG, layout.configDir);

    expect(readLocalCp(layout.configDir)).toEqual(expect.arrayContaining(['dataview', 'remote-ssh']));
  });

  it('a plugin enabled in one session is still enabled in the next (persists via the remote)', async () => {
    // Known base so the assertion doesn't depend on case order.
    await remoteClient.adapter.write(CP, JSON.stringify(['remote-ssh']));

    // Session 1: enable templater locally, push to remote.
    const p1 = profileFor('cycle-1');
    const s1 = await freshSession().bootstrap(p1, [p1]);
    fs.writeFileSync(path.join(s1.layout.configDir, 'community-plugins.json'),
      JSON.stringify(['remote-ssh', 'templater']));
    await ShadowVaultBootstrap.pushCommunityPlugins(remoteClient.adapter, REMOTE_CFG, s1.layout.configDir);

    // Session 2: a brand-new shadow (different id → different local dir) pulls.
    const p2 = profileFor('cycle-2');
    const s2 = await freshSession().bootstrap(p2, [p2]);
    await ShadowVaultBootstrap.pullCommunityPlugins(remoteClient.adapter, REMOTE_CFG, s2.layout.configDir);

    expect(readLocalCp(s2.layout.configDir), 'templater enabled in session 1 must survive into session 2')
      .toContain('templater');
  });

  it('push unions with the remote and never drops a plugin enabled elsewhere (#437, real SSH)', async () => {
    // Remote (machine B) carries a rich list.
    await remoteClient.adapter.write(CP, JSON.stringify(['remote-ssh', 'dataview', 'obsidian-git']));

    // Machine A has only a minimal local list, then pushes.
    const pA = profileFor('union');
    const sA = await freshSession().bootstrap(pA, [pA]);
    fs.writeFileSync(path.join(sA.layout.configDir, 'community-plugins.json'),
      JSON.stringify(['remote-ssh', 'templater']));
    await ShadowVaultBootstrap.pushCommunityPlugins(remoteClient.adapter, REMOTE_CFG, sA.layout.configDir);

    const remoteAfter = JSON.parse(await remoteClient.adapter.read(CP));
    expect(remoteAfter, 'remote dataview + obsidian-git must survive a push from a minimal local')
      .toEqual(expect.arrayContaining(['dataview', 'obsidian-git', 'templater', 'remote-ssh']));
  });

  it('backs up exact settings for one Client ID and stages them into a fresh shadow (#342)', async () => {
    // Session 1: seed remote app.json, pull into the shadow.
    await remoteClient.adapter.write(APP, JSON.stringify({ useMarkdownLinks: false, theme: 'obsidian' }));
    const p1 = profileFor('app-1');
    const s1 = await freshSession().bootstrap(p1, [p1]);
    const sync = new DeviceSettingsSync({
      remote: remoteClient.adapter, remoteConfigDir: REMOTE_CFG, localConfigDir: s1.layout.configDir,
    });
    const otherDevice = '{ "useMarkdownLinks": false, "theme": "other-device" }\n';
    await pair.b.adapter.write(APP, otherDevice);
    try {
      await sync.pull();
      sync.startWatching();
      const changed = '{ "useMarkdownLinks": true, "theme": "things" }\n';
      fs.writeFileSync(path.join(s1.layout.configDir, 'app.json'), changed);
      await vi.waitFor(async () => {
        expect(await remoteClient.ssh.readText(remoteClient.adapter.toRemote(APP))).toBe(changed);
      }, { timeout: 6000, interval: 200 });

      const p2 = profileFor('app-2');
      const s2 = await freshSession().bootstrap(p2, [p2]);
      await stageDeviceSettings({ remoteConfigDir: REMOTE_CFG, localConfigDir: s2.layout.configDir }, remoteClient.adapter);
      expect(fs.readFileSync(path.join(s2.layout.configDir, 'app.json'), 'utf-8')).toBe(changed);
      expect(await pair.b.ssh.readText(pair.b.adapter.toRemote(APP))).toBe(otherDevice);
    } finally {
      sync.stop();
    }
  });

  it('a sideloaded plugin binary enabled on another machine is staged into a fresh shadow (#429b)', async () => {
    const id = 'sideloaded-plugin';
    await remoteClient.adapter.write(`${REMOTE_CFG}/plugins/${id}/manifest.json`,
      JSON.stringify({ id, version: '1.0.0', name: 'Sideloaded', minAppVersion: '1.5.0' }));
    await remoteClient.adapter.write(`${REMOTE_CFG}/plugins/${id}/main.js`, '/* sideloaded code */\n');

    const profile = profileFor('bin-pull');
    const { layout } = await freshSession().bootstrap(profile, [profile]);
    const { pulled } = await ShadowVaultBootstrap.pullPluginBinaries(
      remoteClient.adapter, REMOTE_CFG, layout.configDir, [id]);

    expect(pulled).toContain(id);
    expect(fs.readFileSync(path.join(layout.configDir, 'plugins', id, 'main.js'), 'utf-8'))
      .toBe('/* sideloaded code */\n');
    expect(fs.existsSync(path.join(layout.configDir, 'plugins', id, 'manifest.json'))).toBe(true);
  });

  it('a sideloaded plugin installed in one session round-trips into the next via the remote', async () => {
    const id = 'local-only-plugin';
    // Session 1 (machine A): code present locally, pushed to the remote.
    const pA = profileFor('bin-push');
    const sA = await freshSession().bootstrap(pA, [pA]);
    const dirA = path.join(sA.layout.configDir, 'plugins', id);
    fs.mkdirSync(dirA, { recursive: true });
    fs.writeFileSync(path.join(dirA, 'manifest.json'),
      JSON.stringify({ id, version: '2.0.0', name: 'LocalOnly', minAppVersion: '1.5.0' }));
    fs.writeFileSync(path.join(dirA, 'main.js'), '/* local-only code v2 */\n');
    await ShadowVaultBootstrap.pushPluginBinaries(remoteClient.adapter, REMOTE_CFG, sA.layout.configDir, [id]);

    // Session 2 (machine B): a fresh shadow pulls the pushed binary.
    const pB = profileFor('bin-push-2');
    const sB = await freshSession().bootstrap(pB, [pB]);
    await ShadowVaultBootstrap.pullPluginBinaries(remoteClient.adapter, REMOTE_CFG, sB.layout.configDir, [id]);

    expect(fs.readFileSync(path.join(sB.layout.configDir, 'plugins', id, 'main.js'), 'utf-8'),
      'a sideloaded plugin installed in session 1 must reach session 2')
      .toBe('/* local-only code v2 */\n');
  });

  it('pullPluginBinaries never DOWNGRADES a newer local plugin (older remote, real SSH)', async () => {
    const id = 'conflict-plugin';
    // Remote carries an OLDER version.
    await remoteClient.adapter.write(`${REMOTE_CFG}/plugins/${id}/manifest.json`,
      JSON.stringify({ id, version: '1.0.0', name: 'Conflict', minAppVersion: '1.5.0' }));
    await remoteClient.adapter.write(`${REMOTE_CFG}/plugins/${id}/main.js`, '/* REMOTE v1 */\n');

    const profile = profileFor('bin-conflict');
    const { layout } = await freshSession().bootstrap(profile, [profile]);
    const dir = path.join(layout.configDir, 'plugins', id);
    fs.mkdirSync(dir, { recursive: true });
    // Local has a strictly NEWER version — the pull must leave it alone.
    fs.writeFileSync(path.join(dir, 'manifest.json'),
      JSON.stringify({ id, version: '2.0.0', name: 'Conflict', minAppVersion: '1.5.0' }));
    fs.writeFileSync(path.join(dir, 'main.js'), '/* LOCAL v2 */\n');

    await ShadowVaultBootstrap.pullPluginBinaries(remoteClient.adapter, REMOTE_CFG, layout.configDir, [id]);

    expect(fs.readFileSync(path.join(dir, 'main.js'), 'utf-8'), 'older remote must not downgrade newer local')
      .toBe('/* LOCAL v2 */\n');
  });
});
