/**
 * basic.ts — 创建沙箱 → 执行命令 → 文件操作 → 关闭
 *
 * Run: npx ts-node examples/basic.ts
 */
import { Client, CreateOptions } from '../src';

async function main() {
  const client = new Client({
    baseURL: 'http://localhost:8080',
    token: 'your-token',
    serviceID: 'seaclaw',
  });

  console.log('Creating sandbox...');
  const sb = await client.create({
    user_id: 'user-123',
    spec: { cpu: '2', memory: '4Gi' },
  } satisfies CreateOptions);

  console.log(`Sandbox ready: ${sb.info.id} (status=${sb.info.status})`);

  // 一次性执行
  const result = await sb.execute('echo hello && uname -a');
  console.log(`exit_code=${result.exit_code}`);
  console.log(`output:\n${result.output}`);

  // 带选项
  const result2 = await sb.execute('pwd', { working_dir: '/tmp', timeout_sec: 10 });
  console.log(`pwd: ${result2.output.trim()}`);

  // 文件操作
  const wr = await sb.write('/tmp/hello.txt', 'Hello, Sandbox!\nLine 2\n');
  console.log(`Written ${wr.bytes_written} bytes`);

  const rr = await sb.read('/tmp/hello.txt');
  console.log(`Content:\n${rr.content}`);

  const er = await sb.edit('/tmp/hello.txt', 'Hello, Sandbox!', 'Hello, World!');
  console.log(`Edit: ${er.message}`);

  sb.close();
}

main().catch(console.error);
