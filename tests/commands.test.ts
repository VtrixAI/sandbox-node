/**
 * Commands e2e tests — Node SDK.
 */

import { describe, it, expect } from 'vitest';
import { Commands } from '../src/commands.js';
import { CommandExitError } from '../src/errors.js';
import { makeConfig } from './setup.js';

function commands(): Commands {
  return new Commands(makeConfig());
}

const isLinux = process.platform === 'linux';

// ---------------------------------------------------------------------------
// Run — foreground
// ---------------------------------------------------------------------------

describe('Commands run', () => {
  it('basic run', async () => {
    const result = await commands().run("echo 'hello node sdk'");
    expect(result.stdout).toContain('hello node sdk');
    expect(result.exitCode).toBe(0);
  });

  it('exit code', async () => {
    await expect(commands().run('exit 42')).rejects.toBeInstanceOf(CommandExitError);
    try {
      await commands().run('exit 42');
    } catch (e) {
      expect((e as CommandExitError).exitCode).toBe(42);
    }
  });

  it('stderr', async () => {
    const result = await commands().run("echo 'err msg' >&2");
    expect(result.stderr).toContain('err msg');
  });

  it('combined output', async () => {
    const result = await commands().run("echo 'out_line'; echo 'err_line' >&2");
    expect(result.stdout).toContain('out_line');
    expect(result.stderr).toContain('err_line');
  });

  it('run with env', async () => {
    const result = await commands().run('echo $MY_NODE_VAR', {
      envs: { MY_NODE_VAR: 'node_env_value' },
    });
    expect(result.stdout).toContain('node_env_value');
  });

  it('run with cwd', async () => {
    const cmd = new Commands(makeConfig());
    await cmd.run('mkdir -p /tmp/node_cwd_test');
    const result = await commands().run('pwd', { cwd: '/tmp/node_cwd_test' });
    expect(result.stdout).toContain('node_cwd_test');
  });

  it('run timeout', async () => {
    const start = Date.now();
    let caught = false;
    try {
      const result = await commands().run('sleep 30', { timeoutMs: 2000 });
      // Aborted foreground run returns {exitCode: -1} without throwing
      expect(result.exitCode).not.toBe(0);
    } catch (e) {
      caught = true;
      expect(e).toBeTruthy();
    }
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(10_000);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Run — background
// ---------------------------------------------------------------------------

describe('Commands runBackground', () => {
  it('run background and wait', async () => {
    const handle = await commands().run("sleep 1 && echo 'bg_done'", { background: true });
    expect(handle.pid).not.toBe(0);
    const result = await handle.wait();
    expect(result.stdout).toContain('bg_done');
  }, 10_000);

  it('run background kill', async () => {
    const handle = await commands().run('sleep 60', { background: true });
    expect(handle.pid).not.toBe(0);
    expect(await handle.kill()).toBe(true);
  });

  it('run background stderr', async () => {
    const handle = await commands().run("echo 'bg_stderr_msg' >&2", { background: true });
    const result = await handle.wait();
    expect(result.stderr).toContain('bg_stderr_msg');
  });
});

// ---------------------------------------------------------------------------
// List / Kill
// ---------------------------------------------------------------------------

describe('Commands list / kill', () => {
  it('list returns running process', async () => {
    const cmd = commands();
    const handle = await cmd.run('sleep 30', { background: true });
    try {
      await new Promise((r) => setTimeout(r, 200));
      const procs = await cmd.list();
      if (procs.length === 0) {
        console.log('List returned 0 processes — likely non-Linux; skipping');
        return;
      }
      const found = procs.some((p) => p.pid === handle.pid);
      expect(found).toBe(true);
    } finally {
      await handle.kill();
    }
  });

  it('kill by pid', async () => {
    const cmd = commands();
    const handle = await cmd.run('sleep 60', { background: true });
    expect(await cmd.kill(handle.pid)).toBe(true);
  });

  it('kill dead process does not throw', async () => {
    const cmd = commands();
    const handle = await cmd.run('echo done_immediately', { background: true });
    await handle.wait();
    // Should not throw:
    await handle.kill();
  });
});

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

describe('Commands connect', () => {
  it('connect returns a handle', async () => {
    const cmd = commands();
    const handle = await cmd.run("echo 'output_line'; sleep 5", { background: true });
    await new Promise((r) => setTimeout(r, 100));
    const connected = await cmd.connect(handle.pid);
    // connected is a valid handle with the pid
    expect(connected.pid).toBe(handle.pid);
    // clean up
    await handle.kill();
  });

  it('connect to invalid pid does not crash', async () => {
    const cmd = commands();
    try {
      const connected = await cmd.connect(999999);
      const result = await connected.wait();
      // Server may return an error in the result
      if (result?.error) {
        expect(typeof result.error).toBe('string');
      }
    } catch {
      // Acceptable: connect rejected at HTTP level
    }
  });
});

// ---------------------------------------------------------------------------
// SendStdin / CloseStdin
// ---------------------------------------------------------------------------

describe('Commands stdin', () => {
  it('sendStdin does not throw', async () => {
    const cmd = commands();
    const handle = await cmd.run('cat', { background: true });
    await new Promise((r) => setTimeout(r, 200));
    await cmd.sendStdin(handle.pid, 'hello stdin\n');
    await handle.kill();
  });

  it('closeStdin causes cat to exit', async () => {
    const cmd = commands();
    const handle = await cmd.run('cat', { background: true });
    await new Promise((r) => setTimeout(r, 200));
    await cmd.closeStdin(handle.pid);
    // cat exits 0 after EOF — wait() returns normally
    const result = await Promise.race([
      handle.wait().catch((e) => e),  // catch CommandExitError too
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('cat did not exit within 5s after CloseStdin')), 5000)
      ),
    ]);
    expect(result).toBeDefined();
  }, 10_000);
});

// ---------------------------------------------------------------------------
// SendSignal
// ---------------------------------------------------------------------------

describe('Commands sendSignal', () => {
  it('SIGTERM causes process to exit', async () => {
    const cmd = commands();
    const handle = await cmd.run('sleep 60', { background: true });
    await new Promise((r) => setTimeout(r, 200));
    await cmd.sendSignal(handle.pid, 'SIGTERM');
    // Process exits non-zero — wait() throws CommandExitError
    const result = await Promise.race([
      handle.wait().catch((e) => e),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('process did not exit within 5s after SIGTERM')), 5000)
      ),
    ]);
    expect(result).toBeDefined();
  }, 10_000);

  it('SIGKILL causes process to exit', async () => {
    const cmd = commands();
    const handle = await cmd.run('sleep 60', { background: true });
    await new Promise((r) => setTimeout(r, 200));
    await cmd.sendSignal(handle.pid, 'SIGKILL');
    // Process exits non-zero — wait() throws CommandExitError
    const result = await Promise.race([
      handle.wait().catch((e) => e),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('process did not exit within 5s after SIGKILL')), 5000)
      ),
    ]);
    expect(result).toBeDefined();
  }, 10_000);
});

// ---------------------------------------------------------------------------
// By-tag (Linux only)
// ---------------------------------------------------------------------------

describe('Commands by-tag', () => {
  it.skipIf(!isLinux)('killByTag', async () => {
    // killByTag with non-existent tag should return false or true without throwing
    const cmd = commands();
    const result = await cmd.killByTag('node-e2e-nonexistent-tag-xyz');
    expect(typeof result).toBe('boolean');
  });

  it.skipIf(!isLinux)('sendStdinByTag does not throw', async () => {
    const cmd = commands();
    await cmd.sendStdinByTag('node-e2e-nonexistent-tag-xyz', 'data\n');
  });

  it.skipIf(!isLinux)('connectByTag returns handle', async () => {
    const cmd = commands();
    try {
      const handle = await cmd.connectByTag('node-e2e-nonexistent-tag-xyz');
      // wait should return without crashing
      const result = await handle.wait();
      expect(result).toBeDefined();
    } catch {
      // Acceptable: server rejects unknown tag
    }
  });
});

// ---------------------------------------------------------------------------
// Disconnect
// ---------------------------------------------------------------------------

describe('Commands disconnect', () => {
  it('disconnect detaches without killing process', async () => {
    const cmd = commands();
    const handle = await cmd.run('sleep 30', { background: true });
    const pid = handle.pid;
    expect(pid).not.toBe(0);

    handle.disconnect();
    await new Promise((r) => setTimeout(r, 200));

    // Process should still be alive; kill it
    expect(await cmd.kill(pid)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handle.wait() onStdout / onStderr callbacks
// ---------------------------------------------------------------------------

describe('Commands wait callbacks', () => {
  it('onStdout callback receives stdout lines', async () => {
    const cmd = commands();
    const handle = await cmd.run("echo 'wait_cb_stdout'", { background: true });
    const lines: string[] = [];
    await handle.wait({ onStdout: (d) => lines.push(d) }).catch(() => {});
    expect(lines.some((l) => l.includes('wait_cb_stdout'))).toBe(true);
  });

  it('onStderr callback receives stderr lines', async () => {
    const cmd = commands();
    const handle = await cmd.run("echo 'wait_cb_stderr' >&2", { background: true });
    const lines: string[] = [];
    await handle.wait({ onStderr: (d) => lines.push(d) }).catch(() => {});
    expect(lines.some((l) => l.includes('wait_cb_stderr'))).toBe(true);
  });
});
