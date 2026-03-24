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
    serviceID: 'seaclaw',
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

  // ── detached 命令 + stdout/stderr writer ─────────────────
  const detached = await sb.runCommand(cmd, undefined, {
    detached: true,
    stdout: process.stdout,
    stderr: process.stderr,
  }) as any;
  console.log(`\nDetached cmdId=${detached.cmdId}`);
  const finished = await detached.wait();
  console.log(`Wait done: exit_code=${finished.exitCode}`);

  // ── execLogs 日志回放（已完成命令）──────────────────────
  console.log('\nReplaying logs via execLogs:');
  for await (const ev of sb.execLogs(detached.cmdId)) {
    if (ev.type === 'stdout') console.log(`  [replay stdout] ${ev.data}`);
    if (ev.type === 'stderr') console.log(`  [replay stderr] ${ev.data}`);
  }

  // ── Command.logs() / .stdout() / .stderr() ──────────────
  const cmd2 = await sb.runCommand(
    'echo "out_line" && echo "err_line" >&2',
    undefined,
    { detached: true },
  ) as any;
  console.log('\nCommand.logs():');
  for await (const log of cmd2.logs()) {
    console.log(`  [${log.stream}] ${log.data}`);
  }

  const cmd3 = await sb.runCommand('printf "line1\\nline2\\n"', undefined, { detached: true }) as any;
  const out = await cmd3.stdout();
  console.log(`\nCommand.stdout(): ${JSON.stringify(out.trim())}`);

  sb.close();
}

main().catch(console.error);
