/**
 * E2E test setup for the Node SDK.
 *
 * Architecture:
 *   Test → SDK → http://localhost:8080/api/v1/sandboxes/<id>/exec/<rpc>
 *                ↓  (hermes strips /exec, proxies to 127.0.0.1:9000)
 *                http://127.0.0.1:9000/<rpc>  (nano-executor)
 *
 * Environment variables:
 *   NANO_EXECUTOR_BIN  – path to nano-executor binary
 *   HERMES_DIR         – path to hermes repo root
 *   SKIP_START         – set to "1" to skip subprocess management
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConnectionConfig } from '../src/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const HERMES_ADDR = 'http://localhost:8080';
export const NANO_ADDR = 'http://localhost:9000';
export const TEST_SANDBOX_ID = 'e2e-test-sandbox';
export const STARTUP_TIMEOUT_MS = 45_000;

// ---------------------------------------------------------------------------
// SDK connection config factory
// ---------------------------------------------------------------------------

export function makeConfig(): ConnectionConfig {
  const envdUrl = `${HERMES_ADDR}/api/v1/sandboxes/${TEST_SANDBOX_ID}/exec`;
  return {
    sandboxId: TEST_SANDBOX_ID,
    envdUrl,
    accessToken: undefined,
    apiKey: 'test-key',
    baseUrl: HERMES_ADDR,
    requestTimeoutMs: 30_000,
  };
}

// ---------------------------------------------------------------------------
// Path helper for test isolation
// ---------------------------------------------------------------------------

export function path_(name: string): string {
  return `/tmp/e2e_node_${name}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function repoRoot(): string {
  const hermes = process.env['HERMES_DIR'];
  if (hermes) return hermes;
  // This file is at sdk/node/tests/setup.ts; repo root is 3 levels up.
  const here = fileURLToPath(new URL('.', import.meta.url));
  return path.resolve(here, '..', '..', '..');
}

async function waitReady(url: string, name: string, timeoutMs = STARTUP_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.status < 500) {
        console.log(`[e2e] ${name} ready (HTTP ${res.status})`);
        return;
      }
    } catch {
      // not yet ready
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  console.error(`[e2e] FATAL: ${name} not ready within ${timeoutMs}ms`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Process management
// ---------------------------------------------------------------------------

const _procs: ChildProcess[] = [];

function startNanoExecutor(): ChildProcess {
  let bin = process.env['NANO_EXECUTOR_BIN'];
  if (!bin) {
    bin = path.resolve(repoRoot(), '..', 'nano-executor', 'target', 'release', 'nano-executor');
  }
  if (!existsSync(bin)) {
    console.error(`[e2e] SKIP: nano-executor binary not found at ${bin}`);
    console.error('[e2e] Build it with: cd ../nano-executor && cargo build --release');
    process.exit(1);
  }
  const proc = spawn(bin, ['serve'], { stdio: 'inherit' });
  console.log(`[e2e] started nano-executor pid=${proc.pid}`);
  return proc;
}

function startHermes(): ChildProcess {
  const root = repoRoot();
  const bin = path.join(process.env['TMPDIR'] ?? '/tmp', 'hermes-e2e-test');

  const build = spawnSync('go', ['build', '-o', bin, '.'], {
    cwd: root,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (build.status !== 0) {
    console.error('[e2e] failed to build hermes');
    process.exit(1);
  }

  const proc = spawn(bin, [], {
    cwd: root,
    env: { ...process.env, APP_ENV: 'local' },
    stdio: 'inherit',
  });
  console.log(`[e2e] started hermes pid=${proc.pid}`);
  return proc;
}

function stopAll(): void {
  for (const proc of _procs) {
    try { proc.kill('SIGKILL'); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Vitest global setup / teardown
// ---------------------------------------------------------------------------

export async function setup(): Promise<void> {
  if (process.env['SKIP_START'] !== '1') {
    _procs.push(startNanoExecutor());
    _procs.push(startHermes());
  }

  await waitReady(`${NANO_ADDR}/health`, 'nano-executor');
  await waitReady(`${HERMES_ADDR}/health`, 'hermes');
}

export async function teardown(): Promise<void> {
  if (process.env['SKIP_START'] !== '1') {
    stopAll();
  }
}
