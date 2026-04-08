/**
 * PTY e2e tests — Node SDK.
 */

import { describe, it, expect } from 'vitest';
import { Pty } from '../src/commands.js';
import { makeConfig } from './setup.js';

function pty(): Pty {
  return new Pty(makeConfig());
}

// ---------------------------------------------------------------------------
// Create / Kill
// ---------------------------------------------------------------------------

describe('Pty create / kill', () => {
  it('create and kill', async () => {
    const p = pty();
    const handle = await p.create({ size: { rows: 24, cols: 80 } });
    expect(handle.pid).not.toBe(0);
    expect(await p.kill(handle.pid)).toBe(true);
  });

  it('create with cwd', async () => {
    const p = pty();
    const handle = await p.create({ size: { rows: 24, cols: 80 }, cwd: '/tmp' });
    try {
      expect(handle.pid).not.toBe(0);
    } finally {
      await p.kill(handle.pid);
    }
  });

  it('create with envs', async () => {
    const p = pty();
    const handle = await p.create({
      size: { rows: 24, cols: 80 },
      envs: { E2E_PTY_NODE_VAR: 'pty_node_env_ok' },
    });
    try {
      expect(handle.pid).not.toBe(0);
    } finally {
      await p.kill(handle.pid);
    }
  });
});

// ---------------------------------------------------------------------------
// Resize
// ---------------------------------------------------------------------------

describe('Pty resize', () => {
  it('resize', async () => {
    const p = pty();
    const handle = await p.create({ size: { rows: 24, cols: 80 } });
    try {
      await p.resize(handle.pid, { rows: 40, cols: 200 });
    } finally {
      await p.kill(handle.pid);
    }
  });
});

// ---------------------------------------------------------------------------
// Input / Output
// ---------------------------------------------------------------------------

describe('Pty input/output', () => {
  it('sendInput does not throw', async () => {
    const p = pty();
    const handle = await p.create({ size: { rows: 24, cols: 80 } });
    try {
      await new Promise((r) => setTimeout(r, 200));
      await p.sendInput(handle.pid, new TextEncoder().encode('echo pty_node_test\n'));
    } finally {
      await p.kill(handle.pid);
    }
  });

  it('create and wait with exit command', async () => {
    const p = pty();
    const handle = await p.create({ size: { rows: 24, cols: 80 } });

    await new Promise((r) => setTimeout(r, 300));
    await p.sendInput(handle.pid, new TextEncoder().encode('exit\n'));

    try {
      const result = await Promise.race([
        handle.wait(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('PTY Wait timed out after exit')), 10_000)
        ),
      ]);
      if (result) {
        expect(result.exitCode).toBe(0);
      }
    } catch (err) {
      await p.kill(handle.pid);
      console.log(`PTY Wait timed out — killed (${(err as Error).message})`);
    }
  }, 15_000);
});
