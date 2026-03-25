# @vtrixai/sandbox

Node.js / TypeScript SDK for [Vtrix](https://github.com/VtrixAI) sandbox — run commands and manage files in isolated Linux environments over a persistent WebSocket connection.

## Installation

```bash
npm install @vtrixai/sandbox
```

**Requires Node.js 18+**

## Quick Start

```typescript
import { Client } from '@vtrixai/sandbox';

const client = new Client({
  baseURL:   'http://your-hermes-host:8080',
  token:     'your-token',
  serviceID: 'your-service-id',
});

// Create a sandbox and wait for it to become active
const sb = await client.create({ user_id: 'user-123' });

// Run a command and get the result
const result = await sb.runCommand('echo hello && uname -a');
console.log(`exit_code=${result.exitCode}`);
console.log(result.output);

sb.close();
```

## Core classes

| Class | What it does |
|---|---|
| [`Client`](#client) | Creates and manages sandbox instances |
| [`Sandbox`](#sandbox) | Runs commands and manages files in an isolated environment |
| [`Command`](#command) | Handles a running or completed process |
| [`CommandFinished`](#command) | Result after a command completes — extends `Command` with `exitCode` and `output` |

---

## Client

### `new Client(opts: ClientOptions)`

Creates a new client. The client is reusable and safe for concurrent use across multiple sandbox sessions.

| Field | Type | Required | Description |
|---|---|---|---|
| `baseURL` | `string` | Yes | Hermes gateway URL (e.g. `http://host:8080`). |
| `token` | `string` | No | Bearer token for authentication. |
| `serviceID` | `string` | No | Value sent as `X-Service-ID` header. |

```typescript
const client = new Client({
  baseURL:   'http://your-hermes-host:8080',
  token:     'your-token',
  serviceID: 'your-service-id',
});
```

### `await client.create(opts) → Sandbox`

Use `client.create()` to launch a new sandbox, poll until it is active, and open a WebSocket connection. This is the primary entry point for starting a sandbox session. Pass `env` to set default environment variables that all commands in this sandbox will inherit.

**Returns:** `Promise<Sandbox>`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `opts.user_id` | `string` | Yes | Owner of the sandbox. |
| `opts.spec` | `Spec` | No | Resource spec (`cpu`, `memory`, `image`). |
| `opts.labels` | `Record<string, string>` | No | Arbitrary key-value metadata attached to the sandbox. |
| `opts.payloads` | `Payload[]` | No | Initialisation calls sent to the pod after creation. |
| `opts.ttl_hours` | `number` | No | Sandbox lifetime in hours. Uses the server default when `0`. |
| `opts.env` | `Record<string, string>` | No | Default environment variables inherited by all commands. Per-command `RunOptions.env` values override these. |

```typescript
const sb = await client.create({
  user_id: 'user-123',
  spec: { cpu: '2', memory: '4Gi' },
  ttl_hours: 2,
  env: { NODE_ENV: 'production' },
});
```

### `await client.attach(sandboxId, token?, serviceID?) → Sandbox`

Use `client.attach()` to connect to an existing sandbox without creating a new one. Use this to resume a session after a restart or to connect from a different process. Omit `token` and `serviceID` to fall back to the client-level values.

**Returns:** `Promise<Sandbox>`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `sandboxId` | `string` | Yes | ID of the sandbox to connect to. |
| `token` | `string` | No | Override the client-level token for this connection. |
| `serviceID` | `string` | No | Override the client-level service ID for this connection. |

```typescript
const sb = await client.attach('sandbox-id-abc');
```

### `await client.list(opts?) → ListResult`

Use `client.list()` to enumerate sandboxes visible to the current credentials. Filter by `user_id` or `status` to scope results.

**Returns:** `Promise<ListResult>` — `.items` is `SandboxInfo[]`, `.pagination` has `total`, `limit`, `offset`, `has_more`.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `opts.user_id` | `string` | No | Return only sandboxes owned by this user. |
| `opts.status` | `string` | No | Filter by status: `"active"`, `"stopped"`, etc. |
| `opts.limit` | `number` | No | Maximum number of results. |
| `opts.offset` | `number` | No | Pagination offset. |

```typescript
const { items, pagination } = await client.list({ user_id: 'user-123', status: 'active' });
console.log(`Found ${pagination.total} sandboxes`);
```

### `await client.get(sandboxId) → SandboxInfo`

Use `client.get()` to fetch metadata for a sandbox by ID without opening a WebSocket connection.

**Returns:** `Promise<SandboxInfo>`

```typescript
const info = await client.get('sandbox-id-abc');
console.log(info.status);
```

### `await client.delete(sandboxId)`

Call `client.delete()` to permanently delete a sandbox. This cannot be undone.

**Returns:** `Promise<void>`

```typescript
await client.delete('sandbox-id-abc');
```

---

## Sandbox

A `Sandbox` instance gives you full control over an isolated environment. You receive one from `client.create()` or `client.attach()`.

### Properties

#### `sandbox.status → string`

The `status` property reports the cached lifecycle state of the sandbox. Call `sandbox.refresh(client)` first if you need a live value.

**Returns:** `string` — `"active"`, `"stopped"`, `"destroying"`, etc.

```typescript
console.log(sb.status);
```

#### `sandbox.expireAt → string`

The `expireAt` property returns the cached expiry timestamp. Call `sandbox.refresh(client)` first for an accurate value.

**Returns:** `string` — RFC 3339 timestamp.

```typescript
console.log(sb.expireAt);
```

#### `sandbox.timeout → number`

The `timeout` property returns the remaining sandbox lifetime in milliseconds based on the cached `expireAt`. Returns `0` if the sandbox has already expired. Compare against upcoming commands and call `sandbox.extendTimeout()` if the window is too short.

**Returns:** `number` — milliseconds remaining; `0` if expired.

```typescript
if (sb.timeout < 60_000) {
  await sb.extendTimeout(client, 30 * 60 * 1000);
}
```

---

## Running Commands

### `await sandbox.runCommand(cmd, args?, opts?) → CommandFinished | Command`

`sandbox.runCommand()` executes a command inside the sandbox. By default it blocks until the command finishes and returns a `CommandFinished` result. Set `opts.detached: true` to return immediately with a `Command` handle for background execution.

Set `opts.stdout` or `opts.stderr` to receive output in real time while still blocking — useful for progress logging.

**Returns:** `Promise<CommandFinished>` when `detached` is `false` (default); `Promise<Command>` when `detached` is `true`.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `cmd` | `string` | Yes | Shell command to run. |
| `args` | `string[]` | No | Arguments shell-quoted and appended to `cmd`. Prevents injection. |
| `opts.working_dir` | `string` | No | Working directory inside the sandbox. |
| `opts.timeout_sec` | `number` | No | Kill the command after this many seconds. |
| `opts.env` | `Record<string, string>` | No | Per-command environment variables. Merges with sandbox defaults. |
| `opts.sudo` | `boolean` | No | Prepend `sudo -E` to the command. |
| `opts.stdin` | `string` | No | Data written to the command's stdin before reading output. |
| `opts.stdout` | `NodeJS.WritableStream` | No | Receives stdout chunks as they arrive. |
| `opts.stderr` | `NodeJS.WritableStream` | No | Receives stderr chunks as they arrive. |
| `opts.detached` | `boolean` | No | Return a `Command` immediately without waiting for completion. |

```typescript
// Blocking with live output
const result = await sb.runCommand('npm install', undefined, {
  working_dir: '/app',
  stdout: process.stdout,
  stderr: process.stderr,
});
console.log(`exit_code=${result.exitCode}`);

// Detached (background) execution
const cmd = await sb.runCommand('node server.js', undefined, {
  working_dir: '/app',
  detached: true,
});
// ... do other work ...
const finished = await cmd.wait();
```

### `for await (const ev of sandbox.runCommandStream(cmd, args?, opts?)) → AsyncGenerator<ExecEvent>`

Use `sandbox.runCommandStream()` to run a command and stream `ExecEvent` values in real time. Use this instead of `runCommand` when you need to process stdout and stderr as separate, typed events — for example, to display them with different colours or route them to different log streams.

**Returns:** `AsyncGenerator<ExecEvent>`

| `ev.type` | Meaning |
|---|---|
| `"start"` | Command has started executing. |
| `"stdout"` | A chunk of standard output. Read from `ev.data`. |
| `"stderr"` | A chunk of standard error. Read from `ev.data`. |
| `"done"` | Command has finished. |

```typescript
for await (const ev of sb.runCommandStream('make build')) {
  if (ev.type === 'stdout') process.stdout.write(ev.data!);
  if (ev.type === 'stderr') process.stderr.write(ev.data!);
}
```

### `for await (const ev of sandbox.execLogs(cmdId)) → AsyncGenerator<ExecEvent>`

Use `sandbox.execLogs()` to attach to a running or completed command and stream its output. It replays buffered output first (up to 512 KB), then streams live events for commands still running. Use this to replay logs from a detached command or to attach a second observer.

**Returns:** `AsyncGenerator<ExecEvent>`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `cmdId` | `string` | Yes | ID of the command to attach to. |

```typescript
for await (const ev of sb.execLogs(cmd.cmdId)) {
  console.log(`[${ev.type}] ${ev.data}`);
}
```

### `sandbox.getCommand(cmdId) → Command`

Use `sandbox.getCommand()` to reconstruct a `Command` handle from a known `cmdId`. Use this to reconnect to a command started in a previous call without going through `runCommand` again.

**Returns:** `Command`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `cmdId` | `string` | Yes | ID of the command to retrieve. |

```typescript
const cmd = sb.getCommand('cmd-id-abc');
const result = await cmd.wait();
```

### `await sandbox.kill(cmdId, signal?)`

Call `sandbox.kill()` to send a signal to a running command by ID. The signal is sent to the entire process group, so child processes are also terminated. Send `SIGTERM` for graceful shutdown or `SIGKILL` for immediate termination.

**Returns:** `Promise<void>`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `cmdId` | `string` | Yes | ID of the command to signal. |
| `signal` | `string` | No | Signal name: `"SIGTERM"` (default), `"SIGKILL"`, `"SIGINT"`, `"SIGHUP"`. |

```typescript
await sb.kill(cmd.cmdId, 'SIGTERM');
```

---

## Command

A `Command` represents a running or completed process. You receive one from `sandbox.runCommand({ detached: true })` or `sandbox.getCommand()`. `CommandFinished` extends `Command` and adds `exitCode` and `output`.

### Properties

| Property | Type | Description |
|---|---|---|
| `cmdId` | `string` | Unique identifier for this command execution. |
| `pid` | `number` | Process ID inside the sandbox. |
| `cwd` | `string` | Working directory where the command is executing. |
| `startedAt` | `Date` | Timestamp when the command started. |
| `exitCode` | `number \| null` | Exit status. `null` while the command is still running. |

### `await command.wait() → CommandFinished`

Use `command.wait()` to block until a detached command finishes and get the resulting `CommandFinished` object. This method is essential after `runCommand({ detached: true })` when you need the exit code or output.

**Returns:** `Promise<CommandFinished>` — `exitCode`, `output`, `cmdId`.

```typescript
const cmd = await sb.runCommand('node server.js', undefined, { detached: true });
// ... do other work ...
const result = await cmd.wait();
if (result.exitCode !== 0) {
  console.error('Command failed:', result.output);
}
```

### `for await (const ev of command.logs()) → AsyncGenerator<LogEvent>`

Call `command.logs()` to stream structured log entries as they arrive. Each `LogEvent` has `stream` (`"stdout"` or `"stderr"`) and `data`. Use this instead of `sandbox.execLogs()` when you already have a `Command` handle.

**Returns:** `AsyncGenerator<LogEvent>`

```typescript
for await (const ev of cmd.logs()) {
  if (ev.stream === 'stdout') process.stdout.write(ev.data);
  else process.stderr.write(ev.data);
}
```

### `await command.stdout() → string`

Use `command.stdout()` to collect the full standard output as a string. Call this after `wait()` when you need to parse the complete output rather than process it line by line.

**Returns:** `Promise<string>`

```typescript
const output = await cmd.stdout();
const data = JSON.parse(output);
```

### `await command.stderr() → string`

Use `command.stderr()` to collect the full standard error output as a string. Combine with `exitCode` to build user-friendly error messages.

**Returns:** `Promise<string>`

```typescript
const errors = await cmd.stderr();
if (errors) console.error('Command errors:', errors);
```

### `await command.collectOutput(stream) → string`

Use `command.collectOutput()` to collect stdout, stderr, or both as a single string. Choose `"both"` for combined output, or specify the stream you need to process separately.

**Returns:** `Promise<string>`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `stream` | `"stdout" \| "stderr" \| "both"` | Yes | The output stream to collect. |

```typescript
const combined = await cmd.collectOutput('both');
```

### `await command.kill(signal?)`

Call `command.kill()` to send a signal to this command. See `sandbox.kill()` for valid signal names.

**Returns:** `Promise<void>`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `signal` | `string` | No | Signal name: `"SIGTERM"` (default), `"SIGKILL"`, `"SIGINT"`, `"SIGHUP"`. |

```typescript
await cmd.kill('SIGKILL');
```

---

## File Operations

### `await sandbox.read(path) → ReadResult`

Use `sandbox.read()` to read a file from the sandbox. Text files up to 200 KB are returned in full; larger files are truncated (`truncated: true`). Image files are detected automatically and returned as base64-encoded data with a MIME type. Throws if the file does not exist.

**Returns:** `Promise<ReadResult>`

| Field | Type | Description |
|---|---|---|
| `type` | `"text" \| "image"` | Type of the file. |
| `content` | `string` | File content (text files). |
| `truncated` | `boolean` | `true` if the file was larger than 200 KB. Use `readStream` for the full content. |
| `data` | `string` | Base64-encoded bytes (image files). |
| `mime_type` | `string` | MIME type (image files, e.g. `"image/png"`). |

```typescript
const result = await sb.read('/app/config.json');
if (result.truncated) {
  // use readStream for the full file
}
console.log(result.content);
```

### `await sandbox.write(path, content) → WriteResult`

Use `sandbox.write()` to write a text string to a file. Creates parent directories automatically. Returns the number of bytes written.

**Returns:** `Promise<WriteResult>` — `.bytes_written`.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | `string` | Yes | Destination path inside the sandbox. |
| `content` | `string` | Yes | Text content to write. |

```typescript
const result = await sb.write('/app/config.json', JSON.stringify(config));
console.log(`Wrote ${result.bytes_written} bytes`);
```

### `await sandbox.edit(path, oldText, newText) → EditResult`

Use `sandbox.edit()` to replace an exact occurrence of `oldText` with `newText` inside a file. Throws if `oldText` appears zero times or more than once — ensuring the edit is unambiguous.

**Returns:** `Promise<EditResult>` — `.message`.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | `string` | Yes | Path to the file inside the sandbox. |
| `oldText` | `string` | Yes | The exact text to find and replace. |
| `newText` | `string` | Yes | The text to substitute in its place. |

```typescript
await sb.edit('/app/config.json', '"port": 3000', '"port": 8080');
```

### `await sandbox.writeFiles(files)`

Use `sandbox.writeFiles()` to upload one or more binary files in a single round trip. Creates parent directories automatically. Use this for uploading compiled binaries, images, or executable scripts.

**Returns:** `Promise<void>`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `files[].path` | `string` | Yes | Destination path inside the sandbox. |
| `files[].content` | `Buffer \| Uint8Array` | Yes | Raw file bytes. |
| `files[].mode` | `number` | No | Unix permission bits (e.g. `0o755` for executable). Uses server default when omitted. |

```typescript
await sb.writeFiles([
  { path: '/app/run.sh', content: Buffer.from(script), mode: 0o755 },
  { path: '/app/data.bin', content: dataBuffer },
]);
```

### `await sandbox.readToBuffer(path) → Buffer | null`

Use `sandbox.readToBuffer()` to read a file into memory as a `Buffer`. Returns `null` (not an error) when the file does not exist, making it easy to check for optional files without try/catch.

**Returns:** `Promise<Buffer | null>` — `null` if the file does not exist.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | `string` | Yes | File path inside the sandbox. |

```typescript
const buf = await sb.readToBuffer('/app/output.bin');
if (buf !== null) {
  process(buf);
}
```

### `for await (const chunk of sandbox.readStream(path, chunkSize?)) → AsyncGenerator<Buffer>`

Use `sandbox.readStream()` to read a large file in chunks. Use this instead of `read` when the file exceeds 200 KB or you need complete binary content without truncation. Each `chunk` is already decoded (base64 decoding is handled internally).

**Returns:** `AsyncGenerator<Buffer>`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | `string` | Yes | File path inside the sandbox. |
| `chunkSize` | `number` | No | Bytes per chunk. Defaults to 65536. |

```typescript
import { createWriteStream } from 'fs';
const out = createWriteStream('large.csv');
for await (const chunk of sb.readStream('/data/large.csv')) {
  out.write(chunk);
}
out.end();
```

### `await sandbox.mkDir(path)`

Use `sandbox.mkDir()` to create a directory and all parent directories. Safe to call on paths that already exist.

**Returns:** `Promise<void>`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | `string` | Yes | Directory to create. |

```typescript
await sb.mkDir('/app/logs');
```

### `await sandbox.listFiles(path) → FileEntry[]`

Use `sandbox.listFiles()` to list the contents of a directory. Throws if the path does not exist or is not a directory.

**Returns:** `Promise<FileEntry[]>` — each entry has `name`, `path`, `size`, `is_dir`, `modified_at` (RFC 3339 string or `undefined`).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | `string` | Yes | Directory path inside the sandbox. |

```typescript
const entries = await sb.listFiles('/app');
for (const entry of entries) {
  console.log(`${entry.is_dir ? 'd' : 'f'} ${entry.name}`);
}
```

### `await sandbox.stat(path) → FileInfo`

Use `sandbox.stat()` to get metadata for a path. Unlike most operations, this does **not** throw when the path does not exist — check `info.exists` instead.

**Returns:** `Promise<FileInfo>`

| Field | Type | Description |
|---|---|---|
| `exists` | `boolean` | `false` when the path does not exist. |
| `is_file` | `boolean` | `true` for regular files. |
| `is_dir` | `boolean` | `true` for directories. |
| `size` | `number` | File size in bytes. |
| `modified_at` | `string \| undefined` | RFC 3339 timestamp, or `undefined`. |

```typescript
const info = await sb.stat('/app/config.json');
if (!info.exists) {
  await sb.write('/app/config.json', '{}');
}
```

### `await sandbox.exists(path) → boolean`

Use `sandbox.exists()` to check whether a path exists. A convenient shorthand for `stat` when you only need the existence check.

**Returns:** `Promise<boolean>`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | `string` | Yes | Path to check. |

```typescript
if (await sb.exists('/app/config.json')) {
  // ...
}
```

### `await sandbox.uploadFile(localPath, sandboxPath, opts?)`

Use `sandbox.uploadFile()` to upload a file from the local filesystem into the sandbox.

**Returns:** `Promise<void>`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `localPath` | `string` | Yes | Absolute path on the local machine. |
| `sandboxPath` | `string` | Yes | Destination path inside the sandbox. |
| `opts.mkdirRecursive` | `boolean` | No | Create parent directories on the sandbox side if they do not exist. |

```typescript
await sb.uploadFile('/local/model.bin', '/app/model.bin', { mkdirRecursive: true });
```

### `await sandbox.downloadFile(sandboxPath, localPath, opts?) → string | null`

Use `sandbox.downloadFile()` to download a file from the sandbox to the local filesystem. Returns the absolute local path on success, or `null` when the sandbox file does not exist.

**Returns:** `Promise<string | null>` — `null` if the file does not exist.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `sandboxPath` | `string` | Yes | Path to the file inside the sandbox. |
| `localPath` | `string` | Yes | Destination path on the local machine. |
| `opts.mkdirRecursive` | `boolean` | No | Create local parent directories if they do not exist. |

```typescript
const dst = await sb.downloadFile('/app/output.json', '/tmp/output.json');
if (dst !== null) {
  console.log(`Saved to ${dst}`);
}
```

### `await sandbox.downloadFiles(entries) → Map<string, string>`

Use `sandbox.downloadFiles()` to download multiple files in one call. Returns a `Map` of sandbox path → local path for each file successfully downloaded.

**Returns:** `Promise<Map<string, string>>`

```typescript
const results = await sb.downloadFiles([
  { sandboxPath: '/app/out.json', localPath: '/tmp/out.json' },
  { sandboxPath: '/app/log.txt', localPath: '/tmp/log.txt' },
]);
```

### `sandbox.domain(port) → string`

Use `sandbox.domain()` to get the publicly accessible URL for an exposed port. The sandbox must be created with this port declared.

**Returns:** `string`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `port` | `number` | Yes | Port number to resolve. |

```typescript
const url = sb.domain(3000);
console.log(`App running at ${url}`);
```

---

## Lifecycle

### `await sandbox.refresh(client)`

Call `sandbox.refresh()` to re-fetch sandbox metadata from the server and update the cached values. Call this before reading `sandbox.status` or `sandbox.expireAt` if you need current values.

**Returns:** `Promise<void>`

```typescript
await sb.refresh(client);
console.log(sb.status);
```

### `await sandbox.stop(client, opts?)`

Call `sandbox.stop()` to pause the sandbox without deleting it. Set `opts.blocking: true` to wait until the sandbox reaches `"stopped"` or `"failed"` status before returning.

**Returns:** `Promise<void>`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `opts.blocking` | `boolean` | No | Poll until the sandbox has stopped. |
| `opts.pollIntervalMs` | `number` | No | How often to poll in milliseconds. Defaults to `2000`. |
| `opts.timeoutMs` | `number` | No | Maximum time to wait in milliseconds. Defaults to `300000`. |

```typescript
await sb.stop(client, { blocking: true });
```

### `await sandbox.start(client)`

Use `sandbox.start()` to resume a stopped sandbox.

**Returns:** `Promise<void>`

```typescript
await sb.start(client);
```

### `await sandbox.restart(client)`

Use `sandbox.restart()` to stop and restart the sandbox.

**Returns:** `Promise<void>`

```typescript
await sb.restart(client);
```

### `await sandbox.extend(client, durationMs?)`

Use `sandbox.extend()` to extend the sandbox TTL by `durationMs` milliseconds. Pass `0` to use the server default (12 hours).

**Returns:** `Promise<void>`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `durationMs` | `number` | No | Duration to add in milliseconds. Pass `0` for the server default (12 hours). |

```typescript
// Extend by 30 minutes
await sb.extend(client, 30 * 60 * 1000);
```

### `await sandbox.extendTimeout(client, durationMs?)`

Use `sandbox.extendTimeout()` to extend the TTL and immediately refresh the cached info in one call.

**Returns:** `Promise<void>`

```typescript
await sb.extendTimeout(client, 60 * 60 * 1000); // +1 hour
```

### `await sandbox.update(client, opts)`

Use `sandbox.update()` to change the sandbox spec, image, or payloads. Changing payloads triggers a sandbox restart.

**Returns:** `Promise<void>`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `opts.spec` | `Spec` | No | New resource spec. |
| `opts.image` | `string` | No | New container image tag. |
| `opts.payloads` | `Payload[]` | No | Replaces all stored payloads and triggers a restart. |

```typescript
await sb.update(client, { spec: { cpu: '4', memory: '8Gi' } });
```

### `await sandbox.configure(client)`

Call `sandbox.configure()` to immediately apply the current configuration to the running pod.

**Returns:** `Promise<void>`

```typescript
await sb.configure(client);
```

### `await sandbox.delete(client)`

Call `sandbox.delete()` to permanently delete the sandbox. This cannot be undone.

**Returns:** `Promise<void>`

```typescript
await sb.delete(client);
```

### `sandbox.close()`

Call `sandbox.close()` to close the WebSocket connection. Call this when you are done with the sandbox to free the connection.

```typescript
sb.close();
```

---

## Examples

| File | Description |
|---|---|
| [`examples/basic.ts`](examples/basic.ts) | Create a sandbox, run commands, use detached execution |
| [`examples/stream.ts`](examples/stream.ts) | Real-time streaming, exec_logs replay, `Command.logs`/`stdout` |
| [`examples/attach.ts`](examples/attach.ts) | Reconnect to an existing sandbox by ID |
| [`examples/files.ts`](examples/files.ts) | Read, write, edit, upload, download, and stream files |
| [`examples/lifecycle.ts`](examples/lifecycle.ts) | Stop, start, extend, update, and delete sandboxes |

```bash
npx ts-node examples/basic.ts
```

## License

MIT — see [LICENSE](LICENSE).
