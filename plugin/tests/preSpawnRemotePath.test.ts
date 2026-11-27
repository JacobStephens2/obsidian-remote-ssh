import { describe, it, expect } from 'vitest';
import { PathMapper } from '../src/path/PathMapper';
import { preSpawnRemotePath } from '../src/shadow/preSpawnPaths';

/**
 * Pins the #450 CRITICAL fix: the pre-spawn config pull must resolve the
 * four per-device config files to THIS client's `user/<id>/` subtree, not
 * the dead shared identity path (reading which clobbered per-device config
 * on every shadow-window spawn). A regression that dropped the
 * `PathMapper.toRemote` redirect (bare base-join) would flip the config
 * assertions below to the shared path and fail here.
 */
describe('preSpawnRemotePath', () => {
  const mapper = new PathMapper('host-a', '.obsidian');
  const base = '/home/u/vault';

  it('redirects the four per-device config files to the per-client subtree', () => {
    for (const f of ['app.json', 'appearance.json', 'core-plugins.json', 'hotkeys.json']) {
      expect(preSpawnRemotePath(mapper, base, `.obsidian/${f}`))
        .toBe(`${base}/.obsidian/user/host-a/${f}`);
    }
  });

  it('leaves shared files (community-plugins.json, plugin binaries) at the identity path', () => {
    expect(preSpawnRemotePath(mapper, base, '.obsidian/community-plugins.json'))
      .toBe(`${base}/.obsidian/community-plugins.json`);
    expect(preSpawnRemotePath(mapper, base, '.obsidian/plugins/dataview/main.js'))
      .toBe(`${base}/.obsidian/plugins/dataview/main.js`);
  });

  it('joins onto a "." remote base (vault root) without a leading slash', () => {
    expect(preSpawnRemotePath(mapper, '.', '.obsidian/app.json'))
      .toBe('.obsidian/user/host-a/app.json');
  });

  it('isolates clients — two client ids never resolve to the same config path', () => {
    const a = new PathMapper('host-a', '.obsidian');
    const b = new PathMapper('host-b', '.obsidian');
    expect(preSpawnRemotePath(a, base, '.obsidian/app.json'))
      .not.toBe(preSpawnRemotePath(b, base, '.obsidian/app.json'));
  });

  it('maps settings under the active custom config directory', () => {
    const custom = new PathMapper('host-a', '.obsidian-work');
    expect(preSpawnRemotePath(custom, base, '.obsidian-work/app.json'))
      .toBe(`${base}/.obsidian-work/user/host-a/app.json`);
  });
});
