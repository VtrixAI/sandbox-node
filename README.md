# sandbox-node

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

## API Reference

### Client

#### `new Client(opts: ClientOptions)`

Creates a new client. The client is reusable across multiple sandbox sessions.

| Field | Type | Description |
|---|---|---|
| `baseURL` | `string` | Hermes gateway URL (e.g. `http://host:8080`). |
| `token` | `string` | Bearer token for authentication. |
| `serviceID` | `string` | Value sent as `X-Service-ID` header. |

#### `await client.create(opts) → Sandbox`

Creates a new sandbox, polls until it becomes active, and opens a WebSocket connection. This is the primary entry point for starting a sandbox session.

| Parameter | Type | Description |
|---|---|---|
| `opts.user_id` | `string` | Owner of the sandbox. |
| `opts.spec` | `Spec` | Optional resource spec (`cpu`, `memory`, `image`). |
| `opts.labels` | `Record<string, string>` | Arbitrary key-value metadata attached to the sandbox. |
| `opts.payloads` | `Payload[]` | Initialisation calls sent to the pod after creation. |
| `opts.ttl_hours` | `number` | Sandbox lifetime in hours. Uses the server default when `0`. |
| `opts.env` | `Record<string, string>` | Default environment variables inherited by all commands. Per-command `RunOptions.env` values override these. |

**Returns:** `Promise<Sandbox>`

```typescript
const sb = await client.create({
  user_id: 'user-123',
  spec: { cpu: '2', memory: '4Gi' },
  ttl_hours: 2,
  env: { NODE_ENV: 'production' },
});
```

#### `await client.attach(sandboxId, token?, serviceID?) → Sandbox`

Connects to an existing sandbox without creating a new one. Use this to resume a session after a restart or to connect from a different process. Omit `token` and `serviceID` to fall back to the client-level values.

**Returns:** `Promise<Sandbox>`

```typescript
const sb = await client.attach('sandbox-id-abc');
```

#### `await client.list(opts?) → ListResult`

Lists sandboxes visible to the current credentials. Filter by `user_id` or `status` to scope results.

| Parameter | Type | Description |
|---|---|---|
| `opts.user_id` | `string` | Return only sandboxes owned by this user. |
| `opts.status` | `string` | Filter by status: `"active"`, `"stopped"`, etc. |
| `opts.limit` | `number` | Maximum number of results. |
| `opts.offset` | `number` | Pagination offset. |

**Returns:** `Promise<ListResult>` — `.items` is `SandboxInfo[]`, `.pagination` has `total`, `limit`, `offset`, `has_more`.

#### `await client.get(sandboxId) → SandboxInfo`

Fetches metadata for a sandbox by ID without opening a WebSocket connection.

#### `await client.delete(sandboxId)`

Permanently deletes a sandbox. This cannot be undone.

---

### Running Commands

#### `await sandbox.runCommand(cmd, args?, opts?) → CommandFinished | Command`

Runs a command inside the sandbox. By default, blocks until the command finishes and returns the result. Set `opts.detached: true` to return immediately with a `Command` handle for background execution.

Set `opts.stdout` or `opts.stderr` to receive output in real time while still blocking — useful for progress logging.

| Parameter | Type | Description |
|---|---|---|
| `cmd` | `string` | Shell command to run. |
| `args` | `string[]` | Arguments shell-quoted and appended to `cmd`. Prevents injection. |
| `opts.working_dir` | `string` | Working directory inside the sandbox. |
| `opts.timeout_sec` | `number` | Kill the command after this many seconds. |
| `opts.env` | `Record<string, string>` | Per-command environment variables. Merges with sandbox defaults. |
| `opts.sudo` | `boolean` | Prepend `sudo -E` to the command. |
| `opts.stdin` | `string` | Data written to the command's stdin before reading output. |
| `opts.stdout` | `NodeJS.WritableStream` | Receives stdout chunks as they arrive. |
| `opts.stderr` | `NodeJS.WritableStream` | Receives stderr chunks as they arrive. |
| `opts.detached` | `boolean` | Return a `Command` immediately without waiting for completion. |

**Returns:** `Promise<CommandFinished>` when `detached` is `false` (default); `Promise<Command>` when `detached` is `true`.

```typescript
// Blocking with live output
const result = await sb.runCommand('npm install', undefined, {
  working_dir: '/app',
  stdout: process.stdout,
  stderr: process.stderr,
});

// Detached (background) execution
const cmd = await sb.runCommand('node server.js', undefined, {
  working_dir: '/app',
  detached: true,
});
```

#### `for await (const ev of sandbox.runCommandStream(cmd, args?, opts?)) → AsyncGenerator<ExecEvent>`

Runs a command and streams `ExecEvent` values in real time. Use this instead of `runCommand` when you need to process stdout and stderr as separate, typed events (e.g. to display them with different colours).

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

#### `for await (const ev of sandbox.execLogs(cmdId)) → AsyncGenerator<ExecEvent>`

Attaches to a running or completed command and streams its output. Replays buffered output first (up to 512 KB), then streams live events for commands still running. Use this to replay logs from a detached command or to attach a second observer.

```typescript
for await (const ev of sb.execLogs(cmd.cmdId)) {
  console.log(`[${ev.type}] ${ev.data}`);
}
```

#### `sandbox.getCommand(cmdId) → Command`

Reconstructs a `Command` handle from a known `cmdId`. Use this to reconnect to a command started in a previous call without going through `runCommand` again.

**Returns:** `Command`

#### `await sandbox.kill(cmdId, signal?)`

Sends a signal to a running command by ID. The signal is sent to the entire process group, so child processes are also terminated.

| Parameter | Type | Description |
|---|---|---|
| `cmdId` | `string` | ID of the command to signal. |
| `signal` | `string` | Signal name: `"SIGTERM"` (default), `"SIGKILL"`, `"SIGINT"`, `"SIGHUP"`. |

---

### Command

A `Command` represents a running or completed process. You receive one from `runCommand({ detached: true })` or `getCommand()`. `CommandFinished` extends `Command` and adds `exitCode` and `output`.

**Properties:** `cmdId`, `pid`, `cwd`, `startedAt` (`Date`), `exitCode` (`number | null` — `null` while still running).

#### `await command.wait() → CommandFinished`

Blocks until the command finishes and returns the final result. Essential after `runCommand({ detached: true })` when you need the exit code or output.

**Returns:** `Promise<CommandFinished>` — `exitCode`, `output`, `cmdId`.

#### `for await (const ev of command.logs()) → AsyncGenerator<LogEvent>`

Streams structured log entries as they arrive. Each `LogEvent` has `stream` (`"stdout"` or `"stderr"`) and `data`. Use this instead of `execLogs` when you already have a `Command` handle.

```typescript
for await (const ev of cmd.logs()) {
  console.log(`[${ev.stream}] ${ev.data}`);
}
```

#### `await command.stdout() → string`

Collects the full standard output as a string. Call this after `wait()` when you need to parse the complete output rather than process it line by line.

#### `await command.stderr() → string`

Collects the full standard error output as a string.

#### `await command.collectOutput(stream) → string`

Collects stdout, stderr, or both as a single string.

| Parameter | Type | Description |
|---|---|---|
| `stream` | `"stdout" \| "stderr" \| "both"` | The output stream to collect. |

#### `await command.kill(signal?)`

Sends a signal to this command. See `sandbox.kill` for valid signal names.

---

### File Operations

#### `await sandbox.read(path) → ReadResult`

Reads a file from the sandbox. Text files up to 200 KB are returned in full; larger files are truncated (`truncated: true`). Image files are detected automatically and returned as base64-encoded data with a MIME type. Throws if the file does not exist.

| Field | Type | Description |
|---|---|---|
| `type` | `"text" \| "image"` | Type of the file. |
| `content` | `string` | File content (text files). |
| `truncated` | `boolean` | `true` if the file was larger than 200 KB and content was cut. Use `readStream` for full content. |
| `data` | `string` | Base64-encoded bytes (image files). |
| `mime_type` | `string` | MIME type (image files, e.g. `"image/png"`). |

```typescript
const result = await sb.read('/app/config.json');
if (result.truncated) {
  // use readStream for the full file
}
```

#### `await sandbox.write(path, content) → WriteResult`

Writes a text string to a file. Creates parent directories automatically. Returns the number of bytes written.

**Returns:** `Promise<WriteResult>` — `.bytes_written`.

#### `await sandbox.edit(path, oldText, newText) → EditResult`

Replaces an exact occurrence of `oldText` with `newText` inside a file. Throws if `oldText` appears zero times or more than once — ensuring the edit is unambiguous.

**Returns:** `Promise<EditResult>` — `.message`.

#### `await sandbox.writeFiles(files)`

Writes one or more binary files in a single round trip. Creates parent directories automatically. Use this for uploading compiled binaries, images, or executable scripts.

| Parameter | Type | Description |
|---|---|---|
| `files[].path` | `string` | Destination path inside the sandbox. |
| `files[].content` | `Buffer \| Uint8Array` | Raw file bytes. |
| `files[].mode` | `number` | Unix permission bits (e.g. `0o755` for executable). Uses server default when omitted. |

```typescript
await sb.writeFiles([
  { path: '/app/run.sh', content: Buffer.from(script), mode: 0o755 },
  { path: '/app/data.bin', content: dataBuffer },
]);
```

#### `await sandbox.readToBuffer(path) → Buffer | null`

Reads a file into memory as a `Buffer`. Returns `null` (not an error) when the file does not exist, making it easy to check for optional files without try/catch.

**Returns:** `Promise<Buffer | null>` — `null` if the file does not exist.

#### `for await (const chunk of sandbox.readStream(path, chunkSize?)) → AsyncGenerator<Buffer>`

Reads a large file in chunks. Use this instead of `read` when the file exceeds 200 KB or you need the complete binary content without truncation. Each `chunk` is already decoded (base64 decoding is handled internally).

| Parameter | Type | Description |
|---|---|---|
| `path` | `string` | File path inside the sandbox. |
| `chunkSize` | `number` | Bytes per chunk. Defaults to 65536. |

```typescript
import { createWriteStream } from 'fs';
const out = createWriteStream('large.csv');
for await (const chunk of sb.readStream('/data/large.csv')) {
  out.write(chunk);
}
```

#### `await sandbox.mkDir(path)`

Creates a directory and all parent directories. Safe to call on paths that already exist.

#### `await sandbox.listFiles(path) → FileEntry[]`

Lists the contents of a directory. Throws if the path does not exist or is not a directory.

Each `FileEntry` has: `name`, `path`, `size`, `is_dir`, `modified_at` (RFC 3339 string or `undefined`).

#### `await sandbox.stat(path) → FileInfo`

Returns metadata for a path. Unlike most operations, this does **not** throw when the path does not exist — check `info.exists` instead.

| Field | Type | Description |
|---|---|---|
| `exists` | `boolean` | `false` when the path does not exist. |
| `is_file` | `boolean` | `true` for regular files. |
| `is_dir` | `boolean` | `true` for directories. |
| `size` | `number` | File size in bytes. |
| `modified_at` | `string \| undefined` | RFC 3339 timestamp, or `undefined`. |

#### `await sandbox.exists(path) → boolean`

Returns `true` if the path exists (file or directory). A convenient shorthand for `stat` when you only need the existence check.

#### `await sandbox.uploadFile(localPath, sandboxPath, opts?)`

Uploads a file from the local filesystem into the sandbox.

| Parameter | Type | Description |
|---|---|---|
| `opts.mkdirRecursive` | `boolean` | Create parent directories on the sandbox side if they do not exist. |

#### `await sandbox.downloadFile(sandboxPath, localPath, opts?) → string | null`

Downloads a file from the sandbox to the local filesystem. Returns the absolute local path on success, or `null` when the sandbox file does not exist.

| Parameter | Type | Description |
|---|---|---|
| `opts.mkdirRecursive` | `boolean` | Create local parent directories if they do not exist. |

**Returns:** `Promise<string | null>` — `null` if the file does not exist.

#### `await sandbox.downloadFiles(entries) → Map<string, string>`

Downloads multiple files. Returns a `Map` of sandbox path → local path for each file successfully downloaded.

#### `sandbox.domain(port) → string`

Returns the publicly accessible URL for an exposed port.

```typescript
const url = sb.domain(3000); // "https://3000-preview.example.com"
```

---

### Lifecycle

#### `await sandbox.refresh(client)`

Re-fetches the sandbox metadata from the server and updates the cached info. Call this before reading `sandbox.status` or `sandbox.expireAt` if you need current values.

#### `await sandbox.stop(client, opts?)`

Pauses the sandbox without deleting it. Set `opts.blocking: true` to wait until the sandbox reaches `"stopped"` or `"failed"` status before returning.

| Parameter | Type | Description |
|---|---|---|
| `opts.blocking` | `boolean` | Poll until the sandbox has stopped. |
| `opts.pollIntervalMs` | `number` | How often to poll in milliseconds. Defaults to 2000. |
| `opts.timeoutMs` | `number` | Maximum time to wait in milliseconds. Defaults to 300000. |

#### `await sandbox.start(client)`

Resumes a stopped sandbox.

#### `await sandbox.restart(client)`

Stops and restarts the sandbox.

#### `await sandbox.extend(client, durationMs?)`

Extends the sandbox TTL by `durationMs` milliseconds. Pass `0` to use the server default (12 hours).

```typescript
// Extend by 30 minutes
await sb.extend(client, 30 * 60 * 1000);
```

#### `await sandbox.extendTimeout(client, durationMs?)`

Extends the TTL and immediately refreshes the cached info.

#### `sandbox.status → string`

Cached status string (`"active"`, `"stopped"`, etc.). Call `refresh` first for a live value.

#### `sandbox.expireAt → string`

Cached expiry timestamp in RFC 3339 format.

#### `sandbox.timeout → number`

Remaining sandbox lifetime in milliseconds based on the cached `expireAt`. Returns `0` if the sandbox has already expired. Call `refresh` first for an accurate value.

#### `await sandbox.update(client, opts)`

Updates the sandbox spec, image, or payloads. Changing payloads triggers a sandbox restart.

| Parameter | Type | Description |
|---|---|---|
| `opts.spec` | `Spec` | New resource spec. |
| `opts.image` | `string` | New container image tag. |
| `opts.payloads` | `Payload[]` | Replaces all stored payloads and triggers a restart. |

#### `await sandbox.configure(client)`

Immediately applies the current configuration to the running pod.

#### `await sandbox.delete(client)`

Permanently deletes the sandbox. This cannot be undone.

#### `sandbox.close()`

Closes the WebSocket connection. Call this when you are done with the sandbox to free the connection.

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
