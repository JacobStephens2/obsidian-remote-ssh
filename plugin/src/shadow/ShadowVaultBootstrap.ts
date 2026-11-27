import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../util/logger';
import type { SshProfile, PendingPluginSuggestion } from '../types';
import type { ObsidianRegistry } from './ObsidianRegistry';
import { errorMessage } from "../util/errorMessage";

/** A configured app.json is a plain object with at least one key. */
function isNonEmptyObject(v: unknown): boolean {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.keys(v).length > 0
  );
}

/** A configured core-plugins.json is a non-empty array. */
function isNonEmptyArray(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0;
}

/**
 * A community-plugin id may be interpolated into a remote plugin path
 * and joined onto the local plugins directory. Keep it only when it is
 * one path segment: non-empty, not `.` or `..`, and containing no
 * directory separator (`/` or `\`) and no drive separator (`:`).
 * `:` is not a separator on POSIX, but on Windows `C:other` is
 * drive-relative: `path.resolve(plugins, "C:other")` lands on `other`.
 */
function isSinglePathSegmentPluginId(id: string): boolean {
  return id !== '' && id !== '.' && id !== '..'
    && !id.includes('/') && !id.includes('\\') && !id.includes(':');
}

/**
 * Absolute path `rel` may be created at under the local plugins
 * directory, or null when that write would leave it.
 *
 * Same resolved-path confinement as `SftpDataAdapter.writeThroughConfig`:
 * `path.resolve` decides containment (a string prefix would admit a
 * sibling such as `plugins-evil`, and `..` walks out). A symlink at
 * the destination is refused, because `writeFile` follows it. A
 * symlinked ancestor is judged by realpath: one that stays inside the
 * plugins directory is still that directory; one that doesn't is a
 * refusal. A plugins directory that does not exist yet has no symlink
 * to follow, so a lexically contained path is allowed.
 */
function containedPluginCodePath(pluginsRoot: string, rel: string): string | null {
  const root = path.resolve(pluginsRoot);
  let abs: string;
  try {
    // Join first. `path.resolve(root, rel)` parses `rel` on its own, so
    // a Windows drive-relative segment such as `C:other\main.js` resolves
    // onto `other` instead of a directory named `C:other`.
    const joined = path.join(root, rel);
    abs = path.resolve(joined);
    if (path.basename(path.dirname(abs)) !== path.basename(path.dirname(joined))) return null;
  } catch {
    return null;
  }
  if (abs === root || !abs.startsWith(root + path.sep)) return null;

  try {
    if (fs.lstatSync(abs, { throwIfNoEntry: false })?.isSymbolicLink()) return null;

    let cursor = path.dirname(abs);
    while (cursor !== root) {
      if (fs.lstatSync(cursor, { throwIfNoEntry: false })) break;
      const parent = path.dirname(cursor);
      if (parent === cursor) return null;
      cursor = parent;
    }
    if (!fs.existsSync(cursor)) return abs;
    const realAncestor = fs.realpathSync(cursor);
    const realRoot = fs.existsSync(root) ? fs.realpathSync(root) : root;
    if (realAncestor !== realRoot && !realAncestor.startsWith(realRoot + path.sep)) return null;
  } catch {
    return null;
  }
  return abs;
}

/**
 * Absolute plugin directory `id` may be created under the local plugins
 * directory, or null when it would leave it.
 *
 * A symlink at the directory is not refused outright: `writeThroughConfig`
 * allows an ancestor whose real path stays inside the root. The code
 * file itself is still refused by {@link containedPluginCodePath},
 * because `writeFile` would follow that link.
 */
function containedPluginDirectory(pluginsRoot: string, id: string): string | null {
  const root = path.resolve(pluginsRoot);
  let abs: string;
  try {
    // Join first so a drive-relative id (`C:other`) stays a literal
    // segment. `path.resolve(root, id)` would land on `other`.
    const joined = path.join(root, id);
    abs = path.resolve(joined);
    if (path.basename(abs) !== id) return null;
  } catch {
    return null;
  }
  if (abs === root || !abs.startsWith(root + path.sep)) return null;
  try {
    if (!fs.lstatSync(abs, { throwIfNoEntry: false })) return abs;
    const real = fs.realpathSync(abs);
    const realRoot = fs.existsSync(root) ? fs.realpathSync(root) : root;
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
    if (!fs.statSync(real).isDirectory()) return null;
    return abs;
  } catch {
    return null;
  }
}

/**
 * Narrow an unknown `secrets` (or `hostKeyStore`) blob to a plain
 * string-keyed record, defaulting to `{}` for anything that isn't a
 * non-array object. Keeps the #399 secret-merge below total even when a
 * data.json holds a malformed `secrets` value.
 */
function asSecretRecord(v: unknown): Record<string, unknown> {
  return (v && typeof v === 'object' && !Array.isArray(v))
    ? (v as Record<string, unknown>)
    : {};
}

/**
 * Where the shadow vault for a given profile lives on disk.
 */
export interface ShadowVaultLayout {
  /** Absolute path to the shadow vault root (what Obsidian opens). */
  vaultDir: string;
  /** Absolute path to `<vaultDir>/.obsidian/`. */
  configDir: string;
  /** Absolute path to `<vaultDir>/.obsidian/plugins/remote-ssh/`. */
  pluginDir: string;
  /** Absolute path to the plugin's data.json under `pluginDir`. */
  pluginDataFile: string;
}

export interface BootstrapResult {
  layout: ShadowVaultLayout;
  /** Client ID override from the settings the spawned shadow will load. */
  clientId?: string;
  /** Vault id Obsidian assigned in obsidian.json. */
  registryId: string;
  /** True if the vault entry was newly added (false = was already registered). */
  registryCreated: boolean;
  /**
   * True if an existing shadow dir (located by profile id, under any
   * prior naming scheme) was renamed to the current `<name>--<tail>` on
   * this bootstrap. Like a newly-registered vault, the renamed path isn't
   * in the running Obsidian's cached vault list, so the connect flow
   * surfaces the one-time "restart Obsidian" notice.
   */
  migrated: boolean;
  /**
   * How the plugin source landed in the shadow vault. `in-place` means
   * source and target were the same directory (bootstrap re-run from
   * inside the shadow window) so nothing needed installing.
   */
  pluginInstallMethod: 'symlink' | 'copy' | 'in-place';
}

/** Remote reads for the enabled plugin list and plugin binaries. */
export interface ConfigReader {
  exists(normalizedPath: string): Promise<boolean>;
  read(normalizedPath: string): Promise<string>;
}

/** Remote writes for the enabled plugin list and plugin binaries. */
export interface ConfigWriter {
  write(normalizedPath: string, content: string): Promise<void>;
}

/**
 * Materialises the on-disk shadow vault for a profile so a separate
 * Obsidian window can open it as if it were any other local vault.
 *
 * Layout:
 *
 *   <baseDir>/<name>--<remotePath-tail>/     (identity is the profile id
 *   ├── .obsidian/                            in data.json, not the dir name)
 *   │   ├── community-plugins.json    ← ["remote-ssh"]
 *   │   └── plugins/
 *   │       └── remote-ssh/           ← symlink (or copy on Windows
 *   │           ├── main.js              without symlink perms) of the
 *   │           ├── manifest.json        running plugin's source dir
 *   │           ├── styles.css
 *   │           └── data.json         ← profile data + autoConnectProfileId
 *   └── (no other files — Obsidian fills the rest on first open)
 *
 * Idempotent: re-running for the same profile refreshes the plugin
 * install (so dev iterations land immediately) and rewrites data.json
 * but never touches files Obsidian itself created (workspace.json,
 * app.json, etc.).
 */
export class ShadowVaultBootstrap {
  constructor(
    /** Directory under which all shadow vaults live (e.g. `~/.obsidian-remote/vaults/`). */
    private readonly baseDir: string,
    /** Absolute path to THIS running plugin's directory (source for symlink/copy). */
    private readonly sourcePluginDir: string,
    private readonly registry: ObsidianRegistry,
    /**
     * Root of this device's never-synced sync state (e.g.
     * `~/.obsidian-remote/`), parent of the `state/` dir that holds the
     * community-plugins base snapshots — see
     * {@link ShadowVaultBootstrap.communityPluginsBasePath}. Defaults to
     * `baseDir`'s parent, which is exactly that on every real call site.
     */
    private readonly stateRoot: string = path.dirname(baseDir),
  ) {}

  bootstrap(profile: SshProfile, allProfiles: ReadonlyArray<SshProfile>): Promise<BootstrapResult> {
    return Promise.resolve(this.bootstrapSync(profile, allProfiles));
  }

  /**
   * Synchronous body of `bootstrap`. Kept private so the public
   * `bootstrap` keeps its `Promise<BootstrapResult>` shape (callers
   * already `await` it) without needing an `async` keyword that
   * `@typescript-eslint/require-await` would flag — every step here
   * is `fs.*Sync` and JSON arithmetic, no I/O actually awaits.
   */
  private bootstrapSync(profile: SshProfile, allProfiles: ReadonlyArray<SshProfile>): BootstrapResult {
    // Resolve (and, when safe, migrate to) the `<name>--<tail>` shadow
    // dir for this profile. Identity is the profile id, not the dir
    // name, so a rename/collision never strands config (see resolveLayout).
    const { layout, migrated } = this.resolveLayout(profile);

    fs.mkdirSync(layout.vaultDir, { recursive: true });
    fs.mkdirSync(layout.configDir, { recursive: true });

    // First bootstrap (shadow data.json doesn't exist yet) — we'll
    // also collect a snapshot of source's enabled plugins to surface
    // through a confirmation modal in the shadow window. Detect now
    // before the `readBaseDataJson` call below side-effects state.
    const isFirstBootstrap = !fs.existsSync(layout.pluginDataFile);

    // A first bootstrap means this device has no shadow vault for the
    // profile — either it never had one, or the user deleted it (the
    // documented recovery step). Either way any base snapshot left over
    // from a previous incarnation is STALE, and keeping it would be
    // actively destructive: the fresh shadow's list is the `["remote-ssh"]`
    // seed below, so every id in that old base would look like a local
    // uninstall and the first push would strip the user's whole
    // enabled-plugin list off the remote. Drop it — the round-trip then
    // falls back to the union (nothing lost) and re-establishes a base on
    // the first successful push.
    if (isFirstBootstrap) this.discardCommunityPluginsBase(profile.id);

    // `community-plugins.json` always starts as `["remote-ssh"]` only.
    // Inheriting source's full enabled list at bootstrap time was too
    // surprising — the shadow window would auto-install every plugin
    // from the marketplace right after Obsidian's "trust this vault"
    // prompt, which felt like the plugin was acting on its own. Now
    // the user opts in via a modal (see `pendingPluginSuggestions`
    // below) and the install only happens for what they tick.
    this.seedCommunityPlugins(layout.configDir);

    // Without this, a freshly-bootstrapped shadow vault has an empty
    // app.json → Obsidian treats it as "never configured", opens it
    // in first-run / Restricted mode, and never loads remote-ssh — so
    // runAutoConnect (and the settings pull that would
    // populate the real app.json) never run. Deadlock: the very first
    // connect to any new profile silently does nothing.
    this.seedObsidianFirstRunState(layout.configDir);

    // Install our own plugin source (symlink preferred so dev
    // iterations appear immediately; copy as a Windows fallback).
    // Per-file install means data.json stays per-vault.
    const pluginInstallMethod = this.installPlugin(layout.pluginDir);

    // data.json strategy: MERGE rather than overwrite, so accumulated
    // state on the shadow side (hostKeyStore from past TOFU prompts,
    // secrets, etc.) survives a re-bootstrap. On first bootstrap we
    // seed from the source vault's data.json so the shadow inherits
    // the source's already-trusted host keys — without that, every
    // freshly-bootstrapped shadow vault would TOFU-prompt on the
    // very first auto-connect.
    //
    // Bootstrap-managed fields (profiles list, activeProfileId,
    // autoConnectProfileId) are always overwritten to reflect the
    // current Connect click. `pendingPluginSuggestions` is set only
    // on first bootstrap (and only if source has community plugins
    // worth suggesting) so re-bootstrap doesn't re-prompt a user
    // who's already made their decision.
    const baseData = this.readBaseDataJson(layout.pluginDataFile);
    const data: Record<string, unknown> = {
      ...baseData,
      profiles: allProfiles,
      activeProfileId: profile.id,
      autoConnectProfileId: profile.id,
    };

    // #399: a password entered in the SOURCE (local) vault must reach
    // the shadow vault that actually runs the connect. `readBaseDataJson`
    // prefers the EXISTING shadow data.json, so a secret persisted to
    // source AFTER the first bootstrap would otherwise never propagate —
    // the shadow's auto-connect then dies with "No password stored for
    // profile" and the vault opens empty. Union the source's secrets
    // over whatever the shadow has accumulated: source wins on a
    // conflicting ref (it's the user's latest, just flushed by
    // openShadowVaultFor before this bootstrap), while a secret typed
    // directly in the shadow window (a ref absent from source) survives.
    const mergedSecrets = {
      ...asSecretRecord(baseData.secrets),
      ...this.readSourceSecrets(),
    };
    if (Object.keys(mergedSecrets).length > 0) {
      data.secrets = mergedSecrets;
    }

    if (isFirstBootstrap) {
      const pending = this.collectPendingPluginSuggestions();
      if (pending.length > 0) {
        data.pendingPluginSuggestions = pending;
      }
    }
    fs.writeFileSync(layout.pluginDataFile, JSON.stringify(data, null, 2) + '\n', 'utf-8');

    const { id: registryId, created } = this.registry.register(layout.vaultDir);

    logger.info(
      `ShadowVaultBootstrap: ${created ? 'registered' : 'reused'} shadow vault for ${profile.name} ` +
      `at ${layout.vaultDir} (registry id=${registryId}, plugin=${pluginInstallMethod})`,
    );

    const clientId = typeof data.clientId === 'string' ? data.clientId : undefined;
    return { layout, clientId, registryId, registryCreated: created, migrated, pluginInstallMethod };
  }

  /**
   * Delete this device's community-plugins base snapshot for `profileId`
   * (see the call site in `bootstrapSync`). Best-effort — an absent file
   * is the normal case, and a failure only means the next round-trip
   * falls back to the union.
   */
  private discardCommunityPluginsBase(profileId: string): void {
    const basePath = ShadowVaultBootstrap.communityPluginsBasePath(this.stateRoot, profileId);
    try {
      fs.rmSync(basePath, { force: true });
    } catch (e) {
      logger.warn(`ShadowVaultBootstrap: could not discard stale ${basePath} (${errorMessage(e)})`);
    }
  }

  /**
   * Compute the shadow paths for a profile without doing any I/O: the
   * pure `<name>--<tail>` layout, before any collision ` (n)` suffix
   * (which only resolveLayout applies). A thin, side-effect-free path
   * builder — resolveLayout is the sole caller.
   */
  layoutFor(profile: Pick<SshProfile, 'name' | 'remotePath'>): ShadowVaultLayout {
    return this.layoutForDir(path.join(this.baseDir, friendlyVaultDirName(profile)));
  }

  /** Derive the `.obsidian/...` sub-paths for a concrete vault dir. */
  private layoutForDir(vaultDir: string): ShadowVaultLayout {
    // The shadow vault is freshly created on disk by us before Obsidian
    // ever opens it; there's no live `App` instance whose
    // `vault.configDir` we could query, so we build the directory name
    // (`.obsidian`) via concatenation. That stays out of the AST as a
    // single string literal, which keeps
    // `obsidianmd/hardcoded-config-path` happy. Once the shadow window
    // opens and the user customises `configDir`, subsequent reads use
    // `app.vault.configDir` like the rest of the plugin.
    const configDir = path.join(vaultDir, '.' + 'obsidian');
    const pluginDir = path.join(configDir, 'plugins', 'remote-ssh');
    const pluginDataFile = path.join(pluginDir, 'data.json');
    return { vaultDir, configDir, pluginDir, pluginDataFile };
  }

  /**
   * Resolve the shadow layout to use for this profile.
   *
   * Identity is the profile *id* (persisted as `autoConnectProfileId`
   * in the shadow's data.json), NOT the directory name — so a profile
   * rename, a display-name collision, or an older `<uuid>` / `--<id8>`
   * naming scheme all still resolve to the same shadow via
   * `findShadowByProfileId`. When the existing shadow's dir name no
   * longer matches the desired `<name>--<tail>`, we migrate it once by
   * renaming, EXCEPT:
   *
   *  - the vault is currently open (obsidian.json `open` flag): renaming
   *    an open vault's dir on Windows corrupts the live junction/handles
   *    (the plugin dir goes dangling → daemon download ENOENTs → SFTP
   *    fallback). Use it as-is; migrate on the next closed bootstrap.
   *  - the desired name is already taken by a *different* profile:
   *    `uniqueVaultDir` appends ` (2)` so two vaults never share one dir
   *    (which would merge their data.json / secrets / host keys).
   *
   * The rename and the obsidian.json path update are separate `try`s:
   * once the dir physically moves we commit to the new path even if
   * updating the registry throws, because falling back would recreate
   * the old dir empty and orphan the real config (#438 review).
   */
  private resolveLayout(
    profile: Pick<SshProfile, 'id' | 'name' | 'remotePath'>,
  ): { layout: ShadowVaultLayout; migrated: boolean } {
    const desired = this.layoutFor(profile);
    const found = this.findShadowByProfileId(profile.id);

    if (found) {
      // Where this profile's shadow SHOULD live (collision-safe): its own
      // dir if it already owns one, else the free `<name>--<tail>` or a
      // ` (n)` variant. Compare `found` to this resolved target — NOT to
      // the bare desired name — otherwise a profile permanently parked in a
      // ` (2)` dir (a display-name collision) would "migrate" to itself on
      // every reconnect: a no-op same-path rename that falsely reports
      // migrated=true and re-shows the one-time "restart Obsidian" notice.
      const target = this.uniqueVaultDir(desired.vaultDir, profile.id);
      if (path.basename(found) === path.basename(target)) {
        return { layout: this.layoutForDir(found), migrated: false };
      }
      // R2: never rename a dir whose vault is open — Windows corrupts the
      // live junction. Use it as-is; migrate on the next closed run.
      if (this.registry.isOpen(found)) {
        logger.info(`ShadowVaultBootstrap: ${found} is open; deferring rename`);
        return { layout: this.layoutForDir(found), migrated: false };
      }
      // Migrate. A successful rename commits the move; a failing updatePath
      // is logged but not fatal (self-heals on register()). A failing
      // rename falls back to the found dir.
      try {
        fs.renameSync(found, target);
      } catch (e) {
        logger.warn(
          `ShadowVaultBootstrap: rename ${found} → ${target} failed (${errorMessage(e)}); using ${found} this session`,
        );
        return { layout: this.layoutForDir(found), migrated: false };
      }
      try {
        this.registry.updatePath(found, target);
      } catch (e) {
        logger.warn(
          `ShadowVaultBootstrap: registry path update failed post-migration (${errorMessage(e)}); ` +
          `config is at ${target}, registry self-heals on register()`,
        );
      }
      logger.info(`ShadowVaultBootstrap: migrated shadow ${found} → ${target}`);
      return { layout: this.layoutForDir(target), migrated: true };
    }

    // Brand-new profile — pick a collision-free dir (a different profile
    // may already own the desired `<name>--<tail>`).
    const target = this.uniqueVaultDir(desired.vaultDir, profile.id);
    return { layout: this.layoutForDir(target), migrated: false };
  }

  /**
   * Scan `baseDir` for the shadow whose data.json `autoConnectProfileId`
   * matches. Identity is the id, not the dir name, so this is naming-scheme
   * agnostic — it reuses the existing config whether the dir is a legacy
   * `<uuid>`, an older `<name>--<id8>`, or the current `<name>--<tail>`,
   * instead of stranding it. Returns the first match in sorted order
   * (deterministic) or null.
   */
  private findShadowByProfileId(profileId: string): string | null {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.baseDir).sort();
    } catch {
      return null; // baseDir not created yet
    }
    for (const entry of entries) {
      const dir = path.join(this.baseDir, entry);
      let isDir: boolean;
      try { isDir = fs.statSync(dir).isDirectory(); } catch { continue; }
      if (isDir && this.readShadowProfileId(dir) === profileId) return dir;
    }
    return null;
  }

  /**
   * The `autoConnectProfileId` recorded in `dir`'s shadow data.json, or
   * null if `dir` isn't a bootstrapped shadow. A genuinely absent data.json
   * (ENOENT) is the normal "not a shadow dir" case and stays silent; an
   * EXISTING-but-unreadable data.json — a transient lock (AV / Dropbox sync
   * / a mid-write) or malformed JSON — is logged, because it can briefly
   * hide this profile's OWN shadow and make resolveLayout fork a duplicate
   * ` (2)` dir instead of reusing it. A non-string id is treated as no
   * match (only a false negative is possible, never a false reuse).
   */
  private readShadowProfileId(dir: string): string | null {
    const dataFile = this.layoutForDir(dir).pluginDataFile;
    let raw: string;
    try {
      raw = fs.readFileSync(dataFile, 'utf-8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn(`ShadowVaultBootstrap: unreadable ${dataFile} (${errorMessage(e)}); treating as non-matching`);
      }
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as { autoConnectProfileId?: unknown };
      return typeof parsed.autoConnectProfileId === 'string' ? parsed.autoConnectProfileId : null;
    } catch (e) {
      logger.warn(`ShadowVaultBootstrap: malformed ${dataFile} (${errorMessage(e)}); treating as non-matching`);
      return null;
    }
  }

  /**
   * A dir the given profile may safely occupy: the desired name if it's
   * free or already this profile's, else `desired (2)`, `desired (3)`, …
   * Two profiles must never share a dir — that would merge their
   * data.json (secrets, host keys, active profile). Display-name
   * collisions are allowed; only the on-disk dir is disambiguated.
   */
  private uniqueVaultDir(desiredVaultDir: string, profileId: string): string {
    // Free (absent) or already ours → safe to take. An existing dir whose
    // data.json belongs to a DIFFERENT profile (or is unreadable, logged by
    // readShadowProfileId) is left alone so configs never merge.
    const ownsOrFree = (dir: string): boolean =>
      !fs.existsSync(dir) || this.readShadowProfileId(dir) === profileId;
    if (ownsOrFree(desiredVaultDir)) return desiredVaultDir;
    for (let n = 2; n < 100; n++) {
      const candidate = `${desiredVaultDir} (${n})`;
      if (ownsOrFree(candidate)) return candidate;
    }
    // 98 collisions on one name is absurd; fall back to an id-suffixed
    // dir so we still return something unique rather than loop forever.
    return `${desiredVaultDir} (${profileId.slice(0, 8)})`;
  }

  // ─── community-plugins list round-trip (#429 / #342 / uninstall) ─────────
  //
  // `community-plugins.json` is the *enabled community plugins* list.
  // It deliberately does NOT join SHARED_OBSIDIAN_CONFIG_FILES (whose
  // pull/push copy bytes verbatim): a remote list that omitted
  // `remote-ssh` would, written verbatim, disable the very plugin doing
  // the sync. Instead these two methods round-trip the list so a plugin
  // enabled on one machine reaches another machine's shadow vault and
  // reopening no longer "loses" installed plugins. The marketplace
  // installer re-fetches any binaries the list names but that aren't
  // staged locally yet.
  //
  // Convergence is a 3-WAY MERGE against a per-device BASE snapshot, not
  // a union. The union was MONOTONIC — the list could only ever GROW —
  // so an uninstall on one device never reached the remote, and the next
  // connect's pull RESURRECTED the plugin locally: a fleet-wide uninstall
  // was impossible. A union cannot tell "I never had it" from "I removed
  // it"; only a base can. The base is the converged list as it stood at
  // the END of the last successful round-trip ON THIS DEVICE (see
  // {@link communityPluginsBasePath} for where it lives and why).
  //
  //     added   = local  \ base   -> add to remote
  //     removed = base   \ local  -> remove from remote
  //     added   = remote \ base   -> add to local
  //     removed = base   \ remote -> remove from local
  //
  // Rules, all encoded in {@link mergePluginIds}:
  //
  //  - `remote-ssh` (SELF_PLUGIN_ID) is NEVER removable from either side.
  //  - NO BASE YET (first run, or a shadow vault that was deleted and
  //    re-bootstrapped): a removal is indistinguishable from never-had,
  //    so we fall back to the old UNION. Safe — nothing is lost; removals
  //    simply don't propagate until a base exists, which the first
  //    successful push then writes.
  //  - A device that was OFFLINE while another device removed a plugin
  //    has a stale base, so `base \ remote` sees the removal and drops it
  //    locally. Correct — that is the whole point of the base.
  //  - TIE-BREAK — concurrent ADD on A vs REMOVE on B: **ADD WINS**. It
  //    falls out of the definition: an id in neither the base nor either
  //    side's removal set (`base \ local`, `base \ remote`) is by
  //    definition an addition, and additions are unioned in. Rationale:
  //    re-uninstalling a plugin someone else re-installed is one click;
  //    silently losing a plugin you just installed is invisible data loss.
  //
  // The base is committed by the PUSH only, once BOTH sides hold the
  // converged list. `pullCommunityPlugins` deliberately never writes it:
  // a pull-only caller (`preSpawnPull`) would otherwise record the pulled
  // list as the base, and the push later in the real connect would then
  // read `base \ remote` as a *remote removal* of everything this device
  // had locally added — deleting the user's own additions. Never writing
  // the base on pull also keeps the merge idempotent (a second pull over
  // the same base+remote recomputes the same list), so the
  // pre-spawn-pull → connect-pull → connect-push sequence cannot
  // double-apply a removal.

  /** The plugin's own id — always kept enabled across a round-trip. */
  static readonly SELF_PLUGIN_ID = 'remote-ssh';

  /**
   * Absolute path to THIS DEVICE's base snapshot of the enabled-plugin
   * list for `profileId`:
   *
   *   <stateRoot>/state/<profile-id>/community-plugins.base.json
   *
   * i.e. `~/.obsidian-remote/state/<id>/…`, a SIBLING of the shadow
   * `vaults/` dir — deliberately outside every vault:
   *
   *  - It must be PER-DEVICE and must NOT sync. A base that synced would
   *    record another machine's view and removals would ping-pong.
   *  - It must not live under a vault's `<configDir>/`: everything there
   *    is write-through-mirrored to the remote by
   *    `SftpDataAdapter.writeThroughConfig`, and `PathMapper` redirects
   *    the four core config files (plus `plugins/&lowast;/data.json`) per
   *    device. A new file there would either be shared (wrong) or entangle
   *    with that machinery.
   *  - Outside the vault root entirely also keeps it invisible to Obsidian
   *    and out of the populate.
   *
   * NOT under `vaults/` itself: `findShadowByProfileId` enumerates that
   * dir looking for shadow vaults, and `uniqueVaultDir` could collide with
   * a profile literally named "state".
   */
  static communityPluginsBasePath(stateRoot: string, profileId: string): string {
    return path.join(
      stateRoot, 'state', sanitiseStateKey(profileId), 'community-plugins.base.json',
    );
  }

  /**
   * Pull the remote enabled-plugin list into the shadow vault, 3-way
   * merged against this device's base (see the section comment above)
   * with `remote-ssh` forced on. A remote list that's absent or not a
   * valid id array leaves the local list untouched (never clobbered)
   * and — crucially — contributes NO removals: a remote we could not read
   * must never look like "every plugin was uninstalled elsewhere".
   *
   * `basePath` is optional; omitting it (or pointing at a base that does
   * not exist yet) degrades to the historical UNION behaviour.
   */
  static async pullCommunityPlugins(
    reader: ConfigReader,
    remoteConfigDir: string,
    localConfigDir: string,
    basePath?: string | null,
  ): Promise<{ pulled: boolean; merged: string[] }> {
    const basename = 'community-plugins.json';
    const remoteRel = `${remoteConfigDir}/${basename}`;
    const localPath = path.join(localConfigDir, basename);

    fs.mkdirSync(localConfigDir, { recursive: true });
    const local = ShadowVaultBootstrap.readPluginIdList(localPath);

    let remote: string[] | null = null;
    try {
      if (await reader.exists(remoteRel)) {
        remote = ShadowVaultBootstrap.parsePluginIdList(await reader.read(remoteRel));
        if (remote === null) {
          logger.warn(
            `pullCommunityPlugins: remote ${basename} is not a valid id array; keeping local list`,
          );
        }
      }
    } catch (e) {
      logger.warn(`pullCommunityPlugins: ${basename} skipped (${errorMessage(e)})`);
    }

    const base = ShadowVaultBootstrap.readPluginIdBase(basePath);
    const merged = remote === null
      // Nothing readable on the remote → it gets no say this round. Keep
      // the local list as-is (only forcing `remote-ssh` on); do NOT let
      // `base \ remote` infer removals from a list we never saw.
      ? ShadowVaultBootstrap.mergePluginIds(local, local, null, ShadowVaultBootstrap.SELF_PLUGIN_ID)
      : ShadowVaultBootstrap.mergePluginIds(local, remote, base, ShadowVaultBootstrap.SELF_PLUGIN_ID);

    const changed =
      merged.length !== local.length || merged.some((id, i) => id !== local[i]);
    if (changed) ShadowVaultBootstrap.writePluginIdListAtomic(localPath, merged);

    logger.info(
      `pullCommunityPlugins: merged [${merged.join(', ')}] ` +
      `(changed=${changed}, base=${base ? `[${base.join(', ')}]` : 'none'})`,
    );
    return { pulled: remote !== null, merged };
  }

  /**
   * Push the local enabled-plugin list to the remote — 3-way merged
   * against the remote's CURRENT list and this device's base, with
   * `remote-ssh` forced on — then record the converged list as the new
   * base (both sides now hold it).
   *
   * Still self-protecting against clobber: it re-reads the remote first,
   * so a plugin another machine enabled (absent from the base AND from
   * this device's list = a remote *addition*) is preserved. If the remote
   * HAS the file but it can't be read or parsed, it aborts rather than
   * overwrite what it couldn't see — and leaves the base alone, so a
   * pending removal is simply retried on the next connect. A genuinely
   * absent remote file is seeded from local (no removals inferred: an
   * absent remote is not an emptied one).
   */
  static async pushCommunityPlugins(
    rw: ConfigReader & ConfigWriter,
    remoteConfigDir: string,
    localConfigDir: string,
    basePath?: string | null,
  ): Promise<{ pushed: boolean }> {
    const basename = 'community-plugins.json';
    const remoteRel = `${remoteConfigDir}/${basename}`;
    const local = ShadowVaultBootstrap.readPluginIdList(path.join(localConfigDir, basename));

    /** null = the remote has no list at all (fresh remote) — NOT an empty one. */
    let remote: string[] | null = null;
    try {
      if (await rw.exists(remoteRel)) {
        const parsed = ShadowVaultBootstrap.parsePluginIdList(await rw.read(remoteRel));
        if (parsed === null) {
          logger.warn('pushCommunityPlugins: remote list is not a valid id array; not pushing (avoid clobber)');
          return { pushed: false };
        }
        remote = parsed;
      }
    } catch (e) {
      logger.warn(`pushCommunityPlugins: cannot read remote (${errorMessage(e)}); not pushing (avoid clobber)`);
      return { pushed: false };
    }

    const base = ShadowVaultBootstrap.readPluginIdBase(basePath);
    const ids = remote === null
      // Seed a fresh remote from local. No base removals: "the remote has
      // no list" is not "the remote deleted everything".
      ? ShadowVaultBootstrap.mergePluginIds(local, local, null, ShadowVaultBootstrap.SELF_PLUGIN_ID)
      : ShadowVaultBootstrap.mergePluginIds(local, remote, base, ShadowVaultBootstrap.SELF_PLUGIN_ID);

    // No-op when the remote already equals the converged list — avoid
    // churn. The base is still committed: both sides DO hold `ids`, and
    // without this the steady state would never record a base at all.
    if (remote !== null && remote.length === ids.length && remote.every((id, i) => id === ids[i])) {
      ShadowVaultBootstrap.writePluginIdBase(basePath, ids);
      return { pushed: false };
    }
    try {
      await rw.write(remoteRel, JSON.stringify(ids) + '\n');
      // Only now do BOTH sides hold `ids` — commit the base. A write that
      // throws leaves the old base, so the merge is retried next connect.
      ShadowVaultBootstrap.writePluginIdBase(basePath, ids);
      logger.info(`pushCommunityPlugins: pushed [${ids.join(', ')}]`);
      return { pushed: true };
    } catch (e) {
      logger.warn(`pushCommunityPlugins: push failed (${errorMessage(e)})`);
      return { pushed: false };
    }
  }

  // ─── plugin code round-trip (#429b — BRAT / non-marketplace) ────────────
  //
  // The enabled-plugins LIST round-trips (above) and the marketplace
  // installer fetches binaries for plugins on Obsidian's registry. But a
  // BRAT / sideloaded plugin isn't on the marketplace, so its code would
  // never reach another machine. These methods round-trip the plugin
  // *code* through the remote vault's `.obsidian/plugins/<id>/` (the
  // canonical store) so such plugins load everywhere. Code only — the
  // plugin's own `data.json` (settings, sometimes secrets) is left alone.
  //
  // Convergence is VERSION-ORDERED, not last-writer-wins: pull only when
  // the remote is strictly newer (or the plugin is absent locally), push
  // only when the local copy is strictly newer (or the remote lacks it).
  // A plain "content differs" gate would let a machine still on an old
  // version downgrade a plugin the rest of the fleet already upgraded,
  // and the two sides would ping-pong forever (review: #429b).

  // NOTE: synced over a UTF-8 TEXT channel (readText/writeText). Every
  // entry MUST be text. Do NOT add binary assets (.png/.woff/…) here —
  // the UTF-8 round-trip would corrupt them.
  static readonly PLUGIN_BINARY_FILES = ['manifest.json', 'main.js', 'styles.css'] as const;

  /**
   * Pull a plugin's code from the remote into the local shadow when the
   * plugin is ABSENT locally or the remote is a STRICTLY NEWER version
   * (by manifest `version`) — so a plugin enabled/updated on another
   * machine (incl. BRAT / non-marketplace) reaches here and loads on the
   * next vault open. Never downgrades a local copy, never touches
   * `data.json`. `remote-ssh` is skipped (self-managed).
   */
  static async pullPluginBinaries(
    reader: ConfigReader,
    remoteConfigDir: string,
    localConfigDir: string,
    pluginIds: readonly string[],
  ): Promise<{ pulled: string[] }> {
    const pulled: string[] = [];
    const pluginsRoot = path.join(localConfigDir, 'plugins');
    for (const id of pluginIds) {
      if (id === ShadowVaultBootstrap.SELF_PLUGIN_ID) continue;
      // Parsed lists already drop these. A caller that passes a raw id
      // must still not interpolate it into the remote plugin path.
      if (!isSinglePathSegmentPluginId(id)) {
        logger.warn(`pullPluginBinaries: ${id} skipped (not a single path segment)`);
        continue;
      }
      const localPluginDir = containedPluginDirectory(pluginsRoot, id);
      // Before mkdir or writeFile: the plugin directory and every code
      // file must stay inside the local plugins directory.
      if (
        localPluginDir === null ||
        ShadowVaultBootstrap.PLUGIN_BINARY_FILES.some((file) =>
          containedPluginCodePath(pluginsRoot, path.join(id, file)) === null)
      ) {
        logger.warn(`pullPluginBinaries: ${id} skipped (outside the local plugins directory)`);
        continue;
      }
      const remoteManifest = `${remoteConfigDir}/plugins/${id}/manifest.json`;
      try {
        if (!(await reader.exists(remoteManifest))) continue; // no code on the remote
        const remoteVer = ShadowVaultBootstrap.parseManifestVersion(await reader.read(remoteManifest));
        const localManifest = path.join(localPluginDir, 'manifest.json');
        const localVer = fs.existsSync(localManifest)
          ? ShadowVaultBootstrap.parseManifestVersion(fs.readFileSync(localManifest, 'utf-8'))
          : null;
        // Skip unless absent locally, or the remote is strictly newer.
        if (localVer !== null && !ShadowVaultBootstrap.versionGt(remoteVer, localVer)) continue;
        const pending: { file: string; content: string }[] = [];
        for (const file of ShadowVaultBootstrap.PLUGIN_BINARY_FILES) {
          const remoteRel = `${remoteConfigDir}/plugins/${id}/${file}`;
          if (!(await reader.exists(remoteRel))) continue;
          pending.push({ file, content: await reader.read(remoteRel) });
        }
        // Re-resolve after the remote read, before any local write. A
        // symlink can appear in that gap. Refuse the whole id so a
        // later file cannot leave a newer manifest behind.
        const dirNow = containedPluginDirectory(pluginsRoot, id);
        const toWrite: { dest: string; content: string }[] = [];
        if (dirNow !== null) {
          for (const item of pending) {
            const dest = containedPluginCodePath(pluginsRoot, path.join(id, item.file));
            if (dest === null) break;
            toWrite.push({ dest, content: item.content });
          }
        }
        if (dirNow === null || toWrite.length !== pending.length) {
          logger.warn(`pullPluginBinaries: ${id} skipped (outside the local plugins directory)`);
          continue;
        }
        if (toWrite.length === 0) continue;
        ShadowVaultBootstrap.writePluginCodeFiles(dirNow, toWrite);
        pulled.push(id);
      } catch (e) {
        logger.warn(`pullPluginBinaries: ${id} skipped (${errorMessage(e)})`);
      }
    }
    if (pulled.length) logger.info(`pullPluginBinaries: staged [${pulled.join(', ')}]`);
    return { pulled };
  }

  /**
   * Push a plugin's local code to the remote when the remote LACKS it or
   * the local copy is a STRICTLY NEWER version — so other machines can
   * pull it. Never downgrades the remote, never pushes `data.json`;
   * byte-identical files are skipped to avoid churn. `remote-ssh` skipped.
   */
  static async pushPluginBinaries(
    rw: ConfigReader & ConfigWriter,
    remoteConfigDir: string,
    localConfigDir: string,
    pluginIds: readonly string[],
  ): Promise<{ pushed: string[] }> {
    const pushed: string[] = [];
    for (const id of pluginIds) {
      if (id === ShadowVaultBootstrap.SELF_PLUGIN_ID) continue;
      const localPluginDir = path.join(localConfigDir, 'plugins', id);
      const localManifest = path.join(localPluginDir, 'manifest.json');
      if (!fs.existsSync(localManifest)) continue; // nothing to push
      const remoteManifest = `${remoteConfigDir}/plugins/${id}/manifest.json`;
      try {
        const localVer = ShadowVaultBootstrap.parseManifestVersion(fs.readFileSync(localManifest, 'utf-8'));
        const remoteVer = (await rw.exists(remoteManifest))
          ? ShadowVaultBootstrap.parseManifestVersion(await rw.read(remoteManifest))
          : null;
        // Skip unless the remote lacks it, or the local copy is newer.
        if (remoteVer !== null && !ShadowVaultBootstrap.versionGt(localVer, remoteVer)) continue;
        let sent = false;
        for (const file of ShadowVaultBootstrap.PLUGIN_BINARY_FILES) {
          const localFile = path.join(localPluginDir, file);
          if (!fs.existsSync(localFile)) continue;
          const content = fs.readFileSync(localFile, 'utf-8');
          const remoteRel = `${remoteConfigDir}/plugins/${id}/${file}`;
          if ((await rw.exists(remoteRel)) && (await rw.read(remoteRel)) === content) continue; // identical
          await rw.write(remoteRel, content);
          sent = true;
        }
        if (sent) pushed.push(id);
      } catch (e) {
        logger.warn(`pushPluginBinaries: ${id} skipped (${errorMessage(e)})`);
      }
    }
    if (pushed.length) logger.info(`pushPluginBinaries: pushed [${pushed.join(', ')}]`);
    return { pushed };
  }

  /** Parse a manifest.json body's dotted-numeric `version` ([0] when absent/unparseable = oldest). */
  private static parseManifestVersion(body: string): number[] {
    try {
      const v = (JSON.parse(body) as { version?: unknown }).version;
      if (typeof v !== 'string') return [0];
      const parts = v.split('.').map((s) => parseInt(s, 10)).map((n) => (Number.isFinite(n) ? n : 0));
      return parts.length ? parts : [0];
    } catch {
      return [0];
    }
  }

  /** True when dotted-numeric version `a` is strictly greater than `b` (missing segments = 0). */
  private static versionGt(a: number[], b: number[]): boolean {
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const x = a[i] ?? 0;
      const y = b[i] ?? 0;
      if (x !== y) return x > y;
    }
    return false;
  }

  /**
   * Write every code file, or none of them.
   *
   * Each temp is created with `wx` (`O_EXCL`). A symlink already at that
   * path fails with EEXIST; `writeFileSync` would otherwise follow it
   * and write outside the plugins directory. Renames run only after
   * every temp exists, so a failed later file cannot publish a newer
   * manifest on its own.
   */
  private static writePluginCodeFiles(
    dir: string,
    files: readonly { dest: string; content: string }[],
  ): void {
    const created: string[] = [];
    try {
      fs.mkdirSync(dir, { recursive: true });
      for (const file of files) {
        const tmp = `${file.dest}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, file.content, { encoding: 'utf-8', flag: 'wx' });
        created.push(tmp);
      }
      for (let i = 0; i < files.length; i++) {
        fs.renameSync(created[i], files[i].dest);
      }
    } catch (e) {
      for (const tmp of created) {
        try { fs.unlinkSync(tmp); } catch { /* best effort */ }
      }
      throw e;
    }
  }

  /**
   * Parse a community-plugins.json body into a string-id array, or null
   * if malformed. Ids that are not a single path segment are dropped
   * here, so a later pull does not interpolate them into a remote
   * plugin path.
   */
  private static parsePluginIdList(content: string): string[] | null {
    try {
      const parsed: unknown = JSON.parse(content);
      if (!Array.isArray(parsed)) return null;
      return (parsed as unknown[]).filter((s): s is string =>
        typeof s === 'string' && isSinglePathSegmentPluginId(s));
    } catch {
      return null;
    }
  }

  /**
   * Enabled-plugin ids from a local `.obsidian/community-plugins.json`
   * ([] when absent/malformed) — the set whose binaries the connect flow
   * round-trips via {@link pullPluginBinaries}/{@link pushPluginBinaries}.
   */
  static readEnabledPluginIds(localConfigDir: string): string[] {
    return ShadowVaultBootstrap.readPluginIdList(path.join(localConfigDir, 'community-plugins.json'));
  }

  /** Read a local community-plugins.json into an id array ([] when absent/malformed). */
  private static readPluginIdList(localPath: string): string[] {
    try {
      return ShadowVaultBootstrap.parsePluginIdList(fs.readFileSync(localPath, 'utf-8')) ?? [];
    } catch {
      return [];
    }
  }

  /**
   * The 3-way converged enabled-plugin list.
   *
   * `base` is what BOTH sides held at the end of the last successful
   * round-trip on this device (null = none recorded yet). An id is
   * REMOVED iff it is in the base but has since disappeared from a side
   * that once had it (`base \ local` ∪ `base \ remote`); everything else
   * present on either side is kept — so an id absent from the base is an
   * ADDITION and always survives (the add-wins tie-break). `required`
   * (`remote-ssh`) is never removable and is always present.
   *
   * With `base === null` the removal set is empty and this degrades
   * EXACTLY to the historical order-preserving union of local + remote —
   * the documented first-run fallback (nothing can be lost, but a removal
   * cannot be inferred either).
   *
   * Order is local-first, then remote-only additions, then `required`:
   * deterministic and identical in the pull and the push, so once both
   * sides converge the push's equality check sees a true no-op.
   */
  private static mergePluginIds(
    local: string[],
    remote: string[],
    base: string[] | null,
    required: string,
  ): string[] {
    const removed = new Set<string>();
    if (base) {
      const inLocal = new Set(local);
      const inRemote = new Set(remote);
      for (const id of base) {
        if (!inLocal.has(id) || !inRemote.has(id)) removed.add(id);
      }
    }
    // The one plugin that may never be uninstalled — it IS the sync.
    removed.delete(required);

    const out: string[] = [];
    const seen = new Set<string>();
    for (const id of [...local, ...remote, required]) {
      if (removed.has(id) || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  }

  /**
   * This device's base snapshot ([] is meaningful — "both sides were
   * empty"), or null when there is no usable base: no path given, the
   * file doesn't exist yet (first run / freshly re-bootstrapped shadow),
   * or it is malformed. null means "fall back to the union" — never
   * "everything was removed", which is why a malformed base is degraded
   * rather than treated as empty.
   */
  private static readPluginIdBase(basePath: string | null | undefined): string[] | null {
    if (!basePath) return null;
    let raw: string;
    try {
      raw = fs.readFileSync(basePath, 'utf-8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn(`communityPlugins base: unreadable ${basePath} (${errorMessage(e)}); falling back to union`);
      }
      return null;
    }
    const parsed = ShadowVaultBootstrap.parsePluginIdList(raw);
    if (parsed === null) {
      logger.warn(`communityPlugins base: malformed ${basePath}; falling back to union`);
    }
    return parsed;
  }

  /**
   * Record the converged list as this device's new base. Best-effort: a
   * failure here only costs the NEXT connect its removal inference (it
   * degrades to a union), so it must never fail the round-trip that has
   * already written both sides.
   */
  private static writePluginIdBase(basePath: string | null | undefined, ids: string[]): void {
    if (!basePath) return;
    try {
      fs.mkdirSync(path.dirname(basePath), { recursive: true });
      ShadowVaultBootstrap.writePluginIdListAtomic(basePath, ids);
    } catch (e) {
      logger.warn(`communityPlugins base: failed to record ${basePath} (${errorMessage(e)})`);
    }
  }

  /** Atomic (tmp + rename) write of an id array as JSON. */
  private static writePluginIdListAtomic(localPath: string, ids: string[]): void {
    const tmp = `${localPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(ids) + '\n', 'utf-8');
    try {
      fs.renameSync(tmp, localPath);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* best effort */ }
      throw e;
    }
  }

  // ─── internals ──────────────────────────────────────────────────────────

  /**
   * Materialise `<configDir>/community-plugins.json`.
   *
   * - First bootstrap (file doesn't exist): write `["remote-ssh"]`
   *   only. Source's enabled plugin set is captured separately via
   *   `collectPendingPluginSuggestions` so the shadow window can
   *   prompt the user to opt in selectively.
   * - Re-bootstrap (file exists): leave the user's accumulated list
   *   alone. Only ensure `remote-ssh` is in it.
   */
  private seedCommunityPlugins(configDir: string): void {
    const shadowPath = path.join(configDir, 'community-plugins.json');

    if (fs.existsSync(shadowPath)) {
      try {
        const existing: unknown = JSON.parse(fs.readFileSync(shadowPath, 'utf-8'));
        if (Array.isArray(existing)) {
          const ids = (existing as unknown[]).filter((s): s is string => typeof s === 'string');
          if (!ids.includes('remote-ssh')) {
            ids.push('remote-ssh');
            fs.writeFileSync(shadowPath, JSON.stringify(ids) + '\n', 'utf-8');
          }
          return;
        }
      } catch (e) {
        logger.warn(
          `ShadowVaultBootstrap: failed to parse shadow community-plugins.json ` +
          `(${errorMessage(e)}); rewriting as [remote-ssh]`,
        );
      }
    }

    fs.writeFileSync(shadowPath, JSON.stringify(['remote-ssh']) + '\n', 'utf-8');
  }

  /**
   * Seed the minimal `.obsidian/` state Obsidian needs to treat a
   * freshly-created shadow vault as *already configured*, so it loads
   * community plugins (incl. remote-ssh) on first open instead of
   * coming up in first-run / Restricted mode. Without this the very
   * first connect to a new profile deadlocks: the plugin never loads
   * → runAutoConnect never runs → settings pull never runs
   * → the real app.json is never pulled → the vault stays "never
   * configured" forever (observed in the field: a brand-new shadow
   * vault with an empty app.json and zero plugin log).
   *
   * Idempotent and non-destructive — only writes a file that is a
   * first-run placeholder: absent, blank, unparseable, or the literal
   * empty `{}` / `[]` Obsidian itself writes on first run. A real
   * app.json / core-plugins.json (written later by
   * settings pull, or by Obsidian once the vault has been
   * used) has ≥1 key/element and is never clobbered. The e2e scaffold
   * (`e2e/helpers/vault-scaffold.ts`) has always pre-written exactly
   * this; the production bootstrap was the one missing it — which is
   * also why the connect e2e never reproduced the failure.
   */
  private seedObsidianFirstRunState(configDir: string): void {
    const appPath = path.join(configDir, 'app.json');
    // Obsidian's actual first-run app.json is the literal `{}` — NOT a
    // zero-byte file. A `.trim() === ''` check misses that and leaves
    // the deadlock in place (the field symptom). Seed when the file is
    // absent, blank, unparseable, or an empty object; a real app.json
    // (≥1 key) is left untouched.
    if (this.needsFirstRunSeed(appPath, isNonEmptyObject)) {
      fs.writeFileSync(
        appPath,
        JSON.stringify({ promptDelete: false }, null, 2) + '\n',
        'utf-8',
      );
    }

    // Same rule for core-plugins.json — `!existsSync` alone left a
    // zero-byte / `[]` file as a deadlock (asymmetric with app.json).
    const corePath = path.join(configDir, 'core-plugins.json');
    if (this.needsFirstRunSeed(corePath, isNonEmptyArray)) {
      fs.writeFileSync(
        corePath,
        JSON.stringify([
          'file-explorer', 'global-search', 'switcher', 'graph', 'backlink',
          'canvas', 'outgoing-link', 'tag-pane', 'page-preview', 'daily-notes',
          'templates', 'note-composer', 'command-palette', 'editor-status',
          'bookmarks', 'markdown-importer', 'outline', 'word-count',
          'file-recovery',
        ]) + '\n',
        'utf-8',
      );
    }
  }

  /**
   * True when `filePath` is a first-run placeholder that must be
   * (re)seeded: absent, blank, unparseable, or parses to a value the
   * `isConfigured` predicate rejects (e.g. `{}` / `[]`).
   *
   * A non-ENOENT read error (EACCES, EISDIR, …) is NOT "absent" — it
   * is rethrown rather than silently treated as "needs seed", which
   * would clobber a file we merely failed to read.
   */
  private needsFirstRunSeed(
    filePath: string,
    isConfigured: (parsed: unknown) => boolean,
  ): boolean {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw e;
    }
    if (raw.trim() === '') return true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return true; // corrupt/partial → treat as placeholder, reseed
    }
    return !isConfigured(parsed);
  }

  /**
   * Snapshot the source vault's enabled community plugins (other
   * than our own `remote-ssh`) plus each one's source-side
   * `data.json`. Stored in shadow `data.json` as
   * `pendingPluginSuggestions` so the shadow window can prompt the
   * user to install only what they want — no surprise auto-install
   * after Obsidian's "trust this vault" dialog.
   *
   * Returns an empty array if source has no community-plugins.json,
   * if it has only `remote-ssh`, or if it can't be parsed.
   */
  private collectPendingPluginSuggestions(): PendingPluginSuggestion[] {
    const sourceConfigDir = this.sourceConfigDir();
    const sourceListPath = path.join(sourceConfigDir, 'community-plugins.json');
    if (!fs.existsSync(sourceListPath)) return [];

    let sourceIds: string[];
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(sourceListPath, 'utf-8'));
      if (!Array.isArray(parsed)) return [];
      sourceIds = (parsed as unknown[]).filter((s): s is string => typeof s === 'string' && s !== 'remote-ssh');
    } catch (e) {
      logger.warn(
        `ShadowVaultBootstrap: failed to parse source community-plugins.json ` +
        `(${errorMessage(e)}); no suggestions will be offered`,
      );
      return [];
    }

    const sourcePluginsRoot = path.join(sourceConfigDir, 'plugins');
    return sourceIds.map(id => {
      let sourceData: unknown = null;
      const dataPath = path.join(sourcePluginsRoot, id, 'data.json');
      if (fs.existsSync(dataPath)) {
        try {
          sourceData = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
        } catch (e) {
          logger.warn(
            `ShadowVaultBootstrap: failed to parse source data.json for ${id} ` +
            `(${errorMessage(e)}); will offer install without config inheritance`,
          );
        }
      }
      return { id, sourceData };
    });
  }

  /**
   * `.obsidian/` of the source vault — derived from
   * `sourcePluginDir` which lives at `<source-vault>/.obsidian/plugins/remote-ssh`.
   */
  private sourceConfigDir(): string {
    // sourcePluginDir = <vault>/.obsidian/plugins/remote-ssh
    // → walk up two levels for .obsidian/.
    return path.dirname(path.dirname(this.sourcePluginDir));
  }

  /**
   * Decide what to use as the base for the shadow vault's
   * `data.json` before merging the bootstrap-managed fields:
   *
   * - If a shadow `data.json` already exists, parse and use it.
   *   Preserves anything the shadow has accumulated since last
   *   bootstrap (hostKeyStore, secrets, user preferences).
   * - Otherwise, fall back to the source vault's `data.json` so the
   *   first shadow connect can re-use the user's already-trusted
   *   host keys instead of TOFU-prompting.
   * - Otherwise, start fresh `{}`.
   *
   * Parse failures are logged and treated as "start fresh" — better
   * to lose accumulated state than write a corrupted JSON file
   * that would brick the plugin on next load.
   */
  private readBaseDataJson(shadowDataPath: string): Record<string, unknown> {
    const candidates = [shadowDataPath, path.join(this.sourcePluginDir, 'data.json')];
    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) continue;
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch (e) {
        logger.warn(
          `ShadowVaultBootstrap: failed to parse ${candidate} (${errorMessage(e)}); ` +
          'continuing without it',
        );
      }
    }
    return {};
  }

  /**
   * Read just the `secrets` blob from the SOURCE vault's data.json.
   *
   * Used to propagate a password persisted in the source (local) vault
   * into the shadow that runs the connect (#399). Unlike
   * `readBaseDataJson` — which prefers the shadow's own copy so its
   * accumulated state survives — this always reads source, so the merge
   * in `bootstrapSync` can let the source's latest secret win.
   *
   * Returns `{}` when source has no data.json, it can't be parsed, or it
   * carries no (well-formed) secrets — all benign "nothing to add" cases.
   */
  private readSourceSecrets(): Record<string, unknown> {
    const sourceDataPath = path.join(this.sourcePluginDir, 'data.json');
    if (!fs.existsSync(sourceDataPath)) return {};
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(sourceDataPath, 'utf-8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return asSecretRecord((parsed as Record<string, unknown>).secrets);
      }
    } catch (e) {
      logger.warn(
        `ShadowVaultBootstrap: failed to read source secrets (${errorMessage(e)}); ` +
        'shadow will rely on its own accumulated secrets',
      );
    }
    return {};
  }

  /**
   * Install the plugin per-file rather than as one big symlinked
   * directory.
   *
   * The earlier "symlink the whole plugin dir" approach was tighter
   * and one fewer step, but it sneakily broke the source vault: the
   * shadow vault's plugin would write its own per-vault `data.json`
   * THROUGH the symlink, clobbering the source vault's settings
   * (hostKeyStore, secrets, …) on the very first connect.
   *
   * Fix: pluginDir is a **real directory**. Code + assets
   * (`main.js`, `manifest.json`, `styles.css`, `server-bin/`) are
   * symlinked individually so dev-build iterations land immediately,
   * but `data.json` is **never touched** by install — the caller
   * writes the per-vault data.json into pluginDir as a real file,
   * leaving the source vault's data.json untouched.
   */
  private installPlugin(pluginDir: string): 'symlink' | 'copy' | 'in-place' {
    // If pluginDir is a stale whole-dir symlink from an older build
    // (or a previous run of this same code on an older version),
    // unlink it — DO NOT rmSync, that would follow the link and
    // recursively delete the source plugin dir.
    try {
      const stat = fs.lstatSync(pluginDir);
      if (stat.isSymbolicLink()) {
        fs.unlinkSync(pluginDir);
      }
    } catch {
      // Doesn't exist yet, fine.
    }

    // Self-install guard: when the bootstrap runs from INSIDE the
    // shadow window it targets, sourcePluginDir IS pluginDir. The
    // rm+symlink cycle below would then delete each real plugin file
    // and replace it with a symlink pointing at its own path — a
    // self-referential link Obsidian can't resolve, so the plugin
    // "disappears" on the next start. The bundle is already here;
    // there is nothing to install.
    try {
      if (fs.realpathSync(this.sourcePluginDir) === fs.realpathSync(pluginDir)) {
        return 'in-place';
      }
    } catch {
      // Either side unresolvable (e.g. pluginDir doesn't exist yet, or
      // the stale whole-dir symlink was just unlinked) → not the same
      // dir; proceed with a normal install.
    }

    fs.mkdirSync(pluginDir, { recursive: true });

    const sharedFiles = ['main.js', 'manifest.json', 'styles.css'];
    const sharedDirs = ['server-bin'];

    let useSymlink = true;

    for (const f of sharedFiles) {
      const src = path.join(this.sourcePluginDir, f);
      const dst = path.join(pluginDir, f);
      if (!fs.existsSync(src)) continue;
      // Plain rmSync handles existing file or file-symlink — does NOT
      // follow into directories.
      try { fs.rmSync(dst, { force: true }); } catch { /* noop */ }
      if (useSymlink) {
        try { fs.symlinkSync(src, dst, 'file'); continue; }
        catch (e) {
          logger.warn(`ShadowVaultBootstrap: file symlink failed (${errorMessage(e)}); falling back to copy`);
          useSymlink = false;
        }
      }
      fs.copyFileSync(src, dst);
    }

    for (const d of sharedDirs) {
      const src = path.join(this.sourcePluginDir, d);
      const dst = path.join(pluginDir, d);
      // Only mirror a REAL source dir (a local dev build of the daemon). A
      // junction/symlink source is NOT propagated: it would chain the shadow
      // to another vault's server-bin and dangle if that vault is deleted,
      // breaking the per-shadow daemon download (the binary is per-arch,
      // fetched at connect time — not a shared build artifact like main.js).
      let srcStat: fs.Stats;
      try { srcStat = fs.lstatSync(src); } catch { continue; }  // absent → skip
      if (srcStat.isSymbolicLink() || !srcStat.isDirectory()) continue;
      // Use lstat + unlink for symlinks vs rmSync recursive for real
      // dirs so we never accidentally recurse through a link.
      try {
        const stat = fs.lstatSync(dst);
        if (stat.isSymbolicLink()) fs.unlinkSync(dst);
        else                       fs.rmSync(dst, { recursive: true, force: true });
      } catch { /* noop */ }
      if (useSymlink) {
        try {
          const linkType = process.platform === 'win32' ? 'junction' : 'dir';
          fs.symlinkSync(src, dst, linkType);
          continue;
        } catch (e) {
          logger.warn(`ShadowVaultBootstrap: dir symlink failed (${errorMessage(e)}); falling back to copy`);
          useSymlink = false;
        }
      }
      // dereference so a symlinked source produces real files in the
      // shadow vault rather than nested links that wouldn't resolve.
      fs.cpSync(src, dst, { recursive: true, dereference: true });
    }

    return useSymlink ? 'symlink' : 'copy';
  }
}

/**
 * Filesystem-safe form of a profile id for the per-device `state/<key>/`
 * dir. Ids are normally UUIDs (already safe), but they come from
 * data.json and are not validated anywhere, so a hand-edited id must not
 * be able to escape `state/` via `..` or a path separator.
 */
function sanitiseStateKey(profileId: string): string {
  const cleaned = (profileId ?? '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64);
  if (!cleaned || /^\.+$/.test(cleaned)) return 'default';
  return cleaned;
}

/**
 * Filesystem-safe form of a profile *name* for the friendly vault-dir
 * name. Obsidian shows a vault by its directory basename, so this is
 * what the user sees instead of a raw UUID. Spaces are kept (valid in
 * dir names on every OS); anything path-dangerous is collapsed to `_`;
 * length-capped; never `.`/`..`/empty.
 */
function sanitiseVaultName(name: string): string {
  const cleaned = (name ?? '')
    .replace(/[^a-zA-Z0-9._ -]/g, '_')
    .replace(/_{2,}/g, '_')
    .trim()
    .slice(0, 40)
    .trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'vault';
  return cleaned;
}

/**
 * Filesystem-safe form of the remotePath's LAST segment. One host
 * (profile name) often holds several independent vaults under
 * different folders, so the folder tail is what disambiguates them —
 * `/home/souta/work` → `work`, `/home/souta/work/dev` → `dev`. Same
 * sanitising rules as the name; a bare/degenerate path falls back to
 * `vault`.
 */
function sanitisePathTail(remotePath: string): string {
  const trimmed = (remotePath ?? '').replace(/[/\\]+$/, '');
  const tail = trimmed.split(/[/\\]/).pop() ?? '';
  // A bare `~` (vault rooted at the remote home dir) has no meaningful
  // folder tail — catch it before the charset strip below turns it into `_`.
  if (tail === '~') return 'vault';
  const cleaned = tail
    .replace(/[^a-zA-Z0-9._ -]/g, '_')
    .replace(/_{2,}/g, '_')
    .trim()
    .slice(0, 40)
    .trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'vault';
  return cleaned;
}

/**
 * The shadow vault's directory name: `<friendly-name>--<path-tail>`.
 * The name identifies the host, the tail the folder — together they
 * let Obsidian show a recognisable, folder-distinct name (e.g.
 * `Panza--work` vs `Panza--dev`) instead of a bare UUID. The id is NOT
 * in the name: identity is resolved from `data.json`'s
 * `autoConnectProfileId` (see `findShadowByProfileId`), so a profile
 * rename or a display-name collision never strands its config.
 */
function friendlyVaultDirName(profile: Pick<SshProfile, 'name' | 'remotePath'>): string {
  return `${sanitiseVaultName(profile.name)}--${sanitisePathTail(profile.remotePath)}`;
}
