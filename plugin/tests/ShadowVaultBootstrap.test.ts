import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Wrap `fs` in a vi.mock that re-exports the actual module. Vitest 4
// turns the resulting namespace into a configurable object so the
// `vi.spyOn(fs, 'symlinkSync')` call in the symlink-fallback suite can
// redefine that property — the raw ESM namespace is non-configurable
// and rejects spies. All other fs calls run against the real
// implementation, so the scratch-tree I/O elsewhere is unaffected.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, default: actual };
});

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ShadowVaultBootstrap } from '../src/shadow/ShadowVaultBootstrap';
import type { ConfigReader, ConfigWriter } from '../src/shadow/ShadowVaultBootstrap';
import { ObsidianRegistry } from '../src/shadow/ObsidianRegistry';
import type { SshProfile, PendingPluginSuggestion } from '../src/types';

/** Minimal valid profile shape for the tests. */
function makeProfile(overrides: Partial<SshProfile> = {}): SshProfile {
  return {
    id: 'profile-test-id',
    name: 'Test',
    host: 'example.invalid',
    port: 22,
    username: 'alice',
    authMethod: 'privateKey',
    remotePath: '~/test-vault/',
    privateKeyPath: '/dev/null',
    connectTimeoutMs: 5000,
    keepaliveIntervalMs: 10000,
    keepaliveCountMax: 3,
    ...overrides,
  } as SshProfile;
}

/**
 * Each test gets its own scratch tree so they can't cross-pollute and
 * the developer's real `~/.obsidian-remote/` is never touched.
 *
 * The source side mirrors a real vault layout:
 *
 *   <root>/source-vault/.obsidian/
 *     community-plugins.json                   ← optional, tests opt in
 *     plugins/
 *       remote-ssh/main.js, manifest.json     ← always staged
 *       <other-id>/...                         ← optional, tests opt in
 *
 * `sourceDir` is the path the production code calls `sourcePluginDir`
 * — the running plugin's own dir, two levels under `.obsidian/`. Tests
 * that need source community-plugins.json or third-party plugin dirs
 * can write them directly under `<root>/source-vault/.obsidian/`.
 */
function makeScratch(): {
  baseDir: string;
  sourceDir: string;
  sourceVaultDir: string;
  sourceConfigDir: string;
  configPath: string;
  cleanup(): void;
} {
  const root = path.join(os.tmpdir(), `shadow-vault-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const baseDir = path.join(root, 'vaults');
  const sourceVaultDir = path.join(root, 'source-vault');
  const sourceConfigDir = path.join(sourceVaultDir, '.obsidian');
  const sourceDir = path.join(sourceConfigDir, 'plugins', 'remote-ssh');
  const configPath = path.join(root, 'obsidian.json');
  fs.mkdirSync(sourceDir, { recursive: true });
  // Stage a couple of plugin files so install actually has something
  // to copy / link.
  fs.writeFileSync(path.join(sourceDir, 'main.js'), '// fake bundled plugin\n');
  fs.writeFileSync(path.join(sourceDir, 'manifest.json'), JSON.stringify({ id: 'remote-ssh', version: '0.0.0' }));
  fs.writeFileSync(configPath, JSON.stringify({ vaults: {} }));
  return {
    baseDir, sourceDir, sourceVaultDir, sourceConfigDir, configPath,
    cleanup() {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

describe('ShadowVaultBootstrap.layoutFor', () => {
  it('names the vault dir <friendly-name>--<remotePath-tail> so Obsidian shows a recognisable, folder-distinct name', () => {
    const scratch = makeScratch();
    try {
      const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
      const layout = r.layoutFor({ name: 'My Homelab', remotePath: '/home/souta/work' });
      expect(path.basename(layout.vaultDir)).toBe('My Homelab--work');
      expect(layout.configDir).toBe(path.join(layout.vaultDir, '.obsidian'));
      expect(layout.pluginDir).toBe(path.join(layout.vaultDir, '.obsidian', 'plugins', 'remote-ssh'));
      expect(layout.pluginDataFile).toBe(path.join(layout.pluginDir, 'data.json'));
    } finally { scratch.cleanup(); }
  });

  it('uses the last path segment as the tail, ignoring a trailing slash', () => {
    const scratch = makeScratch();
    try {
      const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
      const layout = r.layoutFor({ name: 'Panza', remotePath: '/home/souta/work/dev/' });
      expect(path.basename(layout.vaultDir)).toBe('Panza--dev');
    } finally { scratch.cleanup(); }
  });

  it('falls back to a generic name and tail when both are empty', () => {
    const scratch = makeScratch();
    try {
      const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
      const layout = r.layoutFor({ name: '', remotePath: '' });
      expect(path.basename(layout.vaultDir)).toBe('vault--vault');
    } finally { scratch.cleanup(); }
  });

  it('same host name + different remotePath → different dirs (multiple vaults on one host)', () => {
    const scratch = makeScratch();
    try {
      const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
      const a = r.layoutFor({ name: 'Panza', remotePath: '/home/souta/work' });
      const b = r.layoutFor({ name: 'Panza', remotePath: '/home/souta/work/dev' });
      expect(a.vaultDir).not.toBe(b.vaultDir);
      expect(path.basename(a.vaultDir)).toBe('Panza--work');
      expect(path.basename(b.vaultDir)).toBe('Panza--dev');
    } finally { scratch.cleanup(); }
  });

  it('sanitises name + tail so the dir never escapes baseDir', () => {
    const scratch = makeScratch();
    try {
      const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
      const lo = r.layoutFor({ name: '../../evil/name', remotePath: '/x/../../etc/' });
      expect(path.dirname(lo.vaultDir)).toBe(scratch.baseDir);
      expect(path.resolve(lo.vaultDir).startsWith(path.resolve(scratch.baseDir) + path.sep)).toBe(true);
    } finally { scratch.cleanup(); }
  });

  it('falls back to a generic tail for a bare `~` home-dir remotePath', () => {
    const scratch = makeScratch();
    try {
      const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
      expect(path.basename(r.layoutFor({ name: 'Home', remotePath: '~' }).vaultDir)).toBe('Home--vault');
      expect(path.basename(r.layoutFor({ name: 'Home', remotePath: '~/' }).vaultDir)).toBe('Home--vault');
    } finally { scratch.cleanup(); }
  });

  it('splits on backslash separators too (Windows-style remotePath)', () => {
    const scratch = makeScratch();
    try {
      const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
      expect(path.basename(r.layoutFor({ name: 'Win', remotePath: 'C:\\Users\\a\\notes' }).vaultDir)).toBe('Win--notes');
    } finally { scratch.cleanup(); }
  });
});

describe('ShadowVaultBootstrap: server-bin (daemon dir) install', () => {
  it('mirrors a REAL source server-bin dir into the shadow (local dev build)', async () => {
    const scratch = makeScratch();
    try {
      const srcBin = path.join(scratch.sourceDir, 'server-bin');
      fs.mkdirSync(srcBin, { recursive: true });
      fs.writeFileSync(path.join(srcBin, 'obsidian-remote-server'), 'ELF\n');
      const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
      const profile = makeProfile({ id: 's1', name: 'S', remotePath: '/s1' });
      const result = await r.bootstrap(profile, [profile]);
      // Real dir → mirrored (symlink or copy); the binary is reachable.
      expect(fs.existsSync(path.join(result.layout.pluginDir, 'server-bin', 'obsidian-remote-server'))).toBe(true);
    } finally { scratch.cleanup(); }
  });

  it('does NOT propagate a junction/symlink source server-bin (avoids the dangling-junction daemon breakage)', async () => {
    const scratch = makeScratch();
    try {
      // The corrupted shape: source/server-bin is a LINK to a dir elsewhere.
      // Propagating it would chain the shadow to another vault and dangle if
      // that vault is deleted (the field bug: mkdir server-bin → ENOENT).
      const realElsewhere = path.join(scratch.sourceVaultDir, 'real-bin');
      fs.mkdirSync(realElsewhere, { recursive: true });
      fs.writeFileSync(path.join(realElsewhere, 'obsidian-remote-server'), 'ELF\n');
      const srcBinLink = path.join(scratch.sourceDir, 'server-bin');
      try {
        fs.symlinkSync(realElsewhere, srcBinLink, process.platform === 'win32' ? 'junction' : 'dir');
      } catch (e) {
        console.warn(`skipping: cannot create symlink in test env: ${(e as Error).message}`);
        return;
      }
      const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
      const profile = makeProfile({ id: 's2', name: 'S', remotePath: '/s2' });
      const result = await r.bootstrap(profile, [profile]);
      // Shadow gets NO server-bin — ensureDaemonBinary creates a real per-shadow
      // dir at connect time instead of inheriting a link.
      expect(fs.existsSync(path.join(result.layout.pluginDir, 'server-bin'))).toBe(false);
    } finally { scratch.cleanup(); }
  });
});

describe('ShadowVaultBootstrap.bootstrap', () => {
  let scratch: ReturnType<typeof makeScratch>;
  beforeEach(() => { scratch = makeScratch(); });
  afterEach(() => { scratch.cleanup(); });

  it('creates vaultDir, .obsidian/, plugin install, community-plugins.json, and data.json', async () => {
    const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
    const profile = makeProfile({ id: 'p1', name: 'P One' });
    const result = await r.bootstrap(profile, [profile]);

    expect(fs.existsSync(result.layout.vaultDir)).toBe(true);
    expect(fs.existsSync(result.layout.configDir)).toBe(true);
    expect(fs.existsSync(result.layout.pluginDir)).toBe(true);
    expect(fs.existsSync(result.layout.pluginDataFile)).toBe(true);

    const cp = JSON.parse(fs.readFileSync(path.join(result.layout.configDir, 'community-plugins.json'), 'utf-8'));
    expect(cp).toEqual(['remote-ssh']);

    const data = JSON.parse(fs.readFileSync(result.layout.pluginDataFile, 'utf-8'));
    expect(data.profiles).toEqual([profile]);
    expect(data.activeProfileId).toBe('p1');
    expect(data.autoConnectProfileId).toBe('p1');

    // The plugin install method depends on platform / perms; just
    // assert the staged file is reachable through it.
    expect(fs.existsSync(path.join(result.layout.pluginDir, 'main.js'))).toBe(true);
    expect(['symlink', 'copy']).toContain(result.pluginInstallMethod);
  });

  it('registers the vault path in obsidian.json with a fresh id', async () => {
    const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
    const profile = makeProfile({ id: 'p1' });
    const result = await r.bootstrap(profile, [profile]);

    const cfg = JSON.parse(fs.readFileSync(scratch.configPath, 'utf-8'));
    expect(result.registryCreated).toBe(true);
    expect(cfg.vaults[result.registryId].path).toBe(result.layout.vaultDir);
    expect(cfg.vaults[result.registryId].ts).toBeGreaterThan(0);
  });

  it('is idempotent: a second bootstrap reuses the registry id and refreshes data.json', async () => {
    const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
    const profile = makeProfile({ id: 'p1', name: 'First' });
    const first = await r.bootstrap(profile, [profile]);
    expect(first.registryCreated).toBe(true);

    const profileChanged = makeProfile({ id: 'p1', name: 'Renamed' });
    const second = await r.bootstrap(profileChanged, [profileChanged]);
    expect(second.registryCreated).toBe(false);
    expect(second.registryId).toBe(first.registryId);

    const data = JSON.parse(fs.readFileSync(second.layout.pluginDataFile, 'utf-8'));
    expect(data.profiles[0].name).toBe('Renamed');
  });

  it('writes ALL profiles into the shadow vault data.json, with activeProfileId pinned to the target one', async () => {
    const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
    const p1 = makeProfile({ id: 'one', name: 'One' });
    const p2 = makeProfile({ id: 'two', name: 'Two' });
    const result = await r.bootstrap(p2, [p1, p2]);
    const data = JSON.parse(fs.readFileSync(result.layout.pluginDataFile, 'utf-8'));
    expect(data.profiles.map((p: SshProfile) => p.id)).toEqual(['one', 'two']);
    expect(data.activeProfileId).toBe('two');
    expect(data.autoConnectProfileId).toBe('two');
  });

  it('inherits the source vault\'s data.json on first bootstrap so accumulated host keys / secrets carry over', async () => {
    // Stage a source data.json that simulates what a real running
    // plugin would write — host keys collected from past TOFU
    // prompts, secrets, etc. The first-ever bootstrap should seed
    // these into the shadow so the auto-connect doesn't re-prompt.
    fs.writeFileSync(path.join(scratch.sourceDir, 'data.json'), JSON.stringify({
      hostKeyStore: { 'host:22': 'fingerprint-trusted-by-source' },
      secrets: { somekey: 'somevalue' },
      enableDebugLog: true,
    }), 'utf-8');

    const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
    const profile = makeProfile({ id: 'p1' });
    const result = await r.bootstrap(profile, [profile]);

    const shadowData = JSON.parse(fs.readFileSync(result.layout.pluginDataFile, 'utf-8'));
    expect(shadowData.hostKeyStore).toEqual({ 'host:22': 'fingerprint-trusted-by-source' });
    expect(shadowData.secrets).toEqual({ somekey: 'somevalue' });
    expect(shadowData.enableDebugLog).toBe(true);
    // Bootstrap-managed fields override source values.
    expect(shadowData.activeProfileId).toBe('p1');
    expect(shadowData.autoConnectProfileId).toBe('p1');
  });

  it('preserves shadow-side accumulated state on re-bootstrap (does not reset hostKeyStore back to source\'s)', async () => {
    const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
    const profile = makeProfile({ id: 'p1' });
    const first = await r.bootstrap(profile, [profile]);

    // Simulate what the shadow's running plugin would do after a
    // first connect: write new host keys / settings to its own data.json.
    const accumulated = JSON.parse(fs.readFileSync(first.layout.pluginDataFile, 'utf-8'));
    accumulated.hostKeyStore = { 'remote:22': 'fingerprint-collected-in-shadow' };
    accumulated.secrets = { tofuKey: 'tofuValue' };
    fs.writeFileSync(first.layout.pluginDataFile, JSON.stringify(accumulated, null, 2), 'utf-8');

    // Re-bootstrap (e.g. user clicks Connect again from Settings).
    await r.bootstrap(profile, [profile]);

    const after = JSON.parse(fs.readFileSync(first.layout.pluginDataFile, 'utf-8'));
    expect(after.hostKeyStore).toEqual({ 'remote:22': 'fingerprint-collected-in-shadow' });
    expect(after.secrets).toEqual({ tofuKey: 'tofuValue' });
    // Bootstrap-managed fields still get refreshed.
    expect(after.profiles).toEqual([profile]);
    expect(after.autoConnectProfileId).toBe('p1');
  });

  it('#399: re-bootstrap propagates a NEW source secret the shadow lacks (was: shadow opens empty / "No password stored")', async () => {
    // Field bug #399: the password is entered/persisted in the SOURCE
    // (local) vault AFTER the shadow vault was first bootstrapped. The
    // shadow's data.json secrets stayed empty because readBaseDataJson
    // prefers the existing shadow file and never re-reads source — so
    // the shadow auto-connect died with "No password stored for
    // profile" and the vault opened empty.
    const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
    const profile = makeProfile({ id: 'p1', authMethod: 'password', passwordRef: 'p1:password' });

    // First bootstrap: source has no secret yet → shadow gets none.
    const first = await r.bootstrap(profile, [profile]);
    const afterFirst = JSON.parse(fs.readFileSync(first.layout.pluginDataFile, 'utf-8'));
    expect(afterFirst.secrets?.['p1:password']).toBeUndefined();

    // The user now types the password in the SOURCE vault; saveSettings
    // flushes the encrypted blob into the source plugin's data.json.
    fs.writeFileSync(path.join(scratch.sourceDir, 'data.json'), JSON.stringify({
      secrets: { 'p1:password': { iv: 'aa', tag: 'bb', data: 'cc' } },
    }), 'utf-8');

    // Re-bootstrap (user clicks Connect again, or the shadow re-spawns).
    await r.bootstrap(profile, [profile]);

    const afterSecond = JSON.parse(fs.readFileSync(first.layout.pluginDataFile, 'utf-8'));
    expect(afterSecond.secrets?.['p1:password']).toEqual({ iv: 'aa', tag: 'bb', data: 'cc' });
  });

  it('#399: secrets merge is a union — shadow-only entries survive, source wins on a conflicting ref', async () => {
    const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
    const profile = makeProfile({ id: 'p1', authMethod: 'password', passwordRef: 'p1:password' });
    const first = await r.bootstrap(profile, [profile]);

    // Shadow accumulated its own secret (e.g. a passphrase typed
    // directly in the shadow window) AND holds a now-stale copy of a
    // ref the user just re-entered in the source vault.
    const shadow = JSON.parse(fs.readFileSync(first.layout.pluginDataFile, 'utf-8'));
    shadow.secrets = {
      'shadow-only:passphrase': { iv: '00', tag: '00', data: 'shadow' },
      'p1:password':            { iv: '00', tag: '00', data: 'stale' },
    };
    fs.writeFileSync(first.layout.pluginDataFile, JSON.stringify(shadow, null, 2), 'utf-8');

    // Source holds the authoritative (latest) blob for the shared ref.
    fs.writeFileSync(path.join(scratch.sourceDir, 'data.json'), JSON.stringify({
      secrets: { 'p1:password': { iv: 'ff', tag: 'ff', data: 'fresh' } },
    }), 'utf-8');

    await r.bootstrap(profile, [profile]);

    const merged = JSON.parse(fs.readFileSync(first.layout.pluginDataFile, 'utf-8')).secrets;
    // shadow-only entry preserved (union, not overwrite)
    expect(merged['shadow-only:passphrase']).toEqual({ iv: '00', tag: '00', data: 'shadow' });
    // source wins on the conflicting ref — it's the user's latest password
    expect(merged['p1:password']).toEqual({ iv: 'ff', tag: 'ff', data: 'fresh' });
  });

  it('regression: source plugin\'s data.json is NEVER touched by install, even on re-bootstrap', async () => {
    // Stage a sentinel data.json in the SOURCE plugin dir — this
    // mirrors the dev-vault setup where the developer's hostKeyStore /
    // secrets / etc live alongside main.js. The earlier whole-dir
    // symlink approach silently overwrote this file when the shadow
    // vault first wrote its own per-vault settings; per-file install
    // must keep it intact.
    const sourceDataJson = path.join(scratch.sourceDir, 'data.json');
    const sentinel = JSON.stringify({
      hostKeyStore: { 'host:22': 'fingerprint-must-survive' },
      profiles: [{ id: 'source-profile' }],
    });
    fs.writeFileSync(sourceDataJson, sentinel, 'utf-8');

    const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
    const profile = makeProfile({ id: 'p1' });
    const result = await r.bootstrap(profile, [profile]);

    // Source untouched.
    expect(fs.readFileSync(sourceDataJson, 'utf-8')).toBe(sentinel);

    // Shadow has its own data.json. With the merge behaviour added in
    // Phase 4 it inherits the source's hostKeyStore on first
    // bootstrap, but bootstrap-managed fields override anything
    // source had.
    const shadowData = JSON.parse(fs.readFileSync(result.layout.pluginDataFile, 'utf-8'));
    expect(shadowData.activeProfileId).toBe('p1');
    expect(shadowData.hostKeyStore).toEqual({ 'host:22': 'fingerprint-must-survive' });

    // Re-bootstrap and re-check — once was a regression in PR #64,
    // both passes must keep the source data.json intact.
    await r.bootstrap(profile, [profile]);
    expect(fs.readFileSync(sourceDataJson, 'utf-8')).toBe(sentinel);
  });

  it('regression: a stale whole-dir symlink at pluginDir is unlinked, not followed (does not delete source)', async () => {
    // Simulate the pre-fix on-disk state: pluginDir is a whole-dir
    // symlink to the source plugin dir. installPlugin must replace it
    // with a real dir without deleting any of the source files.
    const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
    const profile = makeProfile({ id: 'p1', name: 'P', remotePath: '/p1' });
    const layout = r.layoutFor(profile);
    fs.mkdirSync(path.dirname(layout.pluginDir), { recursive: true });
    // The source plugin dir carries a data.json in the field; give it this
    // profile's id so find-by-id resolves the shadow THROUGH the link
    // (instead of forking a " (2)" dir) and installPlugin runs on the junction.
    fs.writeFileSync(path.join(scratch.sourceDir, 'data.json'), JSON.stringify({ autoConnectProfileId: 'p1' }));
    try {
      const linkType = process.platform === 'win32' ? 'junction' : 'dir';
      fs.symlinkSync(scratch.sourceDir, layout.pluginDir, linkType);
    } catch (e) {
      // If we can't even create a symlink in the test env, the test
      // can't exercise the relevant cleanup path — bail rather than
      // false-pass. (We always at least install per-file in that case,
      // so the regression isn't reachable.)
      console.warn(`skipping: cannot create symlink in test env: ${(e as Error).message}`);
      return;
    }

    // Stage a unique file in the source so we can detect deletion.
    const sourceCanary = path.join(scratch.sourceDir, 'CANARY.txt');
    fs.writeFileSync(sourceCanary, 'do-not-delete', 'utf-8');

    await r.bootstrap(profile, [profile]);

    // Source file still there.
    expect(fs.existsSync(sourceCanary)).toBe(true);
    expect(fs.readFileSync(sourceCanary, 'utf-8')).toBe('do-not-delete');
    // Plugin dir is now a real dir, not a symlink.
    const stat = fs.lstatSync(layout.pluginDir);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.isDirectory()).toBe(true);
  });

  it('regression: re-bootstrap from INSIDE the shadow window (source == target plugin dir) must not self-symlink the plugin files', async () => {
    // First bootstrap from a normal source vault.
    const r1 = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
    const profile = makeProfile({ id: 'p1', name: 'P', remotePath: '/p1' });
    const first = await r1.bootstrap(profile, [profile]);

    // Simulate the plugin now RUNNING inside that shadow window with
    // the user clicking Connect again: the running plugin's own dir
    // (the bootstrap source) IS the shadow's plugin dir. Before the
    // self-install guard, installPlugin rm'd each real file and left a
    // symlink pointing at its own path — the plugin then failed to
    // load ("disappeared") on the next Obsidian start.
    const r2 = new ShadowVaultBootstrap(scratch.baseDir, first.layout.pluginDir, new ObsidianRegistry(scratch.configPath));
    const second = await r2.bootstrap(profile, [profile]);

    expect(second.layout.pluginDir).toBe(first.layout.pluginDir);
    expect(second.pluginInstallMethod).toBe('in-place');
    // main.js must still resolve to the staged bundle content.
    const mainJs = path.join(second.layout.pluginDir, 'main.js');
    expect(fs.readFileSync(mainJs, 'utf-8')).toContain('fake bundled plugin');
  });

  it('writes [remote-ssh] only into shadow community-plugins.json on first bootstrap (does not auto-install source plugins)', async () => {
    fs.writeFileSync(
      path.join(scratch.sourceConfigDir, 'community-plugins.json'),
      JSON.stringify(['dataview', 'templater-obsidian', 'remote-ssh']),
    );
    const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
    const profile = makeProfile({ id: 'p1' });
    const result = await r.bootstrap(profile, [profile]);

    const shadowList = JSON.parse(fs.readFileSync(
      path.join(result.layout.configDir, 'community-plugins.json'),
      'utf-8',
    ));
    // Source's plugins are captured for the modal, not silently
    // enabled at startup.
    expect(shadowList).toEqual(['remote-ssh']);
  });

  it('captures source-enabled plugins (and their data.json) into pendingPluginSuggestions on first bootstrap', async () => {
    fs.writeFileSync(
      path.join(scratch.sourceConfigDir, 'community-plugins.json'),
      JSON.stringify(['dataview', 'templater-obsidian', 'remote-ssh']),
    );
    const sourceDataviewDir = path.join(scratch.sourceConfigDir, 'plugins', 'dataview');
    fs.mkdirSync(sourceDataviewDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDataviewDir, 'data.json'), JSON.stringify({ enableInlineQueries: false }));
    // Templater has no data.json at source — should still surface as a suggestion with sourceData=null.

    const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
    const profile = makeProfile({ id: 'p1' });
    const result = await r.bootstrap(profile, [profile]);

    const data = JSON.parse(fs.readFileSync(result.layout.pluginDataFile, 'utf-8'));
    expect(data.pendingPluginSuggestions).toEqual([
      { id: 'dataview',           sourceData: { enableInlineQueries: false } },
      { id: 'templater-obsidian', sourceData: null },
    ]);
    // remote-ssh is excluded — we always install ourselves separately.
  });

  it('does not write pendingPluginSuggestions on re-bootstrap (user has already decided)', async () => {
    fs.writeFileSync(
      path.join(scratch.sourceConfigDir, 'community-plugins.json'),
      JSON.stringify(['dataview', 'remote-ssh']),
    );
    const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
    const profile = makeProfile({ id: 'p1' });
    const first = await r.bootstrap(profile, [profile]);
    // Simulate the user picking "Install dataview, ask later for everything else" then
    // the shadow window persisting the decision: data.json no longer has the field.
    const data = JSON.parse(fs.readFileSync(first.layout.pluginDataFile, 'utf-8'));
    delete data.pendingPluginSuggestions;
    fs.writeFileSync(first.layout.pluginDataFile, JSON.stringify(data, null, 2));

    await r.bootstrap(profile, [profile]);
    const after = JSON.parse(fs.readFileSync(first.layout.pluginDataFile, 'utf-8'));
    expect(after.pendingPluginSuggestions).toBeUndefined();
  });

  it('does not include remote-ssh in pendingPluginSuggestions even if source lists it', async () => {
    fs.writeFileSync(
      path.join(scratch.sourceConfigDir, 'community-plugins.json'),
      JSON.stringify(['remote-ssh', 'dataview']),
    );
    const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
    const profile = makeProfile({ id: 'p1' });
    const result = await r.bootstrap(profile, [profile]);
    const data = JSON.parse(fs.readFileSync(result.layout.pluginDataFile, 'utf-8'));
    expect(data.pendingPluginSuggestions.map((p: PendingPluginSuggestion) => p.id)).toEqual(['dataview']);
  });

  it('omits pendingPluginSuggestions when source has no community-plugins.json or only remote-ssh', async () => {
    // (a) no community-plugins.json at source
    {
      const local = makeScratch();
      try {
        const r = new ShadowVaultBootstrap(local.baseDir, local.sourceDir, new ObsidianRegistry(local.configPath));
        const profile = makeProfile({ id: 'a' });
        const result = await r.bootstrap(profile, [profile]);
        const data = JSON.parse(fs.readFileSync(result.layout.pluginDataFile, 'utf-8'));
        expect(data.pendingPluginSuggestions).toBeUndefined();
      } finally { local.cleanup(); }
    }
    // (b) source has community-plugins.json with only remote-ssh
    {
      const local = makeScratch();
      try {
        fs.writeFileSync(
          path.join(local.sourceConfigDir, 'community-plugins.json'),
          JSON.stringify(['remote-ssh']),
        );
        const r = new ShadowVaultBootstrap(local.baseDir, local.sourceDir, new ObsidianRegistry(local.configPath));
        const profile = makeProfile({ id: 'b' });
        const result = await r.bootstrap(profile, [profile]);
        const data = JSON.parse(fs.readFileSync(result.layout.pluginDataFile, 'utf-8'));
        expect(data.pendingPluginSuggestions).toBeUndefined();
      } finally { local.cleanup(); }
    }
  });

  it('preserves shadow community-plugins.json on re-bootstrap (does not reset)', async () => {
    fs.writeFileSync(
      path.join(scratch.sourceConfigDir, 'community-plugins.json'),
      JSON.stringify(['dataview', 'remote-ssh']),
    );
    const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
    const profile = makeProfile({ id: 'p1' });
    const first = await r.bootstrap(profile, [profile]);

    // Simulate the user installing templater inside the shadow window —
    // its id lands in the shadow's community-plugins.json.
    fs.writeFileSync(
      path.join(first.layout.configDir, 'community-plugins.json'),
      JSON.stringify(['templater-obsidian', 'remote-ssh']),
    );

    const second = await r.bootstrap(profile, [profile]);
    const shadowList = JSON.parse(fs.readFileSync(
      path.join(second.layout.configDir, 'community-plugins.json'),
      'utf-8',
    ));
    expect(shadowList).toEqual(['templater-obsidian', 'remote-ssh']);
  });

  it('does NOT copy source plugin binaries (third-party plugins are downloaded by PluginMarketplaceInstaller at shadow window startup)', async () => {
    // Stage source with a plugin binary; bootstrap should NOT copy it
    // to shadow — the marketplace installer in main.ts is the only
    // path that materialises non-remote-ssh plugin code now.
    fs.writeFileSync(
      path.join(scratch.sourceConfigDir, 'community-plugins.json'),
      JSON.stringify(['dataview', 'remote-ssh']),
    );
    const sourceDataviewDir = path.join(scratch.sourceConfigDir, 'plugins', 'dataview');
    fs.mkdirSync(sourceDataviewDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDataviewDir, 'main.js'), '// source-side dataview bundle');

    const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
    const profile = makeProfile({ id: 'p1' });
    const result = await r.bootstrap(profile, [profile]);

    // List is still seeded so the installer knows what to download,
    // but the binary itself is absent from shadow until the
    // marketplace installer runs in the shadow window.
    expect(fs.existsSync(path.join(result.layout.configDir, 'plugins', 'dataview'))).toBe(false);
    // remote-ssh itself IS installed (per-file symlink, separate path).
    expect(fs.existsSync(result.layout.pluginDir)).toBe(true);
  });

  it('refreshes plugin install on bootstrap so plugin updates land immediately', async () => {
    const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
    const profile = makeProfile({ id: 'p1' });
    await r.bootstrap(profile, [profile]);

    // Bump the source plugin to simulate a dev rebuild.
    fs.writeFileSync(path.join(scratch.sourceDir, 'main.js'), '// updated bundle\n');

    const result = await r.bootstrap(profile, [profile]);
    const installed = fs.readFileSync(path.join(result.layout.pluginDir, 'main.js'), 'utf-8');
    expect(installed).toContain('updated bundle');
  });
});

describe('ShadowVaultBootstrap: seedCommunityPlugins error branches', () => {
  let scratch: ReturnType<typeof makeScratch>;
  beforeEach(() => { scratch = makeScratch(); });
  afterEach(() => { scratch.cleanup(); });

  it('rewrites shadow community-plugins.json when the existing file contains invalid JSON', async () => {
    const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
    const profile = makeProfile({ id: 'p1' });

    // First bootstrap creates the shadow config dir and community-plugins.json.
    const first = await r.bootstrap(profile, [profile]);

    // Corrupt the file so the next parse fails.
    fs.writeFileSync(
      path.join(first.layout.configDir, 'community-plugins.json'),
      '{not valid json!!!}',
    );

    // Second bootstrap should detect the parse failure, warn, and rewrite.
    const second = await r.bootstrap(profile, [profile]);
    const list = JSON.parse(
      fs.readFileSync(path.join(second.layout.configDir, 'community-plugins.json'), 'utf-8'),
    );
    expect(list).toEqual(['remote-ssh']);
  });

  it('rewrites shadow community-plugins.json when the file is valid JSON but not an array', async () => {
    const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
    const profile = makeProfile({ id: 'p1' });

    const first = await r.bootstrap(profile, [profile]);

    // Valid JSON object — not an array.
    fs.writeFileSync(
      path.join(first.layout.configDir, 'community-plugins.json'),
      JSON.stringify({ remote_ssh: true }),
    );

    const second = await r.bootstrap(profile, [profile]);
    const list = JSON.parse(
      fs.readFileSync(path.join(second.layout.configDir, 'community-plugins.json'), 'utf-8'),
    );
    expect(list).toEqual(['remote-ssh']);
  });
});

describe('ShadowVaultBootstrap: collectPendingPluginSuggestions edge cases', () => {
  let scratch: ReturnType<typeof makeScratch>;
  beforeEach(() => { scratch = makeScratch(); });
  afterEach(() => { scratch.cleanup(); });

  it('omits suggestions when source community-plugins.json is valid JSON but not an array', async () => {
    fs.writeFileSync(
      path.join(scratch.sourceConfigDir, 'community-plugins.json'),
      JSON.stringify({ corrupted: true }),
    );
    const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
    const profile = makeProfile({ id: 'p1' });
    const result = await r.bootstrap(profile, [profile]);

    // Bootstrap omits the field entirely when there are no suggestions
    // (ShadowVaultBootstrap.ts:121-126 only writes the key when
    // `pending.length > 0`). The absent key is the "no suggestions"
    // signal that ShadowStartupCoordinator's no-op path relies on.
    const data = JSON.parse(fs.readFileSync(result.layout.pluginDataFile, 'utf-8'));
    expect(data.pendingPluginSuggestions).toBeUndefined();
  });

  it('omits suggestions when source community-plugins.json is invalid JSON', async () => {
    fs.writeFileSync(
      path.join(scratch.sourceConfigDir, 'community-plugins.json'),
      '{invalid!}',
    );
    const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
    const profile = makeProfile({ id: 'p1' });
    const result = await r.bootstrap(profile, [profile]);

    const data = JSON.parse(fs.readFileSync(result.layout.pluginDataFile, 'utf-8'));
    expect(data.pendingPluginSuggestions).toBeUndefined();
  });

  it('still lists a plugin suggestion even when its data.json is invalid JSON (sourceData is null)', async () => {
    fs.writeFileSync(
      path.join(scratch.sourceConfigDir, 'community-plugins.json'),
      JSON.stringify(['dataview']),
    );
    const dataviewDir = path.join(scratch.sourceConfigDir, 'plugins', 'dataview');
    fs.mkdirSync(dataviewDir, { recursive: true });
    fs.writeFileSync(path.join(dataviewDir, 'data.json'), '{invalid!}');

    const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
    const profile = makeProfile({ id: 'p1' });
    const result = await r.bootstrap(profile, [profile]);

    const data = JSON.parse(fs.readFileSync(result.layout.pluginDataFile, 'utf-8'));
    expect(data.pendingPluginSuggestions).toHaveLength(1);
    expect(data.pendingPluginSuggestions[0].id).toBe('dataview');
    expect(data.pendingPluginSuggestions[0].sourceData).toBeNull();
  });
});

describe('ShadowVaultBootstrap: readBaseDataJson parse-failure fallback', () => {
  let scratch: ReturnType<typeof makeScratch>;
  beforeEach(() => { scratch = makeScratch(); });
  afterEach(() => { scratch.cleanup(); });

  it('starts from {} when shadow data.json exists but contains invalid JSON', async () => {
    const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
    const profile = makeProfile({ id: 'p1' });

    const first = await r.bootstrap(profile, [profile]);

    // Corrupt the shadow data.json.
    fs.writeFileSync(first.layout.pluginDataFile, '{not json!}');

    // Second bootstrap should discard the corrupted file and rebuild from source or {}.
    const second = await r.bootstrap(profile, [profile]);
    const data = JSON.parse(fs.readFileSync(second.layout.pluginDataFile, 'utf-8'));
    // profiles and activeProfileId are always written — just assert they're present
    // and no crash occurred despite the corrupted input.
    expect(data.profiles).toEqual([profile]);
    expect(data.activeProfileId).toBe('p1');
  });
});

describe('ShadowVaultBootstrap: installPlugin symlink fallback', () => {
  let scratch: ReturnType<typeof makeScratch>;
  beforeEach(() => { scratch = makeScratch(); });
  afterEach(() => { scratch.cleanup(); vi.restoreAllMocks(); });

  it('falls back to copyFileSync when symlinkSync throws, and plugin files are still present', async () => {
    // Simulate an environment where symlinks are not permitted (e.g. restricted Windows).
    vi.spyOn(fs, 'symlinkSync').mockImplementation(() => {
      throw Object.assign(new Error('EPERM: operation not permitted, symlink'), { code: 'EPERM' });
    });

    const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
    const profile = makeProfile({ id: 'p1' });
    const result = await r.bootstrap(profile, [profile]);

    expect(result.pluginInstallMethod).toBe('copy');
    // The files should have been copied successfully.
    expect(fs.existsSync(path.join(result.layout.pluginDir, 'main.js'))).toBe(true);
    expect(fs.existsSync(path.join(result.layout.pluginDir, 'manifest.json'))).toBe(true);
  });
});

// ─── first-run state seeding (first-open deadlock fix) ───────────────────────

describe('ShadowVaultBootstrap — seedObsidianFirstRunState', () => {
  let scratch: ReturnType<typeof makeScratch>;
  beforeEach(() => { scratch = makeScratch(); });
  afterEach(() => { scratch.cleanup(); });

  it('first bootstrap writes a NON-EMPTY app.json + core-plugins.json', async () => {
    const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
    const profile = makeProfile({ id: 'p1' });
    const result = await r.bootstrap(profile, [profile]);

    const appPath = path.join(result.layout.configDir, 'app.json');
    const appRaw = fs.readFileSync(appPath, 'utf-8');
    // Non-empty is the whole point — an empty app.json is what made
    // Obsidian open the shadow vault in first-run/Restricted mode.
    expect(appRaw.trim().length).toBeGreaterThan(0);
    expect(JSON.parse(appRaw)).toEqual({ promptDelete: false });

    const core = JSON.parse(
      fs.readFileSync(path.join(result.layout.configDir, 'core-plugins.json'), 'utf-8'),
    );
    expect(Array.isArray(core)).toBe(true);
    expect(core).toContain('file-explorer');
  });

  it('re-seeds an EMPTY app.json (the field-observed deadlock state)', async () => {
    const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
    const profile = makeProfile({ id: 'p1' });
    const result = await r.bootstrap(profile, [profile]);

    const appPath = path.join(result.layout.configDir, 'app.json');
    fs.writeFileSync(appPath, '', 'utf-8'); // simulate the zero-byte app.json seen in the field

    await r.bootstrap(profile, [profile]); // re-bootstrap
    expect(fs.readFileSync(appPath, 'utf-8').trim().length).toBeGreaterThan(0);
    expect(JSON.parse(fs.readFileSync(appPath, 'utf-8'))).toEqual({ promptDelete: false });
  });

  it('re-seeds a "{}" app.json — Obsidian\'s ACTUAL first-run content', async () => {
    // The field deadlock state is NOT a zero-byte file: Obsidian
    // writes the literal `{}`. The old `.trim() === ''` check passed
    // `{}` through as "configured" and left the deadlock — this test
    // fails on that code and guards the fix.
    const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
    const profile = makeProfile({ id: 'p1' });
    const result = await r.bootstrap(profile, [profile]);

    const appPath = path.join(result.layout.configDir, 'app.json');
    fs.writeFileSync(appPath, '{}', 'utf-8'); // the real first-run placeholder

    await r.bootstrap(profile, [profile]); // re-bootstrap
    expect(JSON.parse(fs.readFileSync(appPath, 'utf-8'))).toEqual({ promptDelete: false });
  });

  it('re-seeds an empty "[]" core-plugins.json (was asymmetric with app.json)', async () => {
    const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
    const profile = makeProfile({ id: 'p1' });
    const result = await r.bootstrap(profile, [profile]);

    const corePath = path.join(result.layout.configDir, 'core-plugins.json');
    fs.writeFileSync(corePath, '[]', 'utf-8'); // empty array still deadlocks

    await r.bootstrap(profile, [profile]);
    const core = JSON.parse(fs.readFileSync(corePath, 'utf-8'));
    expect(Array.isArray(core)).toBe(true);
    expect(core).toContain('file-explorer');
  });

  it('does NOT swallow a non-ENOENT read error as "needs seed"', async () => {
    // A file that exists but cannot be read (here: app.json is a
    // DIRECTORY → EISDIR) must NOT be silently treated as absent and
    // overwritten — the old bare `catch { appNeedsSeed = true }` did
    // exactly that. It must surface, not clobber.
    const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
    const profile = makeProfile({ id: 'p1' });
    const result = await r.bootstrap(profile, [profile]);

    const appPath = path.join(result.layout.configDir, 'app.json');
    fs.rmSync(appPath, { force: true });
    fs.mkdirSync(appPath); // reading this throws EISDIR, not ENOENT

    // bootstrap() is `Promise.resolve(bootstrapSync())` — a non-ENOENT
    // read throws SYNCHRONOUSLY, before the promise is constructed.
    expect(() => r.bootstrap(profile, [profile])).toThrow(/EISDIR/);
    // and it must NOT have replaced the directory with a seeded file
    expect(fs.statSync(appPath).isDirectory()).toBe(true);
  });

  it('does NOT clobber a real app.json (left by settings sync or Obsidian)', async () => {
    const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
    const profile = makeProfile({ id: 'p1' });
    const result = await r.bootstrap(profile, [profile]);

    const appPath = path.join(result.layout.configDir, 'app.json');
    const real = JSON.stringify({ theme: 'obsidian', baseFontSize: 16 });
    fs.writeFileSync(appPath, real, 'utf-8');

    await r.bootstrap(profile, [profile]); // re-bootstrap must preserve it
    expect(fs.readFileSync(appPath, 'utf-8')).toBe(real);
  });

  it('does NOT clobber an existing core-plugins.json', async () => {
    const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
    const profile = makeProfile({ id: 'p1' });
    const result = await r.bootstrap(profile, [profile]);

    const corePath = path.join(result.layout.configDir, 'core-plugins.json');
    const custom = JSON.stringify(['file-explorer', 'graph']);
    fs.writeFileSync(corePath, custom, 'utf-8');

    await r.bootstrap(profile, [profile]);
    expect(fs.readFileSync(corePath, 'utf-8')).toBe(custom);
  });
});

// ─── community-plugins round-trip (#429 / #342 residual) ────────────────
//
// app/appearance/core-plugins/hotkeys already round-trip via
// the per-device settings round-trip, but the *enabled community-plugins*
// list does NOT: it is only ever seeded locally as ["remote-ssh"]
// (see the bootstrap suite above). So a plugin enabled on machine A
// never reaches machine B's shadow vault, and reopening the vault
// "loses" installed plugins — exactly kazink's #429 follow-up and the
// #342 residual.
//
// community-plugins.json must NOT join the verbatim
// SHARED_OBSIDIAN_CONFIG_FILES set: a remote list that happens to omit
// `remote-ssh` would, written verbatim, disable the very plugin doing
// the sync. The fix is a dedicated pull/push pair that round-trips the
// list while always keeping `remote-ssh` enabled. These fail today —
// the methods do not exist yet.
describe('ShadowVaultBootstrap community-plugins round-trip (#429 / #342)', () => {
  function makeLocalConfigDir(seed: string[] = ['remote-ssh']): string {
    const dir = path.join(
      os.tmpdir(),
      `cp-roundtrip-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      '.obsidian',
    );
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'community-plugins.json'), JSON.stringify(seed), 'utf-8');
    return dir;
  }
  function readLocal(dir: string): string[] {
    return JSON.parse(fs.readFileSync(path.join(dir, 'community-plugins.json'), 'utf-8'));
  }

  it('pulls the remote enabled-plugin list into the shadow vault, keeping remote-ssh enabled', async () => {
    const localConfigDir = makeLocalConfigDir(['remote-ssh']);
    const remote: Record<string, string> = {
      '.obsidian/community-plugins.json': JSON.stringify(['dataview', 'templater']),
    };
    const reader: ConfigReader = {
      exists: (p) => Promise.resolve(p in remote),
      read: (p) => Promise.resolve(remote[p]),
    };

    await ShadowVaultBootstrap.pullCommunityPlugins(reader, '.obsidian', localConfigDir);

    expect(readLocal(localConfigDir)).toEqual(
      expect.arrayContaining(['dataview', 'templater', 'remote-ssh']),
    );
  });

  it('keeps remote-ssh enabled even when the remote list omits it', async () => {
    const localConfigDir = makeLocalConfigDir(['remote-ssh']);
    const remote: Record<string, string> = {
      '.obsidian/community-plugins.json': JSON.stringify(['dataview']),
    };
    const reader: ConfigReader = {
      exists: (p) => Promise.resolve(p in remote),
      read: (p) => Promise.resolve(remote[p]),
    };

    await ShadowVaultBootstrap.pullCommunityPlugins(reader, '.obsidian', localConfigDir);

    const local = readLocal(localConfigDir);
    expect(local, 'remote-ssh must survive a pull that omits it').toContain('remote-ssh');
    expect(local).toContain('dataview');
  });

  it('is a benign no-op when the remote has no community-plugins.json yet', async () => {
    const localConfigDir = makeLocalConfigDir(['remote-ssh']);
    const reader: ConfigReader = {
      exists: () => Promise.resolve(false),
      read: () => Promise.reject(new Error('must not read an absent file')),
    };

    await expect(
      ShadowVaultBootstrap.pullCommunityPlugins(reader, '.obsidian', localConfigDir),
    ).resolves.toBeDefined();
    expect(readLocal(localConfigDir)).toEqual(['remote-ssh']);
  });

  it('does not clobber a healthy local list when the remote list is corrupt JSON', async () => {
    const localConfigDir = makeLocalConfigDir(['remote-ssh', 'dataview']);
    const remote: Record<string, string> = {
      '.obsidian/community-plugins.json': '{ this is : not json',
    };
    const reader: ConfigReader = {
      exists: (p) => Promise.resolve(p in remote),
      read: (p) => Promise.resolve(remote[p]),
    };

    await ShadowVaultBootstrap.pullCommunityPlugins(reader, '.obsidian', localConfigDir);

    expect(readLocal(localConfigDir)).toEqual(
      expect.arrayContaining(['remote-ssh', 'dataview']),
    );
  });

  it('drops enabled-plugin ids that are not a single path segment, so they are not kept for a plugin-path pull', async () => {
    const localConfigDir = makeLocalConfigDir(['remote-ssh', 'nested/id']);
    const remote: Record<string, string> = {
      '.obsidian/community-plugins.json': JSON.stringify(['dataview', '', '.', '..', '../escaped', 'win\\id', 'C:dataview']),
    };
    const reader: ConfigReader = {
      exists: (p) => Promise.resolve(p in remote),
      read: (p) => Promise.resolve(remote[p]),
    };

    const { merged } = await ShadowVaultBootstrap.pullCommunityPlugins(reader, '.obsidian', localConfigDir);

    expect(merged).toEqual(['remote-ssh', 'dataview']);
    expect(readLocal(localConfigDir)).toEqual(['remote-ssh', 'dataview']);
    expect(ShadowVaultBootstrap.readEnabledPluginIds(localConfigDir)).toEqual(['remote-ssh', 'dataview']);
  });

  // Reader+writer fake backed by an in-memory store. `read` can be made
  // to throw to simulate a transient SSH error mid-read.
  function makeRemoteRW(initial?: string[], readThrows = false): {
    rw: ConfigReader & ConfigWriter;
    store: Record<string, string>;
  } {
    const store: Record<string, string> = {};
    if (initial) store['.obsidian/community-plugins.json'] = JSON.stringify(initial);
    const rw: ConfigReader & ConfigWriter = {
      exists: (p) => Promise.resolve(p in store),
      read: (p) => (readThrows ? Promise.reject(new Error('SSH hiccup')) : Promise.resolve(store[p])),
      write: (p, c) => { store[p] = c; return Promise.resolve(); },
    };
    return { rw, store };
  }

  it('seeds the remote (union with local) when the remote has none yet', async () => {
    const localConfigDir = makeLocalConfigDir(['remote-ssh', 'dataview']);
    const { rw, store } = makeRemoteRW();
    await ShadowVaultBootstrap.pushCommunityPlugins(rw, '.obsidian', localConfigDir);
    expect(store['.obsidian/community-plugins.json'], 'a push must seed the remote').toBeDefined();
    expect(JSON.parse(store['.obsidian/community-plugins.json'])).toEqual(
      expect.arrayContaining(['dataview', 'remote-ssh']),
    );
  });

  it('unions with the remote list and never drops a plugin enabled elsewhere', async () => {
    const localConfigDir = makeLocalConfigDir(['remote-ssh', 'templater']);
    const { rw, store } = makeRemoteRW(['remote-ssh', 'dataview']);
    await ShadowVaultBootstrap.pushCommunityPlugins(rw, '.obsidian', localConfigDir);
    const pushed = JSON.parse(store['.obsidian/community-plugins.json']);
    expect(pushed, 'remote dataview must survive + local templater added')
      .toEqual(expect.arrayContaining(['dataview', 'templater', 'remote-ssh']));
  });

  it('does NOT clobber the remote when the remote read fails (transient SSH error)', async () => {
    const localConfigDir = makeLocalConfigDir(['remote-ssh']); // minimal local
    const { rw, store } = makeRemoteRW(['remote-ssh', 'dataview', 'obsidian-git'], /*readThrows*/ true);
    const before = store['.obsidian/community-plugins.json'];
    const r = await ShadowVaultBootstrap.pushCommunityPlugins(rw, '.obsidian', localConfigDir);
    expect(r.pushed).toBe(false);
    expect(store['.obsidian/community-plugins.json'], 'remote list must be untouched (no data loss)').toBe(before);
  });

  it('does NOT clobber the remote when the remote list is corrupt JSON', async () => {
    const localConfigDir = makeLocalConfigDir(['remote-ssh']);
    const { rw, store } = makeRemoteRW();
    store['.obsidian/community-plugins.json'] = '{ not : json';
    const r = await ShadowVaultBootstrap.pushCommunityPlugins(rw, '.obsidian', localConfigDir);
    expect(r.pushed).toBe(false);
    expect(store['.obsidian/community-plugins.json']).toBe('{ not : json');
  });
});

// ─── uninstall: 3-way merge against a per-device base ───────────────────
//
// The union above is MONOTONIC: `community-plugins.json` could only ever
// GROW, so uninstalling a plugin on one device never reached the remote
// and the next pull RESURRECTED it locally — a fleet-wide uninstall was
// impossible (pinned by e2e/plugin-code-roundtrip.spec.ts test 6).
//
// The fix is a 3-way merge against a BASE: the converged list as of the
// END of the last successful round-trip ON THIS DEVICE, stored outside
// every vault at `~/.obsidian-remote/state/<profile-id>/`. `base \ local`
// is a local uninstall, `base \ remote` a remote one; anything absent from
// the base is an addition. With no base yet, a removal is indistinguishable
// from never-had, so it degrades to the old union (nothing is lost).
describe('ShadowVaultBootstrap community-plugins 3-way merge (uninstall propagation)', () => {
  let scratchRoot: string;

  beforeEach(() => {
    scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-3way-'));
  });
  afterEach(() => {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  });

  const SELF = ShadowVaultBootstrap.SELF_PLUGIN_ID; // 'remote-ssh'
  const CP = '.obsidian/community-plugins.json';

  /** A shadow config dir seeded with `local`. */
  function makeLocal(local: string[]): string {
    const dir = path.join(scratchRoot, `vault-${Math.random().toString(36).slice(2)}`, '.obsidian');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'community-plugins.json'), JSON.stringify(local), 'utf-8');
    return dir;
  }
  const readLocal = (dir: string): string[] =>
    JSON.parse(fs.readFileSync(path.join(dir, 'community-plugins.json'), 'utf-8')) as string[];

  /** The per-device base path, optionally pre-seeded (omitted = no base yet). */
  function basePathFor(seed?: string[]): string {
    const p = ShadowVaultBootstrap.communityPluginsBasePath(scratchRoot, 'profile-1');
    if (seed) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(seed), 'utf-8');
    }
    return p;
  }
  const readBase = (p: string): string[] =>
    JSON.parse(fs.readFileSync(p, 'utf-8')) as string[];

  /** In-memory remote. `initial === null` → the remote has no list at all. */
  function makeRemote(initial: string[] | null): {
    rw: ConfigReader & ConfigWriter;
    read: () => string[] | null;
  } {
    const store: Record<string, string> = {};
    if (initial !== null) store[CP] = JSON.stringify(initial);
    return {
      rw: {
        exists: (p) => Promise.resolve(p in store),
        read: (p) => Promise.resolve(store[p]),
        write: (p, c) => { store[p] = c; return Promise.resolve(); },
      },
      read: () => (CP in store ? (JSON.parse(store[CP]) as string[]) : null),
    };
  }

  /** One full connect round-trip: pull, then push — exactly what main.ts does. */
  async function roundTrip(
    rw: ConfigReader & ConfigWriter,
    localConfigDir: string,
    basePath: string,
  ): Promise<void> {
    await ShadowVaultBootstrap.pullCommunityPlugins(rw, '.obsidian', localConfigDir, basePath);
    await ShadowVaultBootstrap.pushCommunityPlugins(rw, '.obsidian', localConfigDir, basePath);
  }

  it('falls back to a UNION when there is no base yet (first run — nothing is lost)', async () => {
    // Local has `templater`, the remote has `dataview`, and this device has
    // never synced. Neither absence may be read as a removal.
    const localDir = makeLocal([SELF, 'templater']);
    const { rw, read } = makeRemote([SELF, 'dataview']);
    const basePath = basePathFor(); // no base on disk

    await roundTrip(rw, localDir, basePath);

    expect(readLocal(localDir)).toEqual(expect.arrayContaining([SELF, 'templater', 'dataview']));
    expect(read()).toEqual(expect.arrayContaining([SELF, 'templater', 'dataview']));
    // …and the round-trip has now RECORDED a base, so the next connect can
    // infer removals.
    expect(readBase(basePath)).toEqual(expect.arrayContaining([SELF, 'templater', 'dataview']));
  });

  it('propagates a LOCAL removal to the remote (the uninstall the e2e pins)', async () => {
    // Steady state: both sides and the base agree on [remote-ssh, dataview].
    const localDir = makeLocal([SELF, 'dataview']);
    const { rw, read } = makeRemote([SELF, 'dataview']);
    const basePath = basePathFor([SELF, 'dataview']);

    // The user uninstalls `dataview` in this vault.
    fs.writeFileSync(
      path.join(localDir, 'community-plugins.json'), JSON.stringify([SELF]), 'utf-8',
    );

    await roundTrip(rw, localDir, basePath);

    expect(read(), 'the uninstall must reach the remote — otherwise no device can ever drop it')
      .toEqual([SELF]);
    expect(readLocal(localDir), 'and the pull must not resurrect it locally').toEqual([SELF]);
    expect(readBase(basePath)).toEqual([SELF]);
  });

  it('propagates a REMOTE removal into the local list (uninstalled on another device)', async () => {
    // This device was offline while machine B uninstalled `dataview`, so its
    // base is stale — which is exactly how the removal is detected.
    const localDir = makeLocal([SELF, 'dataview']);
    const { rw, read } = makeRemote([SELF]);
    const basePath = basePathFor([SELF, 'dataview']);

    await roundTrip(rw, localDir, basePath);

    expect(readLocal(localDir), 'a plugin removed on another device must be dropped here')
      .toEqual([SELF]);
    expect(read()).toEqual([SELF]);
    expect(readBase(basePath)).toEqual([SELF]);
  });

  it('still sends a LOCAL addition to the remote (existing behaviour preserved)', async () => {
    const localDir = makeLocal([SELF, 'dataview', 'templater']); // templater just enabled
    const { rw, read } = makeRemote([SELF, 'dataview']);
    const basePath = basePathFor([SELF, 'dataview']);

    await roundTrip(rw, localDir, basePath);

    expect(read()).toEqual(expect.arrayContaining([SELF, 'dataview', 'templater']));
    expect(readLocal(localDir)).toEqual(expect.arrayContaining([SELF, 'dataview', 'templater']));
  });

  it('still pulls a REMOTE addition into the local list (existing behaviour preserved)', async () => {
    const localDir = makeLocal([SELF, 'dataview']);
    const { rw } = makeRemote([SELF, 'dataview', 'obsidian-git']); // enabled on machine B
    const basePath = basePathFor([SELF, 'dataview']);

    await roundTrip(rw, localDir, basePath);

    expect(readLocal(localDir)).toEqual(expect.arrayContaining([SELF, 'dataview', 'obsidian-git']));
  });

  it('never lets remote-ssh be removed — from either side', async () => {
    // Both sides "uninstalled" it: the local list dropped it, the remote list
    // omits it, and the base says both once had it. It must still survive —
    // it IS the sync.
    const localDir = makeLocal(['dataview']);          // no remote-ssh
    const { rw, read } = makeRemote(['dataview']);     // no remote-ssh
    const basePath = basePathFor([SELF, 'dataview']);  // base says both had it

    await roundTrip(rw, localDir, basePath);

    expect(readLocal(localDir), 'remote-ssh must never be uninstallable locally').toContain(SELF);
    expect(read(), 'remote-ssh must never be uninstallable remotely').toContain(SELF);
  });

  it('resolves concurrent add-vs-remove in favour of the ADD (documented tie-break)', async () => {
    // Machine B uninstalled `dataview` and pushed, so the remote no longer
    // names it. Meanwhile this device installed `dataview` fresh — it is
    // absent from THIS device's base, so it is an ADDITION, not a leftover.
    // Add wins: losing a plugin you just installed is invisible data loss.
    const localDir = makeLocal([SELF, 'dataview']);
    const { rw, read } = makeRemote([SELF]);
    const basePath = basePathFor([SELF]); // dataview never in this device's base

    await roundTrip(rw, localDir, basePath);

    expect(readLocal(localDir), 'a plugin this device just installed must not vanish')
      .toEqual(expect.arrayContaining([SELF, 'dataview']));
    expect(read(), 'and the addition must reach the remote')
      .toEqual(expect.arrayContaining([SELF, 'dataview']));
  });

  it('does not infer removals from a remote it could not read (no base-driven wipe)', async () => {
    // Transient SSH error mid-read. `base \ remote` must NOT be taken to mean
    // "everything was uninstalled elsewhere".
    const localDir = makeLocal([SELF, 'dataview', 'templater']);
    const basePath = basePathFor([SELF, 'dataview', 'templater']);
    const rw: ConfigReader & ConfigWriter = {
      exists: () => Promise.resolve(true),
      read: () => Promise.reject(new Error('SSH hiccup')),
      write: () => Promise.reject(new Error('must not push a list built from an unread remote')),
    };

    await ShadowVaultBootstrap.pullCommunityPlugins(rw, '.obsidian', localDir, basePath);
    const r = await ShadowVaultBootstrap.pushCommunityPlugins(rw, '.obsidian', localDir, basePath);

    expect(r.pushed).toBe(false);
    expect(readLocal(localDir), 'the local list must survive an unreadable remote intact')
      .toEqual([SELF, 'dataview', 'templater']);
    expect(readBase(basePath), 'and the base must be left alone so the merge retries next connect')
      .toEqual([SELF, 'dataview', 'templater']);
  });

  it('does not infer removals when the remote has no list yet (absent ≠ emptied)', async () => {
    const localDir = makeLocal([SELF, 'dataview']);
    const { rw, read } = makeRemote(null); // fresh remote, no file at all
    const basePath = basePathFor([SELF, 'dataview']);

    await roundTrip(rw, localDir, basePath);

    expect(readLocal(localDir)).toEqual([SELF, 'dataview']);
    expect(read(), 'a fresh remote is seeded from local, not emptied by the base')
      .toEqual([SELF, 'dataview']);
  });

  it('is idempotent across pre-spawn pull + connect pull + connect push (no double-apply)', async () => {
    // preSpawnPull pulls with the SAME base and must not commit it — otherwise
    // the connect's push would read this device's local additions as remote
    // removals and delete them.
    const localDir = makeLocal([SELF, 'dataview', 'templater']);        // templater added here
    const { rw, read } = makeRemote([SELF, 'dataview', 'obsidian-git']); // git added on B
    const basePath = basePathFor([SELF, 'dataview']);

    // pre-spawn: pull only — must NOT commit the base
    await ShadowVaultBootstrap.pullCommunityPlugins(rw, '.obsidian', localDir, basePath);
    expect(readBase(basePath), 'a pull must never commit the base').toEqual([SELF, 'dataview']);

    // …then the real connect.
    await roundTrip(rw, localDir, basePath);

    const converged = [SELF, 'dataview', 'templater', 'obsidian-git'];
    expect(readLocal(localDir)).toEqual(expect.arrayContaining(converged));
    expect(read(), 'the local addition must survive the pre-spawn pull + push sequence')
      .toEqual(expect.arrayContaining(converged));

    // A second connect over the now-committed base changes nothing.
    await roundTrip(rw, localDir, basePath);
    expect(readLocal(localDir)).toEqual(expect.arrayContaining(converged));
    expect(read()).toEqual(expect.arrayContaining(converged));
  });

  it('discards a stale base when the shadow vault is bootstrapped fresh (deleted-vault recovery)', async () => {
    // The user deletes ~/.obsidian-remote/vaults/<v> and reconnects. A
    // leftover base would make the fresh `["remote-ssh"]` seed look like a
    // mass uninstall and strip the remote — so a first bootstrap drops it.
    const baseDir = path.join(scratchRoot, 'vaults');
    const sourceDir = path.join(scratchRoot, 'source-plugin');
    fs.mkdirSync(sourceDir, { recursive: true });
    const profile = makeProfile({ id: 'profile-1' });

    const stalePath = basePathFor([SELF, 'dataview']);
    expect(fs.existsSync(stalePath)).toBe(true);

    const configPath = path.join(scratchRoot, 'obsidian.json');
    fs.writeFileSync(configPath, JSON.stringify({ vaults: {} }), 'utf-8');
    const boot = new ShadowVaultBootstrap(
      baseDir, sourceDir, new ObsidianRegistry(configPath), scratchRoot,
    );
    const { layout } = await boot.bootstrap(profile, [profile]);

    expect(fs.existsSync(stalePath), 'a first bootstrap must discard the stale base').toBe(false);

    // …so the round-trip degrades to a union and the remote keeps dataview.
    const { rw, read } = makeRemote([SELF, 'dataview']);
    await roundTrip(rw, layout.configDir, stalePath);
    expect(read()).toEqual(expect.arrayContaining([SELF, 'dataview']));
    expect(readLocal(layout.configDir)).toEqual(expect.arrayContaining([SELF, 'dataview']));
  });
});

describe('ShadowVaultBootstrap plugin-binary round-trip (#429b — BRAT / non-marketplace)', () => {
  function makeLocalConfigDir(): string {
    const dir = path.join(
      os.tmpdir(),
      `bin-roundtrip-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      '.obsidian',
    );
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  const pluginFile = (cfg: string, id: string, file: string) => path.join(cfg, 'plugins', id, file);
  function seedLocal(cfg: string, id: string, file: string, content: string): void {
    fs.mkdirSync(path.dirname(pluginFile(cfg, id, file)), { recursive: true });
    fs.writeFileSync(pluginFile(cfg, id, file), content, 'utf-8');
  }

  // Reader+writer fake over an in-memory store keyed by remote rel path.
  function makeRW(seed: Record<string, string> = {}): {
    rw: ConfigReader & ConfigWriter;
    store: Record<string, string>;
  } {
    const store: Record<string, string> = { ...seed };
    const rw: ConfigReader & ConfigWriter = {
      exists: (p) => Promise.resolve(p in store),
      read: (p) => Promise.resolve(store[p]),
      write: (p, c) => { store[p] = c; return Promise.resolve(); },
    };
    return { rw, store };
  }

  // A manifest.json body carrying the version the round-trip orders on.
  const manifest = (id: string, version: string) => JSON.stringify({ id, version });

  it('pulls a plugin that is ABSENT locally (fresh install from the remote)', async () => {
    const cfg = makeLocalConfigDir();
    const { rw } = makeRW({
      '.obsidian/plugins/brat-x/manifest.json': manifest('brat-x', '1.0.0'),
      '.obsidian/plugins/brat-x/main.js': '/* brat code */\n',
    });

    const { pulled } = await ShadowVaultBootstrap.pullPluginBinaries(rw, '.obsidian', cfg, ['brat-x']);

    expect(pulled).toContain('brat-x');
    expect(fs.readFileSync(pluginFile(cfg, 'brat-x', 'main.js'), 'utf-8')).toBe('/* brat code */\n');
    expect(fs.existsSync(pluginFile(cfg, 'brat-x', 'manifest.json'))).toBe(true);
  });

  it('UPGRADES a local plugin when the remote is a strictly newer version', async () => {
    const cfg = makeLocalConfigDir();
    seedLocal(cfg, 'p', 'manifest.json', manifest('p', '1.0.0'));
    seedLocal(cfg, 'p', 'main.js', '/* OLD v1 */\n');
    const { rw } = makeRW({
      '.obsidian/plugins/p/manifest.json': manifest('p', '2.0.0'),
      '.obsidian/plugins/p/main.js': '/* NEW v2 */\n',
    });

    await ShadowVaultBootstrap.pullPluginBinaries(rw, '.obsidian', cfg, ['p']);

    expect(fs.readFileSync(pluginFile(cfg, 'p', 'main.js'), 'utf-8'), 'newer remote must upgrade local')
      .toBe('/* NEW v2 */\n');
  });

  it('does NOT downgrade a local plugin when the remote is OLDER (#429b clobber guard)', async () => {
    const cfg = makeLocalConfigDir();
    seedLocal(cfg, 'p', 'manifest.json', manifest('p', '2.0.0'));
    seedLocal(cfg, 'p', 'main.js', '/* NEW v2 */\n');
    const { rw } = makeRW({
      '.obsidian/plugins/p/manifest.json': manifest('p', '1.0.0'),
      '.obsidian/plugins/p/main.js': '/* OLD v1 */\n',
    });

    await ShadowVaultBootstrap.pullPluginBinaries(rw, '.obsidian', cfg, ['p']);

    expect(fs.readFileSync(pluginFile(cfg, 'p', 'main.js'), 'utf-8'), 'older remote must NOT clobber newer local')
      .toBe('/* NEW v2 */\n');
  });

  it('is a no-op when the remote has no manifest (nothing to pull)', async () => {
    const cfg = makeLocalConfigDir();
    const { rw } = makeRW({ '.obsidian/plugins/p/main.js': '/* orphan main, no manifest */\n' });

    const { pulled } = await ShadowVaultBootstrap.pullPluginBinaries(rw, '.obsidian', cfg, ['p']);

    expect(pulled).not.toContain('p');
    expect(fs.existsSync(pluginFile(cfg, 'p', 'main.js'))).toBe(false);
  });

  it('skips remote-ssh on pull — the plugin manages its own install', async () => {
    const cfg = makeLocalConfigDir();
    const { rw } = makeRW({ '.obsidian/plugins/remote-ssh/manifest.json': manifest('remote-ssh', '9.9.9') });

    const { pulled } = await ShadowVaultBootstrap.pullPluginBinaries(rw, '.obsidian', cfg, ['remote-ssh']);

    expect(pulled).not.toContain('remote-ssh');
    expect(fs.existsSync(pluginFile(cfg, 'remote-ssh', 'manifest.json'))).toBe(false);
  });

  it('seeds the remote when it LACKS the plugin (push)', async () => {
    const cfg = makeLocalConfigDir();
    seedLocal(cfg, 'q', 'manifest.json', manifest('q', '1.0.0'));
    seedLocal(cfg, 'q', 'main.js', '/* q code */\n');
    const { rw, store } = makeRW();

    const { pushed } = await ShadowVaultBootstrap.pushPluginBinaries(rw, '.obsidian', cfg, ['q']);

    expect(pushed).toContain('q');
    expect(store['.obsidian/plugins/q/main.js']).toBe('/* q code */\n');
    expect(store['.obsidian/plugins/q/manifest.json']).toBe(manifest('q', '1.0.0'));
  });

  it('pushes an UPGRADE when the local copy is a strictly newer version', async () => {
    const cfg = makeLocalConfigDir();
    seedLocal(cfg, 'q', 'manifest.json', manifest('q', '2.0.0'));
    seedLocal(cfg, 'q', 'main.js', '/* NEW v2 */\n');
    const { rw, store } = makeRW({
      '.obsidian/plugins/q/manifest.json': manifest('q', '1.0.0'),
      '.obsidian/plugins/q/main.js': '/* OLD v1 */\n',
    });

    const { pushed } = await ShadowVaultBootstrap.pushPluginBinaries(rw, '.obsidian', cfg, ['q']);

    expect(pushed).toContain('q');
    expect(store['.obsidian/plugins/q/main.js'], 'newer local must upgrade the remote').toBe('/* NEW v2 */\n');
  });

  it('does NOT downgrade the remote when the local copy is OLDER (#429b clobber guard)', async () => {
    const cfg = makeLocalConfigDir();
    seedLocal(cfg, 'q', 'manifest.json', manifest('q', '1.0.0'));
    seedLocal(cfg, 'q', 'main.js', '/* OLD v1 */\n');
    const { rw, store } = makeRW({
      '.obsidian/plugins/q/manifest.json': manifest('q', '2.0.0'),
      '.obsidian/plugins/q/main.js': '/* NEW v2 */\n',
    });

    const { pushed } = await ShadowVaultBootstrap.pushPluginBinaries(rw, '.obsidian', cfg, ['q']);

    expect(pushed).not.toContain('q');
    expect(store['.obsidian/plugins/q/main.js'], 'older local must NOT clobber newer remote').toBe('/* NEW v2 */\n');
  });

  it('push is skipped when the local plugin has no manifest', async () => {
    const cfg = makeLocalConfigDir();
    seedLocal(cfg, 'r', 'main.js', '/* code, no manifest */\n');
    const { rw, store } = makeRW();

    const { pushed } = await ShadowVaultBootstrap.pushPluginBinaries(rw, '.obsidian', cfg, ['r']);

    expect(pushed).not.toContain('r');
    expect(store['.obsidian/plugins/r/main.js']).toBeUndefined();
  });

  it('CONVERGES without ping-pong: pull an upgrade, then push is a no-op', async () => {
    const cfg = makeLocalConfigDir();
    seedLocal(cfg, 'c', 'manifest.json', manifest('c', '1.0.0'));
    seedLocal(cfg, 'c', 'main.js', '/* v1 */\n');
    const { rw, store } = makeRW({
      '.obsidian/plugins/c/manifest.json': manifest('c', '2.0.0'),
      '.obsidian/plugins/c/main.js': '/* v2 */\n',
    });

    // Round 1 pull: the newer remote upgrades local to v2.
    await ShadowVaultBootstrap.pullPluginBinaries(rw, '.obsidian', cfg, ['c']);
    expect(fs.readFileSync(pluginFile(cfg, 'c', 'main.js'), 'utf-8')).toBe('/* v2 */\n');

    // Then push: local == remote (both v2) → nothing pushed, no oscillation.
    const { pushed } = await ShadowVaultBootstrap.pushPluginBinaries(rw, '.obsidian', cfg, ['c']);
    expect(pushed, 'after converging on v2 the push must be a no-op').not.toContain('c');
    expect(store['.obsidian/plugins/c/main.js']).toBe('/* v2 */\n');
  });

  it('a per-plugin SSH error is swallowed and does not abort the batch', async () => {
    const cfg = makeLocalConfigDir();
    const { rw } = makeRW({
      '.obsidian/plugins/bad/manifest.json': manifest('bad', '1.0.0'),
      '.obsidian/plugins/good/manifest.json': manifest('good', '1.0.0'),
      '.obsidian/plugins/good/main.js': '/* good */\n',
    });
    const origRead = rw.read;
    rw.read = (p) => (p.includes('/bad/') ? Promise.reject(new Error('SSH hiccup')) : origRead(p));

    const { pulled } = await ShadowVaultBootstrap.pullPluginBinaries(rw, '.obsidian', cfg, ['bad', 'good']);

    expect(pulled, 'good pulls even though bad errored').toContain('good');
    expect(pulled).not.toContain('bad');
  });

  it('does not write plugin code outside the local plugins directory', async () => {
    const cfg = makeLocalConfigDir();
    const pluginsDir = path.join(cfg, 'plugins');
    const escapedName = `escaped-${process.pid}`;
    const parentEscape = `../../${escapedName}`;
    const siblingEscape = '../plugins-evil';
    const parentVictim = path.resolve(cfg, '..', escapedName, 'main.js');
    const siblingVictim = path.join(cfg, 'plugins-evil', 'main.js');
    const seen: string[] = [];
    const { rw } = makeRW({
      [`.obsidian/plugins/${parentEscape}/manifest.json`]: manifest('x', '1.0.0'),
      [`.obsidian/plugins/${parentEscape}/main.js`]: '/* escaped */\n',
      [`.obsidian/plugins/${siblingEscape}/manifest.json`]: manifest('y', '1.0.0'),
      [`.obsidian/plugins/${siblingEscape}/main.js`]: '/* sibling */\n',
      '.obsidian/plugins/brat-x/manifest.json': manifest('brat-x', '1.0.0'),
      '.obsidian/plugins/brat-x/main.js': '/* brat code */\n',
    });
    const exists = rw.exists.bind(rw);
    const read = rw.read.bind(rw);
    rw.exists = (p) => { seen.push(p); return exists(p); };
    rw.read = (p) => { seen.push(p); return read(p); };

    const { pulled } = await ShadowVaultBootstrap.pullPluginBinaries(
      rw, '.obsidian', cfg, [parentEscape, siblingEscape, 'brat-x'],
    );

    expect(pulled).not.toContain(parentEscape);
    expect(pulled).not.toContain(siblingEscape);
    expect(seen.some((p) => p.includes('..') || p.includes('plugins-evil'))).toBe(false);
    expect(fs.existsSync(parentVictim), 'a .. id must not write outside the plugins directory').toBe(false);
    expect(fs.existsSync(siblingVictim), 'a sibling of the plugins directory must not be written').toBe(false);
    expect(fs.existsSync(path.join(pluginsDir, escapedName)), 'the escaped id must not be created under plugins').toBe(false);
    expect(pulled).toContain('brat-x');
    expect(fs.readFileSync(pluginFile(cfg, 'brat-x', 'main.js'), 'utf-8')).toBe('/* brat code */\n');
  });

  it('does not follow a plugin-directory symlink out of the local plugins directory', async () => {
    const cfg = makeLocalConfigDir();
    const pluginsDir = path.join(cfg, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-pull-outside-'));
    const outsideMain = path.join(outside, 'main.js');
    fs.writeFileSync(outsideMain, 'keep', 'utf-8');
    const link = path.join(pluginsDir, 'evil');
    try {
      fs.symlinkSync(outside, link, 'dir');
    } catch (e) {
      console.warn(`skipping: cannot create symlink in test env: ${(e as Error).message}`);
      return;
    }
    const { rw } = makeRW({
      '.obsidian/plugins/evil/manifest.json': manifest('evil', '1.0.0'),
      '.obsidian/plugins/evil/main.js': '/* pwned */\n',
    });

    const { pulled } = await ShadowVaultBootstrap.pullPluginBinaries(rw, '.obsidian', cfg, ['evil']);

    expect(pulled).not.toContain('evil');
    expect(fs.readFileSync(outsideMain, 'utf-8'), 'pull must not write through a symlinked plugin dir').toBe('keep');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it('does not follow a plugin-file symlink out of the local plugins directory', async () => {
    const cfg = makeLocalConfigDir();
    const pluginDir = path.join(cfg, 'plugins', 'evil');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'manifest.json'), manifest('evil', '1.0.0'), 'utf-8');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-pull-file-'));
    const outsideMain = path.join(outside, 'main.js');
    fs.writeFileSync(outsideMain, 'keep', 'utf-8');
    const link = path.join(pluginDir, 'main.js');
    try {
      fs.symlinkSync(outsideMain, link);
    } catch (e) {
      console.warn(`skipping: cannot create symlink in test env: ${(e as Error).message}`);
      return;
    }
    const { rw } = makeRW({
      '.obsidian/plugins/evil/manifest.json': manifest('evil', '2.0.0'),
      '.obsidian/plugins/evil/main.js': '/* pwned */\n',
    });

    const { pulled } = await ShadowVaultBootstrap.pullPluginBinaries(rw, '.obsidian', cfg, ['evil']);

    expect(pulled).not.toContain('evil');
    expect(fs.readFileSync(outsideMain, 'utf-8'), 'pull must not overwrite a symlinked code file').toBe('keep');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it('keeps only a single path segment when the enabled-plugin list is parsed', () => {
    const cfg = makeLocalConfigDir();
    fs.writeFileSync(
      path.join(cfg, 'community-plugins.json'),
      JSON.stringify(['dataview', '', '.', '..', 'nested/id', 'win\\id', 'C:remote-ssh', 'templater-obsidian']),
      'utf-8',
    );

    expect(ShadowVaultBootstrap.readEnabledPluginIds(cfg)).toEqual(['dataview', 'templater-obsidian']);
  });

  it('does not follow a symlink at the atomic temp path', async () => {
    const cfg = makeLocalConfigDir();
    const pluginDir = path.join(cfg, 'plugins', 'evil');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'manifest.json'), manifest('evil', '1.0.0'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-pull-tmp-'));
    const victim = path.join(outside, 'secret.js');
    fs.writeFileSync(victim, 'keep', 'utf-8');
    const tmpLink = path.join(pluginDir, `main.js.${process.pid}.tmp`);
    fs.symlinkSync(victim, tmpLink);
    const { rw } = makeRW({
      '.obsidian/plugins/evil/manifest.json': manifest('evil', '2.0.0'),
      '.obsidian/plugins/evil/main.js': '/* pwned */\n',
    });

    const { pulled } = await ShadowVaultBootstrap.pullPluginBinaries(rw, '.obsidian', cfg, ['evil']);

    expect(fs.readFileSync(victim, 'utf-8')).toBe('keep');
    expect(pulled).not.toContain('evil');
    expect(fs.lstatSync(tmpLink).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(pluginDir, 'main.js'))).toBe(false);
  });

  it('does not follow a symlink at the atomic-write temp path', async () => {
    const cfg = makeLocalConfigDir();
    const pluginDir = path.join(cfg, 'plugins', 'evil');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'manifest.json'), manifest('evil', '1.0.0'), 'utf-8');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-pull-tmp-'));
    const outsideMain = path.join(outside, 'main.js');
    fs.writeFileSync(outsideMain, 'keep', 'utf-8');
    fs.symlinkSync(outsideMain, path.join(pluginDir, `main.js.${process.pid}.tmp`));
    const { rw } = makeRW({
      '.obsidian/plugins/evil/manifest.json': manifest('evil', '2.0.0'),
      '.obsidian/plugins/evil/main.js': '/* pwned */\n',
    });

    await ShadowVaultBootstrap.pullPluginBinaries(rw, '.obsidian', cfg, ['evil']);

    expect(fs.readFileSync(outsideMain, 'utf-8'), 'pull must not write through the atomic temp symlink').toBe('keep');
  });

  it('does not keep a new manifest when a later code file is refused', async () => {
    const cfg = makeLocalConfigDir();
    const pluginDir = path.join(cfg, 'plugins', 'p');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'manifest.json'), manifest('p', '1.0.0'));
    fs.writeFileSync(path.join(pluginDir, 'main.js'), '/* OLD */\n');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-pull-stall-'));
    const victim = path.join(outside, 'secret.js');
    fs.writeFileSync(victim, 'keep', 'utf-8');
    const store: Record<string, string> = {
      '.obsidian/plugins/p/manifest.json': manifest('p', '2.0.0'),
      '.obsidian/plugins/p/main.js': '/* NEW */\n',
    };
    const { rw } = makeRW(store);
    const read = rw.read.bind(rw);
    // Plant the symlink once. The retry must be able to read main.js
    // after the test removes that link; a second plant would unlink a
    // path that is already gone.
    let planted = false;
    rw.read = async (p: string) => {
      if (!planted && p.endsWith('/p/main.js')) {
        planted = true;
        const link = path.join(pluginDir, 'main.js');
        fs.unlinkSync(link);
        fs.symlinkSync(victim, link);
      }
      return read(p);
    };

    await ShadowVaultBootstrap.pullPluginBinaries(rw, '.obsidian', cfg, ['p']);
    fs.unlinkSync(path.join(pluginDir, 'main.js'));
    const again = await ShadowVaultBootstrap.pullPluginBinaries(rw, '.obsidian', cfg, ['p']);

    expect(again.pulled).toContain('p');
    expect(fs.readFileSync(path.join(pluginDir, 'main.js'), 'utf-8')).toBe('/* NEW */\n');
  });

  it('pulls through a plugin-directory symlink that stays inside the plugins directory', async () => {
    const cfg = makeLocalConfigDir();
    const pluginsDir = path.join(cfg, 'plugins');
    const real = path.join(pluginsDir, 'real-plugin');
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, 'manifest.json'), manifest('alias', '1.0.0'), 'utf-8');
    fs.writeFileSync(path.join(real, 'main.js'), 'old\n', 'utf-8');
    fs.symlinkSync(real, path.join(pluginsDir, 'alias'), 'dir');
    const { rw } = makeRW({
      '.obsidian/plugins/alias/manifest.json': manifest('alias', '2.0.0'),
      '.obsidian/plugins/alias/main.js': '/* new */\n',
    });

    const { pulled } = await ShadowVaultBootstrap.pullPluginBinaries(rw, '.obsidian', cfg, ['alias']);

    expect(pulled).toContain('alias');
    expect(fs.readFileSync(path.join(real, 'main.js'), 'utf-8')).toBe('/* new */\n');
  });
});

// ─── shadow-dir naming + migration (identity = profile id) ──────────────
//
// The shadow dir is `<friendly-name>--<remotePath-tail>` so Obsidian
// shows a recognisable, folder-distinct name. Identity is the profile
// *id* (persisted as data.json `autoConnectProfileId`), NOT the dir
// name — so a profile rename, an older `<uuid>` / `--<id8>` name, or a
// display-name collision all still resolve to the same shadow via
// find-by-id. A stale dir name is renamed once, unless the vault is
// open (Windows corruption guard) or the name collides with another
// profile's.
describe('ShadowVaultBootstrap shadow-dir migration (find-by-id)', () => {
  let scratch: ReturnType<typeof makeScratch>;
  beforeEach(() => { scratch = makeScratch(); });
  afterEach(() => { scratch.cleanup(); });

  /**
   * Seed an existing shadow dir with a data.json carrying the profile
   * id (the stable identity find-by-id keys on) plus a
   * community-plugins.json so config carry-over is observable.
   */
  function seedShadow(dirName: string, profileId: string, cp: string[] = ['remote-ssh']): string {
    const dir = path.join(scratch.baseDir, dirName);
    const pluginDir = path.join(dir, '.obsidian', 'plugins', 'remote-ssh');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'data.json'), JSON.stringify({ autoConnectProfileId: profileId }));
    fs.writeFileSync(path.join(dir, '.obsidian', 'community-plugins.json'), JSON.stringify(cp));
    return dir;
  }

  it('reuses the existing shadow by id and migrates a renamed profile to <name>--<tail>', async () => {
    const id = 'dddddddd-1111-2222-3333-444444444444';
    const oldDir = seedShadow('Old Name--work', id, ['remote-ssh', 'dataview']);
    const registry = new ObsidianRegistry(scratch.configPath);
    const { id: regId } = registry.register(oldDir);

    const profile = makeProfile({ id, name: 'New Name', remotePath: '/home/souta/work' });
    const result = await new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, registry)
      .bootstrap(profile, [profile]);

    expect(result.migrated).toBe(true);
    expect(path.basename(result.layout.vaultDir)).toBe('New Name--work');
    expect(fs.existsSync(oldDir)).toBe(false);                          // old dir moved, not left behind
    expect(JSON.parse(fs.readFileSync(path.join(result.layout.configDir, 'community-plugins.json'), 'utf-8')))
      .toEqual(expect.arrayContaining(['remote-ssh', 'dataview']));     // config carried over
    const cfg = JSON.parse(fs.readFileSync(scratch.configPath, 'utf-8'));
    expect(cfg.vaults[regId].path).toBe(result.layout.vaultDir);       // same registry id, repointed
  });

  it('migrates a legacy <uuid>-named dir (data.json carries the id) to <name>--<tail>', async () => {
    const id = 'eeeeeeee-1111-2222-3333-444444444444';
    const legacyDir = seedShadow(id, id, ['remote-ssh', 'keepme']);    // dir named by the raw uuid
    const profile = makeProfile({ id, name: 'My Homelab', remotePath: '/home/souta/work' });
    const result = await new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath))
      .bootstrap(profile, [profile]);
    expect(result.migrated).toBe(true);
    expect(path.basename(result.layout.vaultDir)).toBe('My Homelab--work');
    expect(fs.existsSync(legacyDir)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(result.layout.configDir, 'community-plugins.json'), 'utf-8')))
      .toContain('keepme');
  });

  it('is idempotent: a brand-new bootstrap then a second one does not migrate', async () => {
    const id = 'ffffffff-1111-2222-3333-444444444444';
    const profile = makeProfile({ id, name: 'Vault', remotePath: '/home/souta/work' });
    const r = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
    const first = await r.bootstrap(profile, [profile]);
    expect(first.migrated).toBe(false);                                // brand-new, not a migration
    expect(path.basename(first.layout.vaultDir)).toBe('Vault--work');
    const second = await r.bootstrap(profile, [profile]);
    expect(second.migrated).toBe(false);
    expect(second.layout.vaultDir).toBe(first.layout.vaultDir);
  });

  it('does not migrate a brand-new profile (no existing shadow)', async () => {
    const profile = makeProfile({ id: 'aaaa0000-1111', name: 'Fresh', remotePath: '/srv/notes' });
    const result = await new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath))
      .bootstrap(profile, [profile]);
    expect(result.migrated).toBe(false);
    expect(path.basename(result.layout.vaultDir)).toBe('Fresh--notes');
  });

  it('open-safety: does NOT rename when the found vault is currently open', async () => {
    const id = 'bbbb0000-1111-2222-3333-444444444444';
    const oldDir = seedShadow('Old Name--work', id, ['remote-ssh', 'keepme']);
    const registry = new ObsidianRegistry(scratch.configPath);
    registry.register(oldDir);
    const isOpenSpy = vi.spyOn(registry, 'isOpen').mockReturnValue(true);
    try {
      const profile = makeProfile({ id, name: 'New Name', remotePath: '/home/souta/work' });
      const result = await new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, registry)
        .bootstrap(profile, [profile]);
      expect(result.migrated).toBe(false);
      expect(result.layout.vaultDir).toBe(oldDir);                     // used as-is, rename deferred
      expect(fs.existsSync(oldDir)).toBe(true);
      expect(fs.existsSync(path.join(scratch.baseDir, 'New Name--work'))).toBe(false);
    } finally { isOpenSpy.mockRestore(); }
  });

  it('collision: a second profile with the same <name>--<tail> gets a " (2)" dir, configs stay separate', async () => {
    const a = makeProfile({ id: 'aaaa1111-2222-3333-4444-555555555555', name: 'Panza', remotePath: '/home/a/work' });
    const b = makeProfile({ id: 'bbbb2222-3333-4444-5555-666666666666', name: 'Panza', remotePath: '/home/b/work' });
    const boot = new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath));
    const ra = await boot.bootstrap(a, [a, b]);
    const rb = await boot.bootstrap(b, [a, b]);
    expect(path.basename(ra.layout.vaultDir)).toBe('Panza--work');
    expect(path.basename(rb.layout.vaultDir)).toBe('Panza--work (2)');
    expect(ra.layout.vaultDir).not.toBe(rb.layout.vaultDir);
    // Distinct data.json → the two vaults never merge into one dir.
    expect(JSON.parse(fs.readFileSync(ra.layout.pluginDataFile, 'utf-8')).autoConnectProfileId).toBe(a.id);
    expect(JSON.parse(fs.readFileSync(rb.layout.pluginDataFile, 'utf-8')).autoConnectProfileId).toBe(b.id);

    // Reconnect: a profile parked in a ` (2)` dir must resolve back to its
    // OWN dir with migrated=false — not report a spurious migration (a no-op
    // same-path rename) and re-show the one-time "restart Obsidian" notice
    // on every connect.
    const rb2 = await boot.bootstrap(b, [a, b]);
    expect(rb2.migrated).toBe(false);
    expect(rb2.layout.vaultDir).toBe(rb.layout.vaultDir);
    const ra2 = await boot.bootstrap(a, [a, b]);
    expect(ra2.migrated).toBe(false);
    expect(ra2.layout.vaultDir).toBe(ra.layout.vaultDir);
  });

  it('commits the migration even if the registry update throws AFTER a successful rename', async () => {
    // #438 regression: rename succeeds (config physically moves) but
    // updatePath throws (obsidian.json briefly locked). The session must
    // use the migrated dir — NOT fall back to the old dir, which bootstrap
    // would recreate empty, opening a blank vault while config sits orphaned.
    const id = 'cccc3333-4444-5555-6666-777777777777';
    const oldDir = seedShadow('Old Name--work', id, ['remote-ssh', 'keepme']);
    const registry = new ObsidianRegistry(scratch.configPath);
    registry.register(oldDir);
    const updateSpy = vi.spyOn(registry, 'updatePath').mockImplementation(() => { throw new Error('EBUSY'); });
    try {
      const profile = makeProfile({ id, name: 'New Name', remotePath: '/home/souta/work' });
      const result = await new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, registry)
        .bootstrap(profile, [profile]);

      expect(result.migrated, 'rename succeeded → migration committed').toBe(true);
      expect(path.basename(result.layout.vaultDir)).toBe('New Name--work');
      expect(fs.existsSync(oldDir), 'old dir was moved, not recreated empty').toBe(false);
      expect(
        JSON.parse(fs.readFileSync(path.join(result.layout.configDir, 'community-plugins.json'), 'utf-8')),
        'config must live at the migrated dir, never orphaned',
      ).toContain('keepme');
    } finally { updateSpy.mockRestore(); }
  });

  it('falls back to the found dir (no data loss) when the rename fails', async () => {
    const id = 'dddd4444-5555-6666-7777-888888888888';
    const oldDir = seedShadow('Old Name--work', id, ['remote-ssh', 'keepme']);
    // Only the migration rename (the first renameSync) throws; bootstrap's
    // own later atomic writes use the real implementation.
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('EBUSY'); });
    try {
      const profile = makeProfile({ id, name: 'New Name', remotePath: '/home/souta/work' });
      const result = await new ShadowVaultBootstrap(scratch.baseDir, scratch.sourceDir, new ObsidianRegistry(scratch.configPath))
        .bootstrap(profile, [profile]);
      expect(result.migrated).toBe(false);
      expect(result.layout.vaultDir).toBe(oldDir);                     // fell back to found this session
      expect(JSON.parse(fs.readFileSync(path.join(oldDir, '.obsidian', 'community-plugins.json'), 'utf-8')))
        .toContain('keepme');                                          // config NOT lost
    } finally { renameSpy.mockRestore(); }
  });
});
