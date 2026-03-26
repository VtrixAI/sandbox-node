/**
 * stream.ts — 流式执行 + execLogs 日志回放
 *
 * Run: npx ts-node examples/stream.ts
 */
import { Client } from '../src';

async function main() {
  const client = new Client({
    baseURL: 'http://localhost:8080',
    token: 'your-token',
    projectID: 'seaclaw',
  });

  const sb = await client.create({ user_id: 'user-123' });
  console.log(`Sandbox: ${sb.info.id}`);

  const cmd = `
    for i in $(seq 1 5); do
      echo "stdout line $i"
      echo "stderr line $i" >&2
      sleep 0.2
    done
  `;

  // ── 实时流式输出 ─────────────────────────────────────────
  console.log('Streaming:');
  for await (const ev of sb.runCommandStream(cmd)) {
    switch (ev.type) {
      case 'start':  console.log('[start]'); break;
      case 'stdout': console.log(`[stdout] ${ev.data}`); break;
      case 'stderr': console.log(`[stderr] ${ev.data}`); break;
      case 'done':   console.log('[done]'); break;
    }
  }

  // ── detached 命令 ─────────────────────────────────────────
  const detached = await sb.runCommandDetached(cmd);
  console.log(`\nDetached cmdId=${detached.cmdId}`);
  const finished = await detached.wait();
  console.log(`Wait done: exit_code=${finished.exitCode}`);

  // ── execLogs 日志回放（已完成命令）───────��──────────────
  console.log('\nReplaying logs via execLogs:');
  for await (const ev of sb.execLogs(detached.cmdId)) {
    if (ev.type === 'stdout') console.log(`  [replay stdout] ${ev.data}`);
    if (ev.type === 'stderr') console.log(`  [replay stderr] ${ev.data}`);
  }

  // ── 流式输出到 writer ────────────────────────────────────
  console.log('\nStreaming to writers:');
  await sb.runCommand('echo "out_line" && echo "err_line" >&2', undefined, {
    stdout: process.stdout,
    stderr: process.stderr,
  });

  // ── Command.logs() / .stdout() / .stderr() ──────────────
  const cmd2 = await sb.runCommandDetached('echo "out_line" && echo "err_line" >&2');
  console.log('\nCommand.logs():');
  for await (const log of cmd2.logs()) {
    console.log(`  [${log.stream}] ${log.data}`);
  }

  const cmd3 = await sb.runCommandDetached('printf "line1\\nline2\\n"');
  const out = await cmd3.stdout();
  console.log(`\nCommand.stdout(): ${JSON.stringify(out.trim())}`);

  sb.close();
}

main().catch(console.error);
