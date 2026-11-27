import * as fs from 'node:fs';
import * as path from 'node:path';
import { ShadowVaultBootstrap, type ShadowVaultLayout } from '../../../src/shadow/ShadowVaultBootstrap';
import { stageDeviceSettings } from '../../../src/shadow/DeviceSettingsSync';
import type { SshProfile } from '../../../src/types';
import type { TestClient } from './makeAdapter';

/**
 * `assertConfigRoundTrip` — Layer 2 of the sync-test framework.
 *
 * Validates that a configurable allowlist of per-device Obsidian settings
 * files survives a plugin restart: any content written to the remote
 * during one session must be visible to Obsidian on the next session,
 * which means it must end up on the local shadow-vault disk before
 * Obsidian's 2nd window opens and reads from it.
 *
 * The contract this helper asserts is symmetrical to #342: with a
 * fresh local shadow vault, after bootstrap runs against a profile
 * whose remote already carries `<configDir>/app.json` (etc.), the
 * local file must equal the remote.
 *
 * Bootstrap is purely local. The helper runs the production settings
 * pull after it and checks that the remote bytes land on the shadow disk.
 *
 * Why this is its own helper (vs. inlined in the test): the round-trip
 * setup has three independent moving parts (seed remote, run bootstrap,
 * compare local↔remote), each of which can fail with a useful message.
 * Centralising the comparison + error formatting keeps the test cases
 * declarative — one allowlisted file path per case.
 */

export interface AssertConfigRoundTripOpts {
  /** Connected SSH client that owns the remote write. */
  remoteClient: TestClient;

  /** Bootstrap instance under test. Already constructed with the test's tmp baseDir. */
  bootstrap: ShadowVaultBootstrap;

  /** Profile to pass to `bootstrap()`. Must match `remoteClient`'s connection. */
  profile: SshProfile;

  /** All profiles to pass to `bootstrap()` (usually just `[profile]`). */
  allProfiles: SshProfile[];

  /**
   * Config file relative to `<configDir>/` to seed on the remote and
   * verify on the local shadow. Eg. `'app.json'`, `'appearance.json'`,
   * `'core-plugins.json'`, `'hotkeys.json'`.
   */
  configBasename: string;

  /** JSON content to seed on the remote before bootstrap runs. */
  remoteContent: unknown;

  /** Label included in error messages so failures point to the case. */
  label?: string;
}

export interface AssertConfigRoundTripResult {
  /** Layout returned by the bootstrap (so the caller can clean up). */
  layout: ShadowVaultLayout;
  /** What was found on the local shadow after bootstrap, parsed as JSON. */
  localContent: unknown;
}

export async function assertConfigRoundTrip(
  opts: AssertConfigRoundTripOpts,
): Promise<AssertConfigRoundTripResult> {
  const { remoteClient, bootstrap, profile, allProfiles, configBasename, remoteContent, label } = opts;

  // ── 1. Seed the remote ─────────────────────────────────────────────
  //
  // `<remoteVaultRoot>/.obsidian/<basename>` — same path the production
  // adapter would write through to.
  const remoteConfigDir = `.obsidian`;
  const remoteRelPath = `${remoteConfigDir}/${configBasename}`;
  const remoteAbsPath = remoteClient.adapter.toRemote(remoteRelPath);

  // Ensure the parent exists; SftpDataAdapter.mkdirp handles "exists ok".
  await remoteClient.adapter.mkdir(remoteConfigDir);
  await remoteClient.adapter.write(remoteRelPath, JSON.stringify(remoteContent));

  // ── 2. Run bootstrap, then stage per-device settings ──────────────
  const result = await bootstrap.bootstrap(profile, allProfiles);
  await stageDeviceSettings({ remoteConfigDir, localConfigDir: result.layout.configDir }, remoteClient.adapter);

  // ── 3. Compare local ↔ remote ─────────────────────────────────────
  const localAbsPath = path.join(result.layout.configDir, configBasename);
  if (!fs.existsSync(localAbsPath)) {
    throw new Error(
      `${labelPrefix(label)}local shadow vault missing ${configBasename}; ` +
      `remote ${remoteAbsPath} has it but bootstrap did not pull. ` +
      `This is the #342 gap: per-device Obsidian settings don't round-trip.`,
    );
  }

  let localContent: unknown;
  try {
    localContent = JSON.parse(fs.readFileSync(localAbsPath, 'utf-8'));
  } catch (e) {
    throw new Error(
      `${labelPrefix(label)}local ${configBasename} is not valid JSON: ${(e as Error).message}`,
    );
  }

  if (!deepEqual(localContent, remoteContent)) {
    throw new Error(
      `${labelPrefix(label)}local ${configBasename} content differs from remote. ` +
      `local=${JSON.stringify(localContent)} remote=${JSON.stringify(remoteContent)}`,
    );
  }

  return { layout: result.layout, localContent };
}

function labelPrefix(label: string | undefined): string {
  return label ? `[${label}] ` : '';
}

/**
 * Structural equality for the JSON value lattice. Order-sensitive on
 * arrays, order-insensitive on object keys.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao).sort();
    const bk = Object.keys(bo).sort();
    if (ak.length !== bk.length) return false;
    return ak.every((k, i) => k === bk[i] && deepEqual(ao[k], bo[k]));
  }
  return false;
}
