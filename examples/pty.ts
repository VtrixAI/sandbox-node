/**
 * pty.ts — PTY（伪终端）操作示例：创建、调整大小、发送输入、等待退出。
 *
 * 运行:
 *   SANDBOX_API_KEY=your-key SANDBOX_BASE_URL=https://api.sandbox.vtrix.ai npx tsx examples/pty.ts
 *
 * 环境变量:
 *   SANDBOX_API_KEY   必填
 *   SANDBOX_BASE_URL  必填，例如 https://api.sandbox.vtrix.ai
 */

import { Sandbox } from '../src/index.js';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const sb = await Sandbox.create({
    apiKey: process.env.SANDBOX_API_KEY,
    baseUrl: process.env.SANDBOX_BASE_URL,
  });

  try {
    // -----------------------------------------------------------------------
    // 1. 创建 PTY（bash shell）
    // -----------------------------------------------------------------------
    const handle = await sb.pty.create({ size: { rows: 24, cols: 80 } });
    console.log(`PTY pid=${handle.pid}`);

    // -----------------------------------------------------------------------
    // 1b. 自定义环境变量和工作目录
    // -----------------------------------------------------------------------
    const handle2 = await sb.pty.create({
      size: { rows: 24, cols: 80 },
      envs: { TERM: 'xterm-256color' },
      cwd: '/tmp',
    });
    console.log(`custom PTY pid=${handle2.pid}`);
    await sleep(100);
    await sb.pty.kill(handle2.pid);

    // -----------------------------------------------------------------------
    // 2. 调整终端大小
    // -----------------------------------------------------------------------
    await sb.pty.resize(handle.pid, { rows: 40, cols: 200 });
    console.log('resized to 40x200');

    // -----------------------------------------------------------------------
    // 3. 发送输入（模拟在终端中打字）
    // -----------------------------------------------------------------------
    await sleep(300);
    await sb.pty.sendInput(handle.pid, new TextEncoder().encode("echo 'hello from pty'\n"));
    await sleep(300);

    // -----------------------------------------------------------------------
    // 4. 退出 shell，等待 PTY 关闭
    // -----------------------------------------------------------------------
    await sb.pty.sendInput(handle.pid, new TextEncoder().encode('exit\n'));

    try {
      const result = await Promise.race([
        handle.wait({ onStdout: (d) => process.stdout.write(d) }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('PTY wait timeout')), 10_000)
        ),
      ]);
      if (result) {
        console.log(`\nPTY exited with code ${result.exitCode}`);
      }
    } catch (err) {
      await sb.pty.kill(handle.pid);
      console.log(`PTY killed: ${(err as Error).message}`);
    }

    console.log('done.');
  } finally {
    await sb.kill();
  }
}

main().catch(console.error);
