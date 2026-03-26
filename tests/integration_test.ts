/**
 * Hermes Node SDK — Integration Test Suite
 * ==========================================
 * Requires hermes + nano-executor running locally.
 *
 * Run:
 *   cd sdk/node
 *   npx ts-node tests/integration_test.ts
 *
 * Environment variables:
 *   HERMES_URL      Gateway base URL  (default: http://localhost:8080)
 *   HERMES_TOKEN    Bearer token      (default: test)
 *   HERMES_PROJECT  Project ID        (default: local)
 *   SANDBOX_ID      Sandbox ID        (default: local-sandbox)
 */
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Client, WriteFileEntry, DownloadEntry, RunOptions } from '../src';

const BASE_URL   = process.env.HERMES_URL     ?? 'http://localhost:8080';
const TOKEN      = process.env.HERMES_TOKEN   ?? 'test';
const PROJECT    = process.env.HERMES_PROJECT ?? 'local';
const SANDBOX_ID = process.env.SANDBOX_ID     ?? 'local-sandbox';

const PASS = '✅', FAIL = '❌';
const results: { name: string; ok: boolean; detail: string }[] = [];

function check(name: string, cond: boolean, detail = '') {
  const mark = cond ? PASS : FAIL;
  console.log(`  ${mark} ${name}` + (detail ? `  [${detail}]` : ''));
  results.push({ name, ok: cond, detail });
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function getSandbox() {
  const client = new Client({ baseURL: BASE_URL, token: TOKEN, projectID: PROJECT });
  return client.attach(SANDBOX_ID);
}

// ────────────────────────────────────────────────────────────────────────────
// Exec tests
// ────────────────────────────────────────────────────────────────────────────

async function testExecBasic(sb: Awaited<ReturnType<typeof getSandbox>>) {
  console.log('\n── exec: basic ──');
  let r = await sb.runCommand('echo hello');
  check('exit_code 0', r.exitCode === 0);
  check('output contains hello', r.output.includes('hello'));

  r = await sb.runCommand('false');
  check('exit_code non-zero', r.exitCode !== 0);
}

async function testExecArgs(sb: Awaited<ReturnType<typeof getSandbox>>) {
  console.log('\n── exec: args / working_dir / env ──');
  let r = await sb.runCommand('ls', ['-la'], { working_dir: '/tmp' } satisfies RunOptions);
  check('args passed', r.exitCode === 0);

  r = await sb.runCommand('pwd', [], { working_dir: '/tmp' });
  check('working_dir respected', r.output.includes('/tmp'));

  r = await sb.runCommand('echo $FOO', [], { env: { FOO: 'bar_value' } });
  check('env injected', r.output.includes('bar_value'));
}

async function testExecMultiline(sb: Awaited<ReturnType<typeof getSandbox>>) {
  console.log('\n── exec: multi-line output ──');
  const r = await sb.runCommand('for i in $(seq 1 100); do echo line_$i; done');
  const lines = r.output.split('\n').filter(l => l.startsWith('line_'));
  check('100 output lines', lines.length === 100, String(lines.length));
}

async function testExecTimeout(sb: Awaited<ReturnType<typeof getSandbox>>) {
  console.log('\n── exec: timeout ──');
  const t0 = Date.now();
  try {
    await sb.runCommand('sleep 30', [], { timeout_sec: 2 });
    const elapsed = (Date.now() - t0) / 1000;
    check('timeout respected (< 5s)', elapsed < 5, `${elapsed.toFixed(1)}s`);
    check('timeout raises error or non-zero exit', false, 'no error raised');
  } catch (e: any) {
    const elapsed = (Date.now() - t0) / 1000;
    check('timeout respected (< 5s)', elapsed < 5, `${elapsed.toFixed(1)}s`);
    check('timeout raises SandboxError', true, String(e?.message ?? e).slice(0, 60));
  }
}

async function testExecDetached(sb: Awaited<ReturnType<typeof getSandbox>>) {
  console.log('\n── exec: detached / wait / pid ──');
  const cmd = await sb.runCommandDetached('sleep 0.3 && echo detached_done');
  check('cmdId assigned', !!cmd.cmdId);
  check('pid assigned', cmd.pid > 0, String(cmd.pid));
  const fin = await cmd.wait();
  check('detached exit_code 0', fin.exitCode === 0);
  check('detached output', fin.output.includes('detached_done'));
}

async function testExecKill(sb: Awaited<ReturnType<typeof getSandbox>>) {
  console.log('\n── exec: kill ──');
  const cmd = await sb.runCommandDetached('sleep 60');
  await sleep(200);
  await sb.kill(cmd.cmdId, 'SIGKILL');
  const fin = await cmd.wait();
  check('SIGKILL exit_code non-zero', fin.exitCode !== 0);

  const cmd2 = await sb.runCommandDetached('sleep 60');
  await sleep(200);
  await sb.kill(cmd2.cmdId, 'SIGTERM');
  const fin2 = await cmd2.wait();
  check('SIGTERM exit_code non-zero', fin2.exitCode !== 0);
}

async function testExecGetCommand(sb: Awaited<ReturnType<typeof getSandbox>>) {
  console.log('\n── exec: getCommand / stdout / stderr ──');
  const cmd = await sb.runCommandDetached('echo stdout_line && echo stderr_line >&2');
  await cmd.wait();
  const replayed = sb.getCommand(cmd.cmdId);
  const stdout = await replayed.stdout();
  const stderr = await replayed.stderr();
  check('stdout replay', stdout.includes('stdout_line'), JSON.stringify(stdout.trim()));
  check('stderr replay', stderr.includes('stderr_line'), JSON.stringify(stderr.trim()));
}

async function testExecStream(sb: Awaited<ReturnType<typeof getSandbox>>) {
  console.log('\n── exec: runCommandStream ──');
  const events: any[] = [];
  for await (const ev of sb.runCommandStream('echo s1 && echo s2 >&2 && echo s3')) {
    events.push(ev);
  }
  const types = events.map(e => e.type);
  check('stream: start', types.includes('start'), JSON.stringify(types));
  check('stream: done',  types.includes('done'));
  const stdout = events.filter(e => e.type === 'stdout').map(e => e.data).join('');
  const stderr = events.filter(e => e.type === 'stderr').map(e => e.data).join('');
  check('stream: stdout content', stdout.includes('s1') && stdout.includes('s3'));
  check('stream: stderr content', stderr.includes('s2'));
}

async function testExecConcurrent(sb: Awaited<ReturnType<typeof getSandbox>>) {
  console.log('\n── exec: concurrent commands (10) ──');
  const cmds = await Promise.all(
    Array.from({ length: 10 }, (_, i) => sb.runCommandDetached(`echo concurrent_${i}`))
  );
  const fins = await Promise.all(cmds.map(c => c.wait()));
  check('all exit 0', fins.every(f => f.exitCode === 0));
  const outputs = new Set(fins.map(f => f.output.trim()));
  check('10 distinct outputs', outputs.size === 10, String(outputs.size));
}

async function testExecLargeOutput(sb: Awaited<ReturnType<typeof getSandbox>>) {
  console.log('\n── exec: large output (512 KB) ──');
  const r = await sb.runCommand("python3 -c \"print('A'*524288)\"");
  check('large output >= 512KB', r.output.length >= 524_288, `${r.output.length} bytes`);
}

async function testExecSpecialChars(sb: Awaited<ReturnType<typeof getSandbox>>) {
  console.log('\n── exec: special chars ──');
  let r = await sb.runCommand("echo 'single quotes' && echo \"double quotes\"");
  check('single quotes', r.output.includes('single quotes'));
  check('double quotes', r.output.includes('double quotes'));

  r = await sb.runCommand("printf '%s\\n' hello");
  check('printf works', r.exitCode === 0);
}

async function testExecEnvIsolation(sb: Awaited<ReturnType<typeof getSandbox>>) {
  console.log('\n── exec: env isolation ──');
  await sb.runCommand('export SDK_ISOLATION_VAR=should_not_leak');
  const r = await sb.runCommand('echo ${SDK_ISOLATION_VAR:-not_set}');
  check('env isolated between commands', r.output.includes('not_set'), JSON.stringify(r.output.trim()));
}

// ────────────────────────────────────────────────────────────────────────────
// File tests
// ────────────────────────────────────────────────────────────────────────────

async function testFilesWriteRead(sb: Awaited<ReturnType<typeof getSandbox>>) {
  console.log('\n── files: write / read / edit ──');
  const content = 'Hello, Node SDK!\nLine 2\nLine 3\n';
  const wr = await sb.write('/tmp/ts_basic.txt', content);
  check('write bytesWritten > 0', wr.bytes_written > 0, String(wr.bytes_written));

  const rr = await sb.read('/tmp/ts_basic.txt');
  check('read content matches', rr.content === content);
  check('read not truncated', !rr.truncated);

  const er = await sb.edit('/tmp/ts_basic.txt', 'Hello, Node SDK!', 'Hello, World!');
  check('edit message non-empty', !!er.message);
  const rr2 = await sb.read('/tmp/ts_basic.txt');
  check('edit applied', !!(rr2.content?.includes('Hello, World!')));
  check('old text gone', !(rr2.content?.includes('Hello, Node SDK!')));
}

async function testFilesWriteReadBoundary(sb: Awaited<ReturnType<typeof getSandbox>>) {
  console.log('\n── files: boundary — empty / large / unicode ──');
  await sb.write('/tmp/ts_empty.txt', '');
  const rr = await sb.read('/tmp/ts_empty.txt');
  check('empty file content', rr.content === '');

  // Use readStream for large files (readToBuffer goes through text API, truncates at 200KB)
  const big = 'X'.repeat(512 * 1024);
  await sb.write('/tmp/ts_large.txt', big);
  let totalBytes = 0;
  for await (const chunk of sb.readStream('/tmp/ts_large.txt', 65536)) {
    totalBytes += chunk.length;
  }
  check('large file bytes', totalBytes === big.length, String(totalBytes));

  const uni = '你好世界 🌍\nñoño\n';
  await sb.write('/tmp/ts_unicode.txt', uni);
  const rru = await sb.read('/tmp/ts_unicode.txt');
  check('unicode round-trip', !!(rru.content?.includes('你好世界')));
}

async function testFilesWriteFiles(sb: Awaited<ReturnType<typeof getSandbox>>) {
  console.log('\n── files: writeFiles (batch / binary / permissions) ──');
  await sb.writeFiles([
    { path: '/tmp/ts_wf_bin.bin', content: Buffer.from(Array.from({ length: 256 }, (_, i) => i)) } satisfies WriteFileEntry,
    { path: '/tmp/ts_wf_script.sh', content: Buffer.from("#!/bin/bash\necho ts_wf_ok\n"), mode: 0o755 } satisfies WriteFileEntry,
    { path: '/tmp/ts_wf_text.txt', content: Buffer.from('batch text\n') } satisfies WriteFileEntry,
  ]);
  // Use readStream for binary (readToBuffer via text API corrupts non-UTF-8 bytes)
  const chunks: Buffer[] = [];
  for await (const chunk of sb.readStream('/tmp/ts_wf_bin.bin', 65536)) {
    chunks.push(chunk);
  }
  const buf = Buffer.concat(chunks);
  const expected = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  check('binary content correct', buf.length === 256 && buf[0] === 0 && buf[255] === 255 && buf.equals(expected));
  const sr = await sb.runCommand('/tmp/ts_wf_script.sh');
  check('script executable', sr.output.includes('ts_wf_ok'));
  const rr = await sb.read('/tmp/ts_wf_text.txt');
  check('text content', !!(rr.content?.includes('batch text')));
}

async function testFilesReadToBuffer(sb: Awaited<ReturnType<typeof getSandbox>>) {
  console.log('\n── files: readToBuffer ──');
  await sb.writeFiles([
    { path: '/tmp/ts_buf.bin', content: Buffer.from(Array.from({ length: 64 }, (_, i) => i)) } satisfies WriteFileEntry,
  ]);
  const buf = await sb.readToBuffer('/tmp/ts_buf.bin');
  check('readToBuffer length 64', buf !== null && buf.length === 64);
  check('readToBuffer content', buf !== null && buf[0] === 0 && buf[63] === 63);
  const missing = await sb.readToBuffer('/tmp/ts_no_such_xyz');
  check('readToBuffer missing → null', missing === null);
}

async function testFilesMkdirStatExistsList(sb: Awaited<ReturnType<typeof getSandbox>>) {
  console.log('\n── files: mkDir / stat / exists / listFiles ──');
  await sb.mkDir('/tmp/ts_testdir/deep/nested');
  const st = await sb.stat('/tmp/ts_testdir');
  check('stat exists', st.exists);
  check('stat is_dir', st.is_dir);

  await sb.write('/tmp/ts_testdir/f1.txt', 'a');
  await sb.write('/tmp/ts_testdir/f2.txt', 'b');
  const entries = await sb.listFiles('/tmp/ts_testdir');
  const names = entries.map(e => e.name);
  check('listFiles f1.txt', names.includes('f1.txt'));
  check('listFiles f2.txt', names.includes('f2.txt'));
  check('listFiles deep subdir', names.includes('deep'));

  check('exists true',  await sb.exists('/tmp/ts_testdir/f1.txt'));
  check('exists false', !(await sb.exists('/tmp/ts_no_such_xyz')));

  const stMissing = await sb.stat('/tmp/ts_no_such_xyz');
  check('stat non-existent: exists=false', !stMissing.exists);
}

async function testFilesReadStream(sb: Awaited<ReturnType<typeof getSandbox>>) {
  console.log('\n── files: readStream ──');
  const size = 200_000;
  await sb.write('/tmp/ts_stream.txt', 'Y'.repeat(size));

  let total = 0, chunks = 0;
  for await (const chunk of sb.readStream('/tmp/ts_stream.txt', 32768)) {
    total += chunk.length; chunks++;
    check(`chunk ${chunks} is Buffer`, Buffer.isBuffer(chunk));
  }
  check('readStream total bytes', total === size, String(total));
  check('readStream multiple chunks', chunks > 1, String(chunks));

  // Small file
  await sb.write('/tmp/ts_stream_small.txt', 'tiny');
  let total2 = 0;
  for await (const chunk of sb.readStream('/tmp/ts_stream_small.txt', 65536)) {
    total2 += chunk.length;
  }
  check('readStream small file total', total2 === 4, String(total2));
}

async function testFilesUploadDownload(sb: Awaited<ReturnType<typeof getSandbox>>) {
  console.log('\n── files: upload / download ──');
  const tmpSrc = path.join(os.tmpdir(), 'ts_upload_src.txt');
  await fsp.writeFile(tmpSrc, 'ts upload content\n');
  await sb.uploadFile(tmpSrc, '/tmp/ts_uploaded.txt');
  const rr = await sb.read('/tmp/ts_uploaded.txt');
  check('uploadFile content', !!(rr.content?.includes('ts upload content')));

  const tmpDst = tmpSrc + '.downloaded';
  if (fs.existsSync(tmpDst)) fs.unlinkSync(tmpDst);
  const dst = await sb.downloadFile('/tmp/ts_uploaded.txt', tmpDst);
  check('downloadFile returns path', dst === tmpDst);
  check('downloadFile file exists', fs.existsSync(tmpDst));
  const dl = await fsp.readFile(tmpDst, 'utf8');
  check('downloadFile content', dl.includes('ts upload content'));

  const missingDst = await sb.downloadFile('/tmp/ts_no_such_xyz', tmpDst + '.missing');
  check('downloadFile missing → null', missingDst === null);

  await fsp.unlink(tmpSrc);
  await fsp.unlink(tmpDst);
}

async function testFilesDownloadFiles(sb: Awaited<ReturnType<typeof getSandbox>>) {
  console.log('\n── files: downloadFiles (batch) ──');
  await sb.write('/tmp/ts_dl_a.txt', 'content_a');
  await sb.write('/tmp/ts_dl_b.txt', 'content_b');

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ts_dl_'));
  const mapping = await sb.downloadFiles([
    { sandboxPath: '/tmp/ts_dl_a.txt', localPath: path.join(tmpDir, 'a.txt') } satisfies DownloadEntry,
    { sandboxPath: '/tmp/ts_dl_b.txt', localPath: path.join(tmpDir, 'b.txt') } satisfies DownloadEntry,
    { sandboxPath: '/tmp/ts_no_such_xyz', localPath: path.join(tmpDir, 'missing.txt') } satisfies DownloadEntry,
  ]);
  check('downloadFiles a.txt exists', fs.existsSync(path.join(tmpDir, 'a.txt')));
  check('downloadFiles b.txt exists', fs.existsSync(path.join(tmpDir, 'b.txt')));
  const aContent = await fsp.readFile(path.join(tmpDir, 'a.txt'), 'utf8');
  check('downloadFiles a content', aContent.includes('content_a'));
  check('downloadFiles missing → null', mapping.get('/tmp/ts_no_such_xyz') === null);

  await fsp.rm(tmpDir, { recursive: true });
}

async function testFilesConcurrentWrites(sb: Awaited<ReturnType<typeof getSandbox>>) {
  console.log('\n── files: concurrent writes (20) ──');
  const paths = Array.from({ length: 20 }, (_, i) => `/tmp/ts_concurrent_${i}.txt`);
  await Promise.all(paths.map((p, i) => sb.write(p, `content_${i}`)));
  const reads = await Promise.all(paths.map(p => sb.read(p)));
  const ok = reads.every((r, i) => r.content?.includes(`content_${i}`));
  check('20 concurrent writes/reads correct', ok);
}

async function testFilesOverwrite(sb: Awaited<ReturnType<typeof getSandbox>>) {
  console.log('\n── files: overwrite ──');
  await sb.write('/tmp/ts_overwrite.txt', 'original');
  await sb.write('/tmp/ts_overwrite.txt', 'overwritten');
  const rr = await sb.read('/tmp/ts_overwrite.txt');
  check('overwrite applied', rr.content === 'overwritten');
}

// ────────────────────────────────────────────────────────────────────────────
// Runner
// ────────────────────────────────────────────────────────────────────────────

async function main() {
  const sb = await getSandbox();
  try {
    // Exec
    await testExecBasic(sb);
    await testExecArgs(sb);
    await testExecMultiline(sb);
    await testExecTimeout(sb);
    await testExecDetached(sb);
    await testExecKill(sb);
    await testExecGetCommand(sb);
    await testExecStream(sb);
    await testExecConcurrent(sb);
    await testExecLargeOutput(sb);
    await testExecSpecialChars(sb);
    await testExecEnvIsolation(sb);
    // Files
    await testFilesWriteRead(sb);
    await testFilesWriteReadBoundary(sb);
    await testFilesWriteFiles(sb);
    await testFilesReadToBuffer(sb);
    await testFilesMkdirStatExistsList(sb);
    await testFilesReadStream(sb);
    await testFilesUploadDownload(sb);
    await testFilesDownloadFiles(sb);
    await testFilesConcurrentWrites(sb);
    await testFilesOverwrite(sb);
  } finally {
    sb.close();
  }

  // Summary
  const passed = results.filter(r => r.ok).length;
  const total  = results.length;
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Node SDK: ${passed}/${total} passed`);
  const failed = results.filter(r => !r.ok);
  failed.forEach(r => console.log(`  ${FAIL} FAILED: ${r.name}` + (r.detail ? `  [${r.detail}]` : '')));
  if (failed.length) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
