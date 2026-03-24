/**
 * files.ts — 文件读写、编辑、stat、列目录、upload/download、readStream
 *
 * Run: npx ts-node examples/files.ts
 */
import * as fs from 'fs';
import { Client, WriteFileEntry } from '../src';

async function main() {
  const client = new Client({
    baseURL: 'http://localhost:8080',
    token: 'your-token',
    serviceID: 'seaclaw',
  });

  const sb = await client.create({ user_id: 'user-123' });
  console.log(`Sandbox: ${sb.info.id}`);

  // ── 写 / 读 / 编辑 ────────────────────────────────────
  const wr = await sb.write('/tmp/hello.txt', 'Hello, Sandbox!\nLine 2\n');
  console.log(`Written ${wr.bytes_written} bytes`);

  const rr = await sb.read('/tmp/hello.txt');
  console.log(`Read (truncated=${rr.truncated}):\n${rr.content}`);

  const er = await sb.edit('/tmp/hello.txt', 'Hello, Sandbox!', 'Hello, World!');
  console.log(`Edit: ${er.message}`);

  // ── writeFiles（批量 / 二进制 / 设权限）──────────────
  await sb.writeFiles([
    {
      path: '/tmp/data.bin',
      content: Buffer.from(Array.from({ length: 64 }, (_, i) => i)),
    } satisfies WriteFileEntry,
    {
      path: '/tmp/run.sh',
      content: Buffer.from("#!/bin/bash\necho 'hello from script'\n"),
      mode: 0o755,
    } satisfies WriteFileEntry,
  ]);
  console.log('WriteFiles done');

  // 验证可执行脚本
  const scriptResult = await sb.runCommand('/tmp/run.sh');
  console.log(`Script output: ${scriptResult.output.trim()}`);

  // ── readToBuffer（读取原始字节）──────────────────────
  const buf = await sb.readToBuffer('/tmp/data.bin');
  console.log(`ReadToBuffer: ${buf?.length} bytes, first 4 = ${Array.from(buf!.slice(0, 4))}`);

  // 不存在的文件 → null
  const missing = await sb.readToBuffer('/tmp/no_such_file');
  console.log(`Missing file → ${missing}`);

  // ── mkDir / stat / exists / listFiles ────────────────
  await sb.mkDir('/tmp/mydir/sub');
  console.log('MkDir done');

  const info = await sb.stat('/tmp/mydir');
  console.log(`Stat /tmp/mydir: exists=${info.exists}, is_dir=${info.is_dir}`);

  const exists = await sb.exists('/tmp/hello.txt');
  console.log(`Exists /tmp/hello.txt: ${exists}`);

  // 写几个文件到目录
  for (const name of ['a.txt', 'b.txt']) {
    await sb.write(`/tmp/mydir/${name}`, `content of ${name}`);
  }
  const entries = await sb.listFiles('/tmp/mydir');
  console.log(`ListFiles /tmp/mydir: ${entries.map(e => e.name)}`);

  // ── readStream（大文件分块读取）──────────────────────
  await sb.write('/tmp/big.txt', 'X'.repeat(100_000));
  let total = 0;
  let chunks = 0;
  for await (const chunk of sb.readStream('/tmp/big.txt', 32768)) {
    total += chunk.length;
    chunks++;
  }
  console.log(`ReadStream: ${total} bytes in ${chunks} chunk(s)`);

  // ── uploadFile / downloadFile ─────────────────────────
  const localSrc = '/tmp/sdk_upload_test.txt';
  fs.writeFileSync(localSrc, 'uploaded content\n');

  await sb.uploadFile(localSrc, '/tmp/uploaded.txt');
  console.log('UploadFile done');

  const localDst = '/tmp/sdk_download_test.txt';
  const dst = await sb.downloadFile('/tmp/uploaded.txt', localDst);
  console.log(`DownloadFile → ${dst}`);
  console.log(`Downloaded content: ${fs.readFileSync(dst!).toString().trim()}`);

  // 下载不存在的文件 → null
  const missingDst = await sb.downloadFile('/tmp/nonexistent.txt', '/tmp/never.txt');
  console.log(`Download missing → ${missingDst}`);

  // 综合：写代码文件再执行
  const code = "#!/usr/bin/env python3\nprint('Hello from Python inside sandbox!')\n";
  await sb.write('/tmp/script.py', code);
  const runResult = await sb.runCommand('python3 /tmp/script.py');
  console.log(`Script output: ${runResult.output.trim()}`);

  sb.close();
}

main().catch(console.error);
