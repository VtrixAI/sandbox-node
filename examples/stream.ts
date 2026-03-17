/**
 * stream.ts — 流式执行，实时打印 stdout/stderr
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

  console.log('Streaming:');
  for await (const ev of sb.executeStream(cmd)) {
    switch (ev.type) {
      case 'start':  console.log('[start]'); break;
      case 'stdout': console.log(`[stdout] ${ev.data}`); break;
      case 'stderr': console.log(`[stderr] ${ev.data}`); break;
      case 'done':   console.log('[done]'); break;
    }
  }

  sb.close();
}

main().catch(console.error);
