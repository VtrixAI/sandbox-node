/**
 * attach.ts — 复用已有沙箱（不重新创建）
 *
 * Run: npx ts-node examples/attach.ts <sandbox-id>
 */
import { Client } from '../src';

async function main() {
  const sandboxId = process.argv[2];
  if (!sandboxId) {
    console.error('Usage: npx ts-node examples/attach.ts <sandbox-id>');
    process.exit(1);
  }

  const client = new Client({
    baseURL: 'http://localhost:8080',
    token: 'your-token',
    serviceID: 'seaclaw',
  });

  console.log(`Attaching to: ${sandboxId}`);
  const sb = await client.attach(sandboxId);
  console.log(`Attached: ${sb.info.id} (status=${sb.info.status})`);

  const result = await sb.execute('hostname && date');
  console.log(result.output);

  sb.close();
}

main().catch(console.error);
