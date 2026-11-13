import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { containedShadowFile } from '../src/adapter/shadowContainment';

describe('containedShadowFile', () => {
  it('rejects a sibling whose name only shares the vault prefix', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-prefix-'));
    const root = path.join(parent, 'vault');
    fs.mkdirSync(root);
    try {
      const rel = `../${path.basename(root)}-evil/note.md`;
      expect(containedShadowFile(root, rel, fs)).toBeNull();
      expect(path.resolve(root, rel).startsWith(root), 'the fixture must be a prefix sibling, not an unrelated path').toBe(true);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('allows a symlink ancestor whose real path stays inside the vault', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-alias-'));
    try {
      fs.mkdirSync(path.join(root, 'real'));
      fs.symlinkSync(path.join(root, 'real'), path.join(root, 'alias'));
      expect(containedShadowFile(root, 'alias/note.md', fs)).toBe(path.resolve(root, 'alias', 'note.md'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
