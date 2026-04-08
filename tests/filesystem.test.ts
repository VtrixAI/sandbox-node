/**
 * Filesystem e2e tests — Node SDK.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Filesystem } from '../src/filesystem.js';
import { makeConfig, path_ } from './setup.js';

let fs: Filesystem;

beforeAll(() => {
  fs = new Filesystem(makeConfig());
});

// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------

describe('Filesystem read/write', () => {
  it('write and read text', async () => {
    const p = path_('write_read.txt');
    await fs.write(p, 'hello node sdk');
    const got = await fs.read(p);
    expect(got).toBe('hello node sdk');
  });

  it('write bytes and read', async () => {
    const p = path_('bytes.bin');
    const data = new Uint8Array([0x00, 0x01, 0x7f, 0xff, 0xfe]);
    await fs.write(p, data);
    const got = await fs.read(p, { format: 'bytes' });
    expect(got).toEqual(data);
  });

  it('overwrite', async () => {
    const p = path_('overwrite.txt');
    await fs.write(p, 'original');
    await fs.write(p, 'overwritten');
    expect(await fs.read(p)).toBe('overwritten');
  });

  it('write batch', async () => {
    await fs.write([
      { path: path_('batch_a.txt'), data: 'batch file A' },
      { path: path_('batch_b.txt'), data: 'batch file B' },
    ]);
    expect(await fs.read(path_('batch_a.txt'))).toBe('batch file A');
    expect(await fs.read(path_('batch_b.txt'))).toBe('batch file B');
  });
});

// ---------------------------------------------------------------------------
// Directory
// ---------------------------------------------------------------------------

describe('Filesystem directory', () => {
  it('makeDir creates directory', async () => {
    const p = path_('testdir');
    await fs.makeDir(p);
    expect(await fs.exists(p)).toBe(true);
  });

  it('makeDir is idempotent', async () => {
    const p = path_('idempotent_dir');
    await fs.makeDir(p);
    await fs.makeDir(p); // must not throw
  });

  it('list returns entries', async () => {
    await fs.write(path_('list_sentinel.txt'), 'sentinel');
    const entries = await fs.list('/tmp');
    expect(entries.length).toBeGreaterThan(0);
  });

  it('list entry has expected fields', async () => {
    await fs.write(path_('list_fields.txt'), 'list entry fields');
    const entries = await fs.list('/tmp');
    const found = entries.find((e) => e.name === 'e2e_node_list_fields.txt');
    expect(found).toBeDefined();
    expect(found!.path).toBeTruthy();
    expect(found!.size).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Exists / stat
// ---------------------------------------------------------------------------

describe('Filesystem exists / stat', () => {
  it('exists returns true for existing file', async () => {
    const p = path_('exists_true.txt');
    await fs.write(p, 'x');
    expect(await fs.exists(p)).toBe(true);
  });

  it('exists returns false for missing file', async () => {
    expect(await fs.exists('/tmp/node_no_such_file_xyz_9999')).toBe(false);
  });

  it('getInfo returns correct fields', async () => {
    const p = path_('getinfo.txt');
    const content = 'getinfo content';
    await fs.write(p, content);
    const info = await fs.getInfo(p);
    expect(info.name).toBe('e2e_node_getinfo.txt');
    expect(info.size).toBe(content.length);
    expect(info.modifiedTime).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Rename / Remove
// ---------------------------------------------------------------------------

describe('Filesystem rename / remove', () => {
  it('rename moves file', async () => {
    const src = path_('rename_src.txt');
    const dst = path_('rename_dst.txt');
    await fs.write(src, 'rename me');
    try { await fs.remove(dst); } catch { /* ignore */ }
    await fs.rename(src, dst);
    expect(await fs.exists(dst)).toBe(true);
    expect(await fs.exists(src)).toBe(false);
  });

  it('remove file', async () => {
    const p = path_('remove.txt');
    await fs.write(p, 'delete me');
    await fs.remove(p);
    expect(await fs.exists(p)).toBe(false);
  });

  it('remove nonexistent raises', async () => {
    await expect(
      fs.remove('/tmp/node_remove_nonexistent_xyz_99999.txt')
    ).rejects.toThrow();
  });

  it('remove directory', async () => {
    const p = path_('removedir');
    await fs.makeDir(p);
    await fs.remove(p);
    expect(await fs.exists(p)).toBe(false);
  });

  it('read not found raises', async () => {
    await expect(
      fs.read('/tmp/node_definitely_not_exist_xyz.txt')
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

describe('Filesystem edit', () => {
  it('edit basic', async () => {
    const p = path_('edit_basic.txt');
    await fs.write(p, 'hello world');
    await fs.edit(p, 'world', 'node');
    expect(await fs.read(p)).toBe('hello node');
  });

  it('edit not found text raises', async () => {
    const p = path_('edit_notfound.txt');
    await fs.write(p, 'some content');
    await expect(
      fs.edit(p, 'no_such_text_xyz', 'replacement')
    ).rejects.toThrow();
  });

  it('edit non-unique raises', async () => {
    const p = path_('edit_notunique.txt');
    await fs.write(p, 'repeat repeat repeat');
    await expect(
      fs.edit(p, 'repeat', 'once')
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Watch
// ---------------------------------------------------------------------------

describe('Filesystem watch', () => {
  it('watchDir receives events', async () => {
    const watchPath = path_('watch');
    await fs.makeDir(watchPath);

    const events: unknown[] = [];
    const handle = await fs.watchDir(watchPath, (event) => {
      events.push(event);
    });

    await new Promise((r) => setTimeout(r, 200));
    await fs.write(watchPath + '/watched.txt', 'trigger');
    await new Promise((r) => setTimeout(r, 500));

    handle.stop();
    expect(events.length).toBeGreaterThan(0);
  }, 10_000);

  it('watchDir stop prevents further events', async () => {
    const watchPath = path_('watch_stop');
    await fs.makeDir(watchPath);

    let count = 0;
    const handle = await fs.watchDir(watchPath, () => { count++; });

    await new Promise((r) => setTimeout(r, 200));
    await fs.write(watchPath + '/before.txt', 'before');
    await new Promise((r) => setTimeout(r, 400));
    const countBefore = count;
    expect(countBefore).toBeGreaterThan(0);

    handle.stop();
    // drain any in-flight events
    await new Promise((r) => setTimeout(r, 100));
    const countAtStop = count;

    await fs.write(watchPath + '/after.txt', 'after');
    await new Promise((r) => setTimeout(r, 400));

    expect(count).toBe(countAtStop);
  }, 10_000);
});
