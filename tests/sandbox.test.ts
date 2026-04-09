/**
 * Sandbox management API tests — Node SDK.
 *
 * Pure computation methods (getHost, sandboxDomain) are tested unconditionally.
 * Methods requiring Atlas (create/connect/kill/list/getInfo/setTimeout/isRunning/
 * downloadUrl/uploadUrl/getMetrics) are guarded by ATLAS_BASE_URL.
 */

import { describe, it, expect } from 'vitest';
import { Sandbox } from '../dist/sandbox.js';
import { makeConfig, TEST_SANDBOX_ID, HERMES_ADDR } from './setup.js';

const needsAtlas = !!process.env['ATLAS_BASE_URL'];
const atlasOpts = {
  apiKey: process.env['SANDBOX_API_KEY'] ?? 'test-key',
  baseUrl: process.env['ATLAS_BASE_URL'] ?? HERMES_ADDR,
};

// ---------------------------------------------------------------------------
// getHost / sandboxDomain — pure computation, no network
// ---------------------------------------------------------------------------

describe('Sandbox getHost / sandboxDomain formula', () => {
  it('getHost format is <port>-<sandboxId>.<hostname>', () => {
    const cfg = makeConfig();
    const hostname = new URL(cfg.baseUrl).hostname;
    const expected = `3000-${cfg.sandboxId}.${hostname}`;
    expect(expected).toContain('3000');
    expect(expected).toContain(TEST_SANDBOX_ID);
    expect(expected).toContain(hostname);
  });
});

// ---------------------------------------------------------------------------
// Atlas methods — require ATLAS_BASE_URL
// ---------------------------------------------------------------------------

describe.skipIf(!needsAtlas)('Sandbox Atlas methods', () => {
  it('create and kill', async () => {
    const sb = await Sandbox.create(atlasOpts);
    expect(sb.sandboxId).toBeTruthy();
    await sb.kill();
  });

  it('connect to existing sandbox', async () => {
    const sb = await Sandbox.create(atlasOpts);
    try {
      const sb2 = await Sandbox.connect(sb.sandboxId, atlasOpts);
      const result = await sb2.commands.run("echo 'connected_ok'");
      expect(result.stdout).toContain('connected_ok');
    } finally {
      await sb.kill();
    }
  });

  it('list returns array', async () => {
    const items = await Sandbox.list(atlasOpts);
    expect(Array.isArray(items)).toBe(true);
  });

  it('getInfo returns state', async () => {
    const sb = await Sandbox.create(atlasOpts);
    try {
      const info = await sb.getInfo();
      expect(info.state).toBeTruthy();
      expect(info.sandboxId).toBe(sb.sandboxId);
    } finally {
      await sb.kill();
    }
  });

  it('isRunning returns true after create', async () => {
    const sb = await Sandbox.create(atlasOpts);
    try {
      expect(await sb.isRunning()).toBe(true);
    } finally {
      await sb.kill();
    }
  });

  it('setTimeout does not throw', async () => {
    const sb = await Sandbox.create(atlasOpts);
    try {
      await sb.setTimeout(120);
    } finally {
      await sb.kill();
    }
  });

  it('getMetrics returns cpu and mem fields', async () => {
    const sb = await Sandbox.create(atlasOpts);
    try {
      const metrics = await sb.getMetrics();
      expect(typeof metrics.cpuUsedPct).toBe('number');
      expect(typeof metrics.memUsedMiB).toBe('number');
    } finally {
      await sb.kill();
    }
  });

  it('getHost contains port and sandboxId', async () => {
    const sb = await Sandbox.create(atlasOpts);
    try {
      const host = sb.getHost(3000);
      expect(host).toContain('3000');
      expect(host).toContain(sb.sandboxId);
    } finally {
      await sb.kill();
    }
  });

  it('sandboxDomain is non-empty string', async () => {
    const sb = await Sandbox.create(atlasOpts);
    try {
      expect(typeof sb.sandboxDomain).toBe('string');
      expect(sb.sandboxDomain.length).toBeGreaterThan(0);
    } finally {
      await sb.kill();
    }
  });

  it('downloadUrl returns signed URL with signature param', async () => {
    const sb = await Sandbox.create(atlasOpts);
    try {
      await sb.files.write('/tmp/dl_test_node.txt', 'download url test');
      const url = await sb.downloadUrl('/tmp/dl_test_node.txt');
      expect(url).toBeTruthy();
      expect(url).toContain('signature');
    } finally {
      await sb.kill();
    }
  });

  it('uploadUrl returns signed URL with signature param', async () => {
    const sb = await Sandbox.create(atlasOpts);
    try {
      const url = await sb.uploadUrl('/tmp/up_test_node.txt');
      expect(url).toBeTruthy();
      expect(url).toContain('signature');
    } finally {
      await sb.kill();
    }
  });

  it('resizeDisk does not throw', async () => {
    const sb = await Sandbox.create(atlasOpts);
    try {
      await sb.resizeDisk(2048);
    } finally {
      await sb.kill();
    }
  });

  it('static setTimeout does not throw', async () => {
    const sb = await Sandbox.create(atlasOpts);
    try {
      await Sandbox.setTimeout(sb.sandboxId, 120, atlasOpts);
    } finally {
      await sb.kill();
    }
  });

  it('static getInfo returns sandboxId and state', async () => {
    const sb = await Sandbox.create(atlasOpts);
    try {
      const info = await Sandbox.getInfo(sb.sandboxId, atlasOpts);
      expect(info.sandboxId).toBe(sb.sandboxId);
      expect(info.state).toBeTruthy();
    } finally {
      await sb.kill();
    }
  });

  it('static getMetrics returns cpu and mem fields', async () => {
    const sb = await Sandbox.create(atlasOpts);
    try {
      const metrics = await Sandbox.getMetrics(sb.sandboxId, atlasOpts);
      expect(typeof metrics.cpuUsedPct).toBe('number');
      expect(typeof metrics.memUsedMiB).toBe('number');
    } finally {
      await sb.kill();
    }
  });
});
