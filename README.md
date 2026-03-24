# sandbox-node

Node.js / TypeScript SDK for [Vtrix](https://github.com/VtrixAI) sandbox — JSON-RPC 2.0 over WebSocket.

## Installation

```bash
npm install @vtrixai/sandbox
```

## Quick Start

```typescript
import { Client, CreateOptions } from '@vtrixai/sandbox';

const client = new Client({
  baseURL:   'http://your-hermes-host:8080',
  token:     'your-token',
  serviceID: 'your-service-id',
});

const sb = await client.create({
  user_id: 'user-123',
  spec: { cpu: '2', memory: '4Gi' },
} satisfies CreateOptions);

const result = await sb.runCommand('echo hello && uname -a');
console.log(`exit_code=${result.exitCode}`);
console.log(result.output);

sb.close();
```

## API

### Client

```typescript
import { Client } from '@vtrixai/sandbox';

const client = new Client({
  baseURL:   'http://host:8080', // Hermes gateway URL
  token:     '...',              // Bearer token (optional)
  serviceID: '...',              // X-Service-ID header (optional)
});

const sb   = await client.create(opts);          // create + poll + connect
const sb   = await client.attach(sandboxId);     // connect to existing sandbox
const list = await client.list(opts);            // list sandboxes
const info = await client.get(sandboxId);        // get sandbox metadata
             await client.delete(sandboxId);     // delete sandbox
```

### Execute

```typescript
import { RunOptions } from '@vtrixai/sandbox';

// Blocking — waits for command to finish
const result = await sb.runCommand('command', undefined, {
  working_dir: '/tmp',
  timeout_sec: 30,
  env: { FOO: 'bar' },
  sudo: false,
  stdin: '',
} satisfies RunOptions);
// result.exitCode, result.output, result.cmdId

// Streaming — real-time stdout/stderr
for await (const ev of sb.runCommandStream('command')) {
  // ev.type: "start" | "stdout" | "stderr" | "done"
  // ev.data
}

// Detached — returns immediately
const cmd = await sb.runCommand('long-running-command', undefined, { detached: true });
// cmd.cmdId, cmd.pid

// Command methods
const finished = await cmd.wait();               // block until done → CommandFinished
for await (const ev of cmd.logs()) {             // stream LogEvents
  // ev.stream: "stdout" | "stderr", ev.data
}
const stdout = await cmd.stdout();               // collect stdout string
const stderr = await cmd.stderr();               // collect stderr string
const out    = await cmd.collectOutput('both');  // "stdout"|"stderr"|"both"
               await cmd.kill('SIGTERM');        // send signal

// Reconnect to a known command
const cmd = sb.getCommand(cmdId);

// Attach to a running or completed command and replay its output
for await (const ev of sb.execLogs(cmdId)) {
  // ev.type: "start" | "stdout" | "stderr" | "done"
}
```

### File Operations

```typescript
import { WriteFileEntry, DownloadOptions, DownloadEntry } from '@vtrixai/sandbox';

// Read / Write / Edit
const result = await sb.read('/path/to/file');
const result = await sb.write('/path/to/file', 'content');
const result = await sb.edit('/path/to/file', 'old text', 'new text');

// Binary files
await sb.writeFiles([{ path: '/tmp/data.bin', content: Buffer.from('...'), mode: 0o755 }]);
const data = await sb.readToBuffer('/path/to/file'); // Buffer or null if not found

// Directory
await sb.mkDir('/path/to/dir');

// List / Stat / Exists
const entries = await sb.listFiles('/path');
const info    = await sb.stat('/path/to/file');
const exists  = await sb.exists('/path/to/file');

// Upload / Download
await sb.uploadFile('local.txt', '/sandbox/path.txt');
const abs = await sb.downloadFile('/sandbox/path.txt', 'local.txt',
                                  { mkdirRecursive: true });
const downloaded = await sb.downloadFiles([
  { sandboxPath: '/a.txt', localPath: 'a.txt' },
]);

// Stream large files (yields Buffer chunks)
for await (const chunk of sb.readStream('/large/file', 65536)) {
  // chunk: Buffer
}

// URL for exposed ports
const url = sb.domain(8080); // "https://8080-<preview-host>"
```

### Lifecycle

```typescript
import { StopOptions, UpdateOptions } from '@vtrixai/sandbox';

await sb.refresh(client);
await sb.stop(client, { blocking: true } satisfies StopOptions);
await sb.start(client);
await sb.restart(client);
await sb.extend(client, 12 * 3_600_000);          // extend TTL by 12h (milliseconds)
await sb.extendTimeout(client, 12 * 3_600_000);   // extend + refresh
await sb.update(client, { ... } satisfies UpdateOptions);
await sb.configure(client);                        // apply config to pod
await sb.delete(client);

sb.status;    // cached status string
sb.expireAt;  // cached expiry (RFC3339)
```

## Examples

See the [`examples/`](examples/) directory:

| File | Description |
|------|-------------|
| `examples/basic.ts` | Create sandbox, run commands, detached exec |
| `examples/stream.ts` | Real-time streaming, exec_logs replay, Command.logs/stdout |
| `examples/attach.ts` | Reconnect to an existing sandbox by ID |
| `examples/files.ts` | File read/write/edit/upload/download/stream |
| `examples/lifecycle.ts` | Stop/start/extend/update/delete |

Run an example:

```bash
npx ts-node examples/basic.ts
```
