/**
 * filesystem.ts — 文件系统操作示例：读写、目录、编辑、监听等。
 *
 * 运行:
 *   SANDBOX_API_KEY=your-key SANDBOX_BASE_URL=https://api.sandbox.vtrix.ai npx tsx examples/filesystem.ts
 *
 * 环境变量:
 *   SANDBOX_API_KEY   必填
 *   SANDBOX_BASE_URL  必填，例如 https://api.sandbox.vtrix.ai
 */

import { Sandbox } from '../src/index.js';

async function main() {
  const sb = await Sandbox.create({ apiKey: process.env.SANDBOX_API_KEY });

  try {
    // --- 写入文本 / 字节 ---
    await sb.files.write('/tmp/notes.txt', 'line1\nline2\nline3');
    await sb.files.write('/tmp/data.bin', new Uint8Array([0x00, 0x01, 0x02]).buffer);

    // --- 读取 ---
    const text = await sb.files.read('/tmp/notes.txt');
    console.log(`notes.txt:\n${text}`);

    // 读取为 Uint8Array（bytes）
    const rawBytes = await sb.files.read('/tmp/notes.txt', { format: 'bytes' });
    console.log(`notes.txt bytes length: ${(rawBytes as Uint8Array).byteLength}`);

    // 读取为 ReadableStream（stream）
    const stream = await sb.files.read('/tmp/notes.txt', { format: 'stream' });
    const reader = (stream as ReadableStream).getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    console.log(`notes.txt stream chunks: ${chunks.length}`);

    // --- 查找替换 (edit) ---
    await sb.files.edit('/tmp/notes.txt', 'line2', 'LINE_TWO');
    const updated = await sb.files.read('/tmp/notes.txt');
    console.log(`after edit:\n${updated}`);

    // --- 批量写入 ---
    await sb.files.write([
      { path: '/tmp/a.txt', data: 'file A' },
      { path: '/tmp/b.txt', data: 'file B' },
    ]);

    // --- 目录操作 ---
    await sb.files.makeDir('/tmp/mydir');

    const entries = await sb.files.list('/tmp');
    console.log(`/tmp entries (${entries.length}):`);
    for (const e of entries) {
      console.log(`  ${e.name} (${e.type}, ${e.size} bytes)`);
    }

    // list 支持 depth 参数（递归层数）
    const deep = await sb.files.list('/tmp', { depth: 2 });
    console.log(`/tmp depth=2 entries: ${deep.length}`);

    // --- exists / getInfo / rename / remove ---
    console.log(`notes.txt exists: ${await sb.files.exists('/tmp/notes.txt')}`);

    const info = await sb.files.getInfo('/tmp/notes.txt');
    console.log(`notes.txt size: ${info.size}`);

    await sb.files.rename('/tmp/notes.txt', '/tmp/notes_renamed.txt');
    await sb.files.remove('/tmp/notes_renamed.txt');

    console.log('done.');
  } finally {
    await sb.kill();
  }
}

main().catch(console.error);
