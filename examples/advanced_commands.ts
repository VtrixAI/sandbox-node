/**
 * advanced_commands.ts — 进程列表、Connect、by-tag 操作、WatchDir 示例。
 *
 * 运行:
 *   SANDBOX_API_KEY=your-key SANDBOX_BASE_URL=https://api.sandbox.vtrix.ai npx tsx examples/advanced_commands.ts
 *
 * 环境变量:
 *   SANDBOX_API_KEY   必填
 *   SANDBOX_BASE_URL  必填，例如 https://api.sandbox.vtrix.ai
 *
 * 注意: by-tag 操作和进程列表依赖 /proc，仅在 Linux 上可用。
 */

import { Sandbox } from '../src/index.js';
import { CommandExitError } from '../src/index.js';
import type { FilesystemEvent } from '../src/index.js';

const isLinux = process.platform === 'linux';

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
    // 1. 列出运行中的进程
    // -----------------------------------------------------------------------
    const handle = await sb.commands.run('sleep 30', { background: true });

    await sleep(200);
    const procs = await sb.commands.list();
    console.log(`running processes: ${procs.length}`);
    for (const p of procs) {
      console.log(`  pid=${p.pid} cmd=${p.cmd}`);
    }

    // -----------------------------------------------------------------------
    // 2. Connect — 通过 PID 接入运行中的进程
    // -----------------------------------------------------------------------
    const connected = await sb.commands.connect(handle.pid);
    console.log(`connected to pid=${connected.pid}`);
    connected.disconnect(); // 只是断开流，进程仍在运行

    await handle.kill();

    // -----------------------------------------------------------------------
    // 3. By-tag 操作（仅 Linux）
    // -----------------------------------------------------------------------
    if (!isLinux) {
      console.log('skipping by-tag operations (non-Linux)');
    } else {
      const tag = 'example-tag';
      const tagged = await sb.commands.run('sleep 60', { background: true, tag });
      await sleep(300);

      // connectByTag
      const conn = await sb.commands.connectByTag(tag);
      console.log(`connectByTag pid=${conn.pid}`);
      conn.disconnect();

      // sendStdinByTag
      await sb.commands.sendStdinByTag(tag, 'data\n');
      console.log('sendStdinByTag sent');

      // killByTag
      const ok = await sb.commands.killByTag(tag);
      console.log(`killByTag: ${ok}`);

      try {
        await tagged.wait();
      } catch (e) {
        if (e instanceof CommandExitError) {
          console.log(`tagged process exited with code ${e.exitCode}`);
        }
      }
    }

    // -----------------------------------------------------------------------
    // 4. WatchDir — 监听目录文件系统事件
    // -----------------------------------------------------------------------
    const watchPath = '/tmp/watch_example';
    await sb.files.makeDir(watchPath);

    try {
      const events: FilesystemEvent[] = [];
      const watcher = await sb.files.watchDir(watchPath, (e) => events.push(e));

      await sleep(200);
      await sb.files.write(`${watchPath}/trigger.txt`, 'hello');
      await sleep(500);

      watcher.stop();
      console.log(`WatchDir events received: ${events.length}`);
      for (const e of events) {
        console.log(`  ${e.type} ${e.name}`);
      }
    } catch (e) {
      console.log(`WatchDir not supported in this environment: ${e}`);
    }

    console.log('done.');
  } finally {
    await sb.kill();
  }
}

main().catch(console.error);
