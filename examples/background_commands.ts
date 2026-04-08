/**
 * background_commands.ts — 后台进程、流式输出、stdin、信号示例。
 *
 * 运行:
 *   SANDBOX_API_KEY=your-key SANDBOX_BASE_URL=https://api.sandbox.vtrix.ai npx tsx examples/background_commands.ts
 *
 * 环境变量:
 *   SANDBOX_API_KEY   必填
 *   SANDBOX_BASE_URL  必填，例如 https://api.sandbox.vtrix.ai
 */

import { Sandbox } from '../src/index.js';
import { CommandExitError } from '../src/index.js';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const sb = await Sandbox.create({ apiKey: process.env.SANDBOX_API_KEY });

  try {
    // -----------------------------------------------------------------------
    // 1. 后台运行并等待结果（流式 stdout）
    // -----------------------------------------------------------------------
    const handle = await sb.commands.run(
      'for i in 1 2 3; do echo line$i; sleep 0.3; done',
      { background: true }
    );
    console.log(`started pid=${handle.pid}`);

    try {
      const result = await handle.wait({
        onStdout: (line) => process.stdout.write(`[stdout] ${line}`),
        onStderr: (line) => process.stderr.write(`[stderr] ${line}`),
      });
      console.log(`finished. exit_code=${result.exitCode}`);
    } catch (e) {
      if (e instanceof CommandExitError) {
        console.log(`exited with code ${e.exitCode}`);
      } else {
        throw e;
      }
    }

    // -----------------------------------------------------------------------
    // 2. 向运行中的进程发送 stdin
    // -----------------------------------------------------------------------
    const cat = await sb.commands.run('cat', { background: true });
    await sleep(200);
    await sb.commands.sendStdin(cat.pid, 'hello stdin\n');
    await sb.commands.closeStdin(cat.pid);

    const catResult = await cat.wait().catch((e) => e);
    const stdout = catResult instanceof CommandExitError ? catResult.stdout : catResult?.stdout ?? '';
    console.log(`cat echoed: ${JSON.stringify(stdout)}`);

    // -----------------------------------------------------------------------
    // 3. 发送信号（SIGTERM / SIGINT / SIGHUP）
    // -----------------------------------------------------------------------
    const sleeper = await sb.commands.run('sleep 60', { background: true });
    await sleep(200);
    await sb.commands.sendSignal(sleeper.pid, 'SIGTERM');

    await Promise.race([
      sleeper.wait().catch(() => {}),
      sleep(5000),
    ]);
    console.log('sleep process terminated via SIGTERM');

    // SIGINT — interrupt (Ctrl-C 等价)
    const sleeper2 = await sb.commands.run('sleep 60', { background: true });
    await sleep(100);
    await sb.commands.sendSignal(sleeper2.pid, 'SIGINT');
    await Promise.race([sleeper2.wait().catch(() => {}), sleep(5000)]);
    console.log('sleep process interrupted via SIGINT');

    // SIGHUP — hangup / 配置重载
    const sleeper3 = await sb.commands.run('sleep 60', { background: true });
    await sleep(100);
    await sb.commands.sendSignal(sleeper3.pid, 'SIGHUP');
    await Promise.race([sleeper3.wait().catch(() => {}), sleep(5000)]);
    console.log('sleep process received SIGHUP');

    // -----------------------------------------------------------------------
    // 4. Disconnect（后台进程保持运行）
    // -----------------------------------------------------------------------
    const bg = await sb.commands.run('sleep 30', { background: true });
    const pid = bg.pid;
    bg.disconnect();

    await sleep(200);
    const ok = await sb.commands.kill(pid);
    console.log(`kill after disconnect: ${ok}`);

    console.log('done.');
  } finally {
    await sb.kill();
  }
}

main().catch(console.error);
