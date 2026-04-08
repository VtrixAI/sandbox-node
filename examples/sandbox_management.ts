/**
 * sandbox_management.ts — 沙箱生命周期管理示例：
 * Connect、List、setTimeout、getInfo、isRunning、getHost、getMetrics。
 *
 * 运行:
 *   SANDBOX_API_KEY=your-key SANDBOX_BASE_URL=https://api.sandbox.vtrix.ai npx tsx examples/sandbox_management.ts
 *
 * 环境变量:
 *   SANDBOX_API_KEY   必填
 *   SANDBOX_BASE_URL  必填，例如 https://api.sandbox.vtrix.ai
 */

import { Sandbox } from '../src/index.js';

async function main() {
  const opts = {
    apiKey: process.env.SANDBOX_API_KEY,
    baseUrl: process.env.SANDBOX_BASE_URL,
    timeout: 120,
  };

  // -------------------------------------------------------------------------
  // 1. 列出已有沙箱
  // -------------------------------------------------------------------------
  const infos = await Sandbox.list(opts);
  console.log(`existing sandboxes: ${infos.length}`);

  // -------------------------------------------------------------------------
  // 2. 创建沙箱
  // -------------------------------------------------------------------------
  const sb = await Sandbox.create(opts);
  console.log(`created: ${sb.sandboxId}`);

  try {
    // -----------------------------------------------------------------------
    // 3. getInfo / isRunning
    // -----------------------------------------------------------------------
    const info = await sb.getInfo();
    console.log(`state: ${info.state}  running: ${await sb.isRunning()}`);

    // -----------------------------------------------------------------------
    // 4. setTimeout — 延长生命周期
    // -----------------------------------------------------------------------
    try {
      await sb.setTimeout(300);
      console.log('timeout extended to 300s');
    } catch (e) {
      console.log(`setTimeout not supported: ${e}`);
    }

    // -----------------------------------------------------------------------
    // 5. getHost — 沙箱内端口的代理地址
    // -----------------------------------------------------------------------
    const host = sb.getHost(8080);
    console.log(`proxy host for port 8080: ${host}`);

    // -----------------------------------------------------------------------
    // 6. getMetrics — 当前 CPU / 内存占用
    // -----------------------------------------------------------------------
    try {
      const metrics = await sb.getMetrics();
      console.log(`cpu=${metrics.cpuUsedPct.toFixed(2)}%  mem=${metrics.memUsedMiB.toFixed(2)}MiB`);
    } catch (e) {
      console.log(`getMetrics not supported: ${e}`);
    }

    // -----------------------------------------------------------------------
    // 7. Sandbox.connect — 通过 ID 重新连接到已有沙箱
    // -----------------------------------------------------------------------
    const sb2 = await Sandbox.connect(sb.sandboxId, opts);
    const result = await sb2.commands.run("echo 'reconnected'");
    console.log(`reconnected stdout: ${result.stdout.trim()}`);
    await sb2.kill();

    console.log('done.');
  } finally {
    await sb.kill().catch(() => {});
  }
}

main().catch(console.error);
