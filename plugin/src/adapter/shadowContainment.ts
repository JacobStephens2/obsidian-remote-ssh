import * as path from 'path';
import type { PhysicalFs } from './PhysicalFs';

/**
 * Absolute path of a file `rel` may be materialised at, or null when
 * that write would leave the shadow vault.
 *
 * `path.join(root, rel)` is not containment. An absolute `rel` discards
 * `root`, and `..` walks out of it — both land the cache write on
 * whatever path the remote (or a caller) supplied. The same write also
 * follows a symlink, so a link planted inside the vault redirects
 * `mkdir` / `writeFile` outside even after the lexical path looks safe.
 * `writeFileSync` follows the final component too.
 *
 * Symlink ancestors are judged by realpath: a link that stays inside
 * the vault is still this vault; one that doesn't is a refusal. A
 * symlink at the file itself is always refused, because following it
 * overwrites the link target rather than the vault path.
 */
export function containedShadowFile(
  root: string,
  rel: string,
  physical: Pick<PhysicalFs, 'lstatSync' | 'realpathSync'>,
): string | null {
  if (!root) return null;
  let resolvedRoot: string;
  let candidate: string;
  try {
    resolvedRoot = path.resolve(root);
    candidate = path.resolve(resolvedRoot, rel);
  } catch {
    return null;
  }
  // The cache writes a file. The vault directory itself is not one,
  // and a sibling such as `<root>-evil` must not pass a prefix check
  // that forgot the separator.
  if (candidate === resolvedRoot || !candidate.startsWith(resolvedRoot + path.sep)) {
    return null;
  }
  const targetStat = lstatOf(physical, candidate);
  if (targetStat === null || targetStat?.isSymbolicLink()) return null;

  // Deepest existing ancestor. Anything missing gets created by the
  // write, but only if that ancestor's real path is still the vault.
  let cursor = path.dirname(candidate);
  while (cursor !== resolvedRoot) {
    const stat = lstatOf(physical, cursor);
    if (stat === null) return null;
    if (stat) break;
    const parent = path.dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
  let realAncestor: string;
  let realRoot: string;
  try {
    realAncestor = physical.realpathSync(cursor);
    realRoot = physical.realpathSync(resolvedRoot);
  } catch {
    return null;
  }
  if (realAncestor !== realRoot && !realAncestor.startsWith(realRoot + path.sep)) {
    return null;
  }
  return candidate;
}

/**
 * `undefined` is "no such path". `null` is "could not look", which the
 * caller treats as a refusal — a failed stat must not become a write.
 */
function lstatOf(
  physical: Pick<PhysicalFs, 'lstatSync'>,
  target: string,
): ReturnType<PhysicalFs['lstatSync']> | undefined | null {
  try {
    return physical.lstatSync(target, { throwIfNoEntry: false }) ?? undefined;
  } catch {
    return null;
  }
}
