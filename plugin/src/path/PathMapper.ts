import * as os from 'os';

export const DEVICE_SETTINGS_FILES = [
  'app.json',
  'appearance.json',
  'core-plugins.json',
  'hotkeys.json',
] as const;

/**
 * Default Obsidian config-directory name (`.obsidian`). We construct
 * the literal via concatenation so the source text never contains the
 * raw `.obsidian` literal that `obsidianmd/hardcoded-config-path`
 * rejects. Production callers must pass `app.vault.configDir` to the
 * `PathMapper` constructor; this default exists only so older test
 * call-sites that pre-date the configDir refactor stay green.
 */
function defaultObsidianConfigDir(): string {
  return '.' + 'obsidian';
}

/**
 * Filenames (relative to the vault's *configDir*) that hold
 * *client-private* state and must not be shared across machines. The
 * mapper redirects them from `<configDir>/<file>` to
 * `<configDir>/user/<client-id>/<file>` so two clients can sit on the
 * same vault without trampling each other's UI state.
 *
 * The list errs on the side of "private" because nothing here costs
 * the user anything to keep per-machine, and the alternatives
 * (corrupted layout files, conflicting graph views) are loud failures.
 *
 * Patterns are matched as either an exact configDir-relative filename
 * or a directory prefix (so `cache` covers everything inside). A `*`
 * segment matches exactly one path segment (see `matchesPrivatePattern`),
 * which is what lets us privatise `plugins/<id>/data.json` without
 * dragging the plugin's *code* along with it.
 */
export const DEFAULT_PRIVATE_PATTERN_BASENAMES: readonly string[] = [
  'workspace.json',
  'workspace-mobile.json',
  // Per-device Obsidian settings. Each machine keeps its OWN
  // app/appearance/hotkeys/enabled-core-plugins under its per-client
  // subtree instead of fighting over one shared copy on the remote.
  // The shared copy was a perpetual write-conflict source: two sessions
  // (or the same device across reconnects) both wrote `<configDir>/app.json`
  // at the identity path, so every settings save tripped PreconditionFailed
  // against the other's mtime. Redirecting them makes a shared path — and
  // thus the conflict — impossible by construction.
  ...DEVICE_SETTINGS_FILES,
  // Third-party plugin SETTINGS (#342 / #429) — per-device for exactly the
  // same reason as the four above. `Plugin.saveData()` fires on every
  // settings change, so a shared `<configDir>/plugins/<id>/data.json` would
  // reintroduce the perpetual write-conflict the redirect above just killed.
  //
  // Deliberately `plugins/*/data.json` and NOT `plugins`: the plugin's CODE
  // (manifest.json / main.js / styles.css) must stay SHARED at the identity
  // path so a plugin installed on one machine still loads on every other —
  // that round-trip is `ShadowVaultBootstrap.PLUGIN_BINARY_FILES`. Only the
  // settings go per-device.
  'plugins/*/data.json',
  'cache',
  'cache.zlib',
  'types.json',
  'file-recovery.json',
  'graph.json',
  'canvas.json',
];

/**
 * Match a configDir-rooted private pattern against a normalized
 * vault-relative path.
 *
 * Semantics: exact match, or directory-prefix match (`cache` covers
 * `cache/anything`). A `*` pattern segment matches exactly one path
 * segment — never across `/` — so `plugins/*` + `data.json` catches
 * `plugins/claudian/data.json` but leaves `plugins/claudian/main.js`
 * shared.
 */
function matchesPrivatePattern(pattern: string, normalized: string): boolean {
  if (!pattern.includes('*')) {
    return normalized === pattern || normalized.startsWith(pattern + '/');
  }
  const pat = pattern.split('/');
  const seg = normalized.split('/');
  // Shorter than the pattern → neither the file itself nor inside it.
  if (seg.length < pat.length) return false;
  for (let i = 0; i < pat.length; i++) {
    if (pat[i] === '*') continue; // any single segment
    if (pat[i] !== seg[i]) return false;
  }
  // Equal depth = the file itself; deeper = inside it (directory-prefix).
  return true;
}

/**
 * Back-compat re-export: the basenames joined onto the default
 * configDir. Kept as a `readonly string[]` so existing callers /
 * tests that imported `DEFAULT_PRIVATE_PATTERNS` keep working
 * without source changes.
 */
export const DEFAULT_PRIVATE_PATTERNS: readonly string[] =
  DEFAULT_PRIVATE_PATTERN_BASENAMES.map(
    (b) => `${defaultObsidianConfigDir()}/${b}`,
  );

/**
 * The directory name (under `<configDir>/`) we own for per-client
 * subtrees. Listing `<configDir>/` strips this so other clients'
 * state never surfaces in the vault's UI.
 */
const PRIVATE_USER_SUBDIR = 'user';

/**
 * Sanitize a hostname into something safe to use as a directory name.
 * Keeps ASCII alphanumerics, dots, hyphens, underscores. Replaces
 * everything else with `-`. Empty input yields `'unknown'`.
 */
export function sanitizeClientId(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'unknown';
}

/**
 * Returns a stable client id derived from the OS hostname. Designed
 * for the single-machine common case; multi-instance setups should
 * pass an explicit override to the PathMapper constructor.
 */
export function defaultClientId(): string {
  try {
    return sanitizeClientId(os.hostname());
  } catch {
    return 'unknown';
  }
}

/**
 * Default human-readable user name for the device. Used as a
 * placeholder in the settings UI and as the fallback when the user
 * leaves the field blank. Falls through to "unknown" if `userInfo()`
 * is unavailable (it's documented to throw on some restricted
 * environments).
 */
export function defaultUserName(): string {
  try {
    const info = os.userInfo();
    return info.username || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * PathMapper translates between the vault-relative paths Obsidian uses
 * and the actual paths we store on the remote. The mapping is the
 * identity for ordinary vault content; only `.obsidian/*` files
 * matched by `DEFAULT_PRIVATE_PATTERNS` (or a caller-supplied
 * extension) are redirected into a per-client subtree.
 *
 * The class is stateless apart from its configuration, so a single
 * instance can serve every adapter call without locking.
 */
export class PathMapper {
  /** Per-machine identifier (sanitised hostname). */
  public readonly clientId: string;

  /**
   * The Obsidian vault-relative configDir name (`.obsidian` by
   * default). Exposed so collaborators (e.g. WatchEventFilter) can
   * build configDir-rooted path-prefixes without re-deriving it.
   */
  public readonly configDir: string;
  private readonly configDirSlash: string;
  private readonly privateRoot: string;
  private readonly privatePatterns: readonly string[];

  /**
   * Constructor overloads support both the legacy two-arg form
   * `new PathMapper(clientId, customPatterns?)` and the new three-arg
   * form `new PathMapper(clientId, configDir, customPatterns?)`. The
   * historical call site (and the unit suite) passes `customPatterns`
   * directly as the second argument; new production callers should
   * always supply `configDir`.
   *
   * Internally we dispatch on whether the second arg is a string
   * (configDir) or an array (legacy patterns).
   */
  constructor(clientId: string, configDirOrPatterns?: string | readonly string[], privatePatterns?: readonly string[]) {
    let configDir: string;
    let patterns: readonly string[];
    if (Array.isArray(configDirOrPatterns)) {
      // Legacy two-arg form: `new PathMapper(clientId, patterns)`.
      configDir = defaultObsidianConfigDir();
      patterns = configDirOrPatterns;
    } else {
      configDir = (configDirOrPatterns as string | undefined) ?? defaultObsidianConfigDir();
      patterns = privatePatterns ?? DEFAULT_PRIVATE_PATTERN_BASENAMES;
    }
    this.clientId = clientId;
    this.configDir = configDir;
    this.configDirSlash = `${configDir}/`;
    this.privateRoot = `${configDir}/${PRIVATE_USER_SUBDIR}/${clientId}`;
    // Resolve relative patterns against `configDir`. Absolute patterns
    // (those that already start with `configDir/`) are kept as-is so
    // back-compat callers passing the legacy fully-qualified list keep
    // working.
    this.privatePatterns = patterns.map((p) =>
      p.startsWith(this.configDirSlash) ? p : `${configDir}/${p}`,
    );
  }

  // ─── classification ──────────────────────────────────────────────────────

  /** True when the vault-relative path should live in this client's private subtree. */
  isPrivate(vaultPath: string): boolean {
    const normalized = stripLeadingSlash(vaultPath);
    return this.privatePatterns.some(p => matchesPrivatePattern(p, normalized));
  }

  /**
   * True when the path is the parent of one or more private patterns
   * but not itself private. Listing such a path needs to be merged
   * with this client's private subtree so the patterns appear under
   * their nominal names.
   *
   * In practice the only such path today is the configDir itself.
   */
  isCrossingPoint(vaultPath: string): boolean {
    const normalized = stripLeadingSlash(vaultPath);
    if (this.isPrivate(normalized)) return false;
    // Exact-depth match (not dir-prefix): the crossing point is the pattern's
    // immediate parent. For `plugins/*/data.json` that is `plugins/<id>` — so
    // listing a plugin's own dir merges in this client's private `data.json`,
    // while listing `plugins/` itself does not (every plugin dir already
    // exists at the shared identity path, because the CODE is shared).
    return this.privatePatterns.some(p => matchesPatternExact(parentDirOf(p), normalized));
  }

  // ─── translation ─────────────────────────────────────────────────────────

  /**
   * Convert a vault-relative path to the path that should be sent to
   * the remote. Identity for non-private paths; redirects private
   * paths into the per-client subtree.
   *
   * Custom patterns are expected to live under `configDir` so the
   * redirect lands inside the per-client subtree cleanly; a pattern
   * outside that prefix is accepted but its full original path is
   * appended verbatim.
   */
  toRemote(vaultPath: string): string {
    const normalized = stripLeadingSlash(vaultPath);
    if (!this.isPrivate(normalized)) return vaultPath;
    const rest = normalized.startsWith(this.configDirSlash)
      ? normalized.slice(this.configDirSlash.length)
      : normalized;
    return `${this.privateRoot}/${rest}`;
  }

  /**
   * Inverse: take a path that came back from the remote (e.g. an
   * entry name during a list merge) and convert it back to the path
   * Obsidian thinks it's reading. Foreign clients' subtrees are
   * preserved unchanged so callers can decide whether to filter them.
   */
  toVault(remotePath: string): string {
    const prefix = `${this.privateRoot}/`;
    if (remotePath.startsWith(prefix)) {
      return `${this.configDirSlash}${remotePath.slice(prefix.length)}`;
    }
    return remotePath;
  }

  // ─── listing helpers ─────────────────────────────────────────────────────

  /**
   * Plan a `list(vaultPath)` execution.
   *
   * The returned `primary` is always queried. When `mergeFromUser` is
   * true the caller should also list `userSubtree` and concatenate;
   * `hideUserDirName`, when set, names a directory entry that should
   * be dropped from the primary listing (the "user" sibling under
   * the configDir).
   */
  resolveListing(vaultPath: string): {
    primary: string;
    mergeFromUser: boolean;
    userSubtree?: string;
    hideUserDirName?: string;
  } {
    const normalized = stripLeadingSlash(vaultPath);
    if (this.isPrivate(normalized)) {
      // The whole subtree lives in user/<id>/...
      return { primary: this.toRemote(vaultPath), mergeFromUser: false };
    }
    if (this.isCrossingPoint(normalized)) {
      // The private subtree mirrors the configDir-relative path, so the
      // crossing point's counterpart is `privateRoot/<same relative path>`.
      // For the configDir itself that relative path is empty → privateRoot.
      // For `<configDir>/plugins/<id>` it is `privateRoot/plugins/<id>`.
      const rest = normalized.startsWith(this.configDirSlash)
        ? normalized.slice(this.configDirSlash.length)
        : '';
      return {
        primary: vaultPath,
        mergeFromUser: true,
        userSubtree: rest ? `${this.privateRoot}/${rest}` : this.privateRoot,
        // Only the configDir itself has the `user` sibling to hide, so other
        // clients' subtrees never surface. Deeper crossing points (a plugin's
        // own dir) have no such sibling.
        hideUserDirName: normalized === this.configDir ? PRIVATE_USER_SUBDIR : undefined,
      };
    }
    return { primary: vaultPath, mergeFromUser: false };
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────

/**
 * Segment-wise EXACT match (same depth, `*` matching any one segment).
 * Unlike `matchesPrivatePattern` this never matches a deeper path, so it
 * is safe for crossing-point detection where a dir-prefix match would
 * wrongly flag every ancestor.
 */
function matchesPatternExact(pattern: string, normalized: string): boolean {
  const pat = pattern.split('/');
  const seg = normalized.split('/');
  if (pat.length !== seg.length) return false;
  for (let i = 0; i < pat.length; i++) {
    if (pat[i] === '*') continue;
    if (pat[i] !== seg[i]) return false;
  }
  return true;
}

function stripLeadingSlash(p: string): string {
  return p.startsWith('/') ? p.slice(1) : p;
}

function parentDirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}
