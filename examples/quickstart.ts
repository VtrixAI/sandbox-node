/**
 * quickstart.ts — Sandbox SDK 最基础用法示例。
 *
 * 运行:
 *   SANDBOX_API_KEY=your-key SANDBOX_BASE_URL=https://api.sandbox.vtrix.ai npx tsx examples/quickstart.ts
 *
 * 环境变量:
 *   SANDBOX_API_KEY   必填
 *   SANDBOX_BASE_URL  必填，例如 https://api.sandbox.vtrix.ai
 */

import { Sandbox } from '../src/index.js';
import { CommandExitError } from '../src/index.js';

async function main() {
  // -------------------------------------------------------------------------
  // 1. 创建沙箱（带 metadata 和自定义环境变量）
  // -------------------------------------------------------------------------
  const sb = await Sandbox.create({
    apiKey: process.env.SANDBOX_API_KEY,
    baseUrl: process.env.SANDBOX_BASE_URL,
    template: 'base',
    timeout: 300, // 秒，超时后自动销毁
    metadata: { owner: 'quickstart-example' },
    envs: { APP_ENV: 'demo' },
  });
  console.log(`Sandbox created: ${sb.sandboxId}`);

  try {
    // -----------------------------------------------------------------------
    // 2. 运行命令并获取输出
    // -----------------------------------------------------------------------
    const result = await sb.commands.run("echo 'hello from sandbox'");
    console.log(`stdout: ${result.stdout.trim()}`);

    // -----------------------------------------------------------------------
    // 3. 带环境变量和工作目录运行
    // -----------------------------------------------------------------------
    const r2 = await sb.commands.run('echo $MY_VAR && pwd', {
      envs: { MY_VAR: 'hello' },
      cwd: '/tmp',
      timeoutMs: 10_000,
    });
    console.log(`env+cwd:\n${r2.stdout.trim()}`);

    // -----------------------------------------------------------------------
    // 4. 写入 / 读取文件
    // -----------------------------------------------------------------------
    await sb.files.write('/tmp/hello.txt', 'hello, world!');

    // 读取文本（默认）
    const content = await sb.files.read('/tmp/hello.txt');
    console.log(`file content: ${content}`);

    // 读取为 Uint8Array（bytes）
    const raw = await sb.files.read('/tmp/hello.txt', { format: 'bytes' });
    console.log(`raw bytes length: ${(raw as Uint8Array).byteLength}`);

    // -----------------------------------------------------------------------
    // 5. 处理非零退出码
    // -----------------------------------------------------------------------
    try {
      await sb.commands.run('exit 1');
    } catch (e) {
      if (e instanceof CommandExitError) {
        console.log(`command failed with exit code ${e.exitCode}`);
      } else {
        throw e;
      }
    }

    console.log('done.');
  } finally {
    await sb.kill();
  }
}

main().catch(console.error);
