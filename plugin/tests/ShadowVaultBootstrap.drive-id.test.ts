import { describe, expect, it, vi } from 'vitest';
import type { ConfigReader } from '../src/shadow/ShadowVaultBootstrap';

// Windows `path.resolve(root, id)` re-parses a second argument. The id
// `C:remote-ssh` is drive-relative on the same drive as `root` and
// resolves to `<plugins>\remote-ssh`, so a pull would overwrite that
// other plugin. POSIX `path.resolve` does not do this; the mock makes
// this process take the Windows path implementation.
vi.mock('path', async () => {
  const actual = await vi.importActual<typeof import('node:path')>('node:path');
  return {
    ...actual.win32,
    win32: actual.win32,
    posix: actual.posix,
  };
});

// ESM namespace exports are not configurable, so record writes with a
// module mock instead of vi.spyOn. Read/stat stay real.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const note = (p: unknown) => {
    const bag = (globalThis as { __driveIdTouched?: string[] }).__driveIdTouched;
    bag?.push(String(p));
  };
  return {
    ...actual,
    mkdirSync: (p: unknown) => {
      note(p);
    },
    writeFileSync: (p: unknown) => {
      note(p);
    },
    renameSync: (from: unknown, to: unknown) => {
      note(from);
      note(to);
    },
    unlinkSync: () => undefined,
  };
});

import { ShadowVaultBootstrap } from '../src/shadow/ShadowVaultBootstrap';

describe('pullPluginBinaries drive-relative plugin id', () => {
  it('does not write a drive-relative id onto another plugin directory', async () => {
    const cfg = 'C:\\Users\\me\\vault\\.obsidian';
    const id = 'C:remote-ssh';
    const touched: string[] = [];
    (globalThis as { __driveIdTouched?: string[] }).__driveIdTouched = touched;

    const reader: ConfigReader = {
      exists: () => Promise.resolve(true),
      read: (p) => Promise.resolve(
        p.endsWith('manifest.json')
          ? JSON.stringify({ id: 'remote-ssh', version: '9.0.0' })
          : '/* pwned */\n',
      ),
    };

    await ShadowVaultBootstrap.pullPluginBinaries(reader, '.obsidian', cfg, [id]);

    const ontoOtherPlugin = touched.filter((p) => {
      const norm = p.replace(/\//g, '\\');
      return norm.includes('\\plugins\\remote-ssh\\')
        && !norm.includes('\\plugins\\C:remote-ssh\\');
    });
    expect(
      ontoOtherPlugin,
      `drive-relative id must not resolve onto plugins\\remote-ssh; saw ${touched.join(' | ')}`,
    ).toEqual([]);
  });
});
