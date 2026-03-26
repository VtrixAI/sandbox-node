/**
 * basic.ts — 创建沙箱 → 执行命令 → detached 命令 → 文件操作 → 关闭
 *
 * Run: npx ts-node examples/basic.ts
 */
import { Client, CreateOptions, RunOptions } from '../src';

async function main() {
  const client = new Client({
    baseURL: 'http://localhost:8080',
    token: 'your-token',
    projectID: 'seaclaw',
  });

  console.log('Creating sandbox...');
  const sb = await client.create({
    user_id: 'user-123',
    spec: { cpu: '2', memory: '4Gi' },
  } satisfies CreateOptions);

  console.log(`Sandbox ready: ${sb.info.id} (status=${sb.info.status})`);

  // 一次性执行（阻塞直到命令结束）
  const result = await sb.runCommand('echo hello && uname -a');
  console.log(`exit_code=${result.exitCode}`);
  console.log(`output:\n${result.output}`);

  // 带 args 和选项
  const result2 = await sb.runCommand('ls', ['-la', '/tmp'], { working_dir: '/tmp', timeout_sec: 10 } satisfies RunOptions);
  console.log(`ls -la /tmp:\n${result2.output.trim()}`);

  // detached 命令：立即返回 Command，稍后 wait()
  const cmd = await sb.runCommandDetached(
    'for i in $(seq 1 3); do echo bg_$i; sleep 0.3; done',
  );
  console.log(`Detached cmdId=${cmd.cmdId}  pid=${cmd.pid}`);

  // wait() 等待结束，获取 CommandFinished
  const finished = await cmd.wait();
  console.log(`Detached done: exit_code=${finished.exitCode}`);
  console.log(`Detached output:\n${finished.output.trim()}`);

  // getCommand：通过 cmdId 重新拿到 Command 对象
  const cmd2 = sb.getCommand(cmd.cmdId);
  const stdoutText = await cmd2.stdout();
  console.log(`Re-fetched stdout: ${stdoutText.trim()}`);

  // kill 示例（先启动一个 sleep，再 kill 它）
  const sleeper = await sb.runCommandDetached('sleep 60');
  await sb.kill(sleeper.cmdId, 'SIGKILL');
  console.log(`Killed sleep, cmdId=${sleeper.cmdId}`);

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
