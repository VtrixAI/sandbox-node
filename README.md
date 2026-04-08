# @vtrixai/sandbox

Node.js / TypeScript SDK for [Vtrix](https://github.com/VtrixAI) sandbox — run commands, manage files, and operate sandbox instances in isolated Linux environments via the hermes gateway.

## Installation

```bash
npm install @vtrixai/sandbox
```

**Requires Node.js 18+**

## Quick Start

```typescript
import { Sandbox } from '@vtrixai/sandbox';

const sb = await Sandbox.create({
  apiKey:  'your-api-key',
  baseUrl: 'http://your-hermes-host:8080',
});

const result = await sb.commands.run('echo hello');
console.log(result.stdout);

await sb.kill();
```

## Configuration

API key and base URL are resolved in order:

1. Explicit option (`apiKey`, `baseUrl`)
2. Environment variables: `SANDBOX_API_KEY`, `SANDBOX_BASE_URL`
3. Default base URL: `https://api.sandbox.vtrix.ai`

---

## Sandbox lifecycle

### `Sandbox.create(opts?) → Promise<Sandbox>`

Create a new sandbox.

```typescript
const sb = await Sandbox.create({
  apiKey:    'your-api-key',
  baseUrl:   'http://your-hermes-host:8080',
  template:  'base',
  timeout:   300,
  metadata:  { env: 'dev' },
  envs:      { NODE_ENV: 'production' },
});
```

| Field | Type | Description |
|---|---|---|
| `apiKey` | `string` | API key sent as `X-API-Key`. |
| `baseUrl` | `string` | Hermes gateway URL. |
| `template` | `string` | Template ID. Defaults to `"base"`. |
| `timeout` | `number` | Sandbox lifetime in seconds. Defaults to `300`. |
| `metadata` | `Record<string, string>` | Arbitrary key-value labels. |
| `envs` | `Record<string, string>` | Environment variables injected into every command. |

### `Sandbox.connect(sandboxId, opts?) → Promise<Sandbox>`

Connect to an existing sandbox, resuming it if paused.

```typescript
const sb = await Sandbox.connect('sandbox-id', { apiKey: 'your-api-key' });
```

### `Sandbox.list(opts?) → Promise<SandboxInfo[]>`

Return all sandboxes visible to the given API key.

### `sb.kill() → Promise<boolean>` / `Sandbox.kill(sandboxId, opts?)`

Terminate a sandbox. The static overload operates without a `Sandbox` instance.

### `sb.setTimeout(timeoutSeconds: number) → Promise<void>`

Update the sandbox lifetime.

### `sb.getInfo() → Promise<SandboxInfo>`

Fetch current metadata.

```typescript
const info = await sb.getInfo();
console.log(info.state); // "running", "paused", ...
```

### `sb.isRunning() → Promise<boolean>`

Return `true` if the sandbox state is `"running"` or `"active"`.

### `sb.getHost(port: number) → string`

Return the proxy hostname for a port inside the sandbox.

```typescript
const host = sb.getHost(3000); // "3000-<sandboxId>.<domain>"
```

### `sb.sandboxDomain → string`

The domain portion of the configured base URL.

### `sb.getMetrics() → Promise<{ cpuUsedPct: number; memUsedMiB: number }>`

Fetch current CPU and memory utilization.

```typescript
const m = await sb.getMetrics();
console.log(`CPU ${m.cpuUsedPct.toFixed(1)}%  Mem ${m.memUsedMiB.toFixed(0)} MiB`);
```

### `sb.resizeDisk(sizeMb: number) → Promise<void>`

Expand the sandbox disk. Atlas performs an in-place PVC resize — the sandbox does not restart.

```typescript
await sb.resizeDisk(20 * 1024); // 20 GiB
```

### `sb.betaPause() → Promise<void>`

Pause (snapshot) the sandbox. Resume later with `Sandbox.connect()`.

### `sb.downloadUrl(path, opts?) → Promise<string>`

Return a short-lived signed URL for downloading a file directly from the sandbox.

### `sb.uploadUrl(path, opts?) → Promise<string>`

Return a short-lived signed URL for uploading a file directly into the sandbox.

---

## Commands

`sb.commands` exposes all process-management operations.

### `commands.run(cmd, opts?) → Promise<CommandResult>`

Run a command and block until it finishes. Throws `CommandExitError` if the exit code is non-zero.

```typescript
const result = await sb.commands.run('npm install', {
  workingDir: '/app',
  timeoutMs:  60_000,
  envs:       { NODE_ENV: 'production' },
  onStdout:   (s) => process.stdout.write(s),
});
console.log(result.stdout);
```

Options (`CommandStartOpts`):

| Field | Type | Description |
|---|---|---|
| `workingDir` | `string` | Working directory inside the sandbox. |
| `timeoutMs` | `number` | Kill the process after this many milliseconds. `0` = no timeout. |
| `envs` | `Record<string, string>` | Additional environment variables. |
| `onStdout` | `(s: string) => void` | Called for each stdout chunk. |
| `onStderr` | `(s: string) => void` | Called for each stderr chunk. |

### `commands.runBackground(cmd, opts?) → Promise<CommandHandle>`

Start a command in the background and return a handle immediately. The SSE stream is kept open internally so the nano-executor registry stays alive.

```typescript
const handle = await sb.commands.runBackground('node server.js', { workingDir: '/app' });
// ... do other work ...
const result = await handle.wait();
```

### `CommandHandle`

| Method | Description |
|---|---|
| `wait(opts?) → Promise<CommandResult>` | Block until the process finishes. Throws `CommandExitError` on non-zero exit. |
| `kill() → Promise<boolean>` | Send SIGKILL. |
| `sendStdin(data: string) → Promise<void>` | Write data to stdin. |
| `pid → number` | Process ID inside the sandbox. |

### `commands.connect(pid, opts?) → Promise<CommandHandle>`

Attach to a running process by PID.

### `commands.list(opts?) → Promise<ProcessInfo[]>`

List all running processes.

### `commands.kill(pid, opts?) → Promise<boolean>`

Send SIGKILL to a process by PID.

### `commands.killByTag(tag, opts?) → Promise<boolean>`

Send SIGKILL to a process by tag.

### `commands.sendSignal(pid, signal, opts?) → Promise<void>`

Send an arbitrary signal (`"SIGTERM"`, `"SIGINT"`, etc.).

### `commands.sendStdin(pid, data, opts?) → Promise<void>`

Write to a process's stdin.

### `commands.closeStdin(pid, opts?) → Promise<void>`

Close stdin (EOF).

`CommandResult` fields: `stdout: string`, `stderr: string`, `exitCode: number`.

---

## Filesystem

`sb.files` exposes all filesystem operations.

### Read

```typescript
const data   = await sb.files.read('/app/config.json');      // Uint8Array
const text   = await sb.files.readText('/app/config.json');  // string
const stream = await sb.files.readStream('/app/large.csv');  // ReadableStream<Uint8Array>
```

### Write

```typescript
const info = await sb.files.write('/app/out.bin', data);
const info = await sb.files.writeText('/app/config.json', '{"port":8080}');
await sb.files.writeFiles([
  { path: '/app/run.sh', content: scriptBytes, mode: 0o755 },
]);
```

### Directory operations

```typescript
const entries = await sb.files.list('/app');                // EntryInfo[]
const ok      = await sb.files.makeDir('/app/logs');        // boolean
const exists  = await sb.files.exists('/app/config.json');  // boolean
const info    = await sb.files.getInfo('/app/config.json'); // EntryInfo
```

`EntryInfo` fields: `name`, `path`, `type` (`"file"` / `"dir"` / `"symlink"`), `size`, `modifiedAt`, `symlinkTarget`.

### Mutation

```typescript
await sb.files.edit('/app/config.json', '"port": 3000', '"port": 8080');
await sb.files.remove('/app/old.log');
const info = await sb.files.rename('/app/old.txt', '/app/new.txt');
```

### Watch

```typescript
const handle = await sb.files.watchDir('/app', (ev) => {
  console.log(ev.operation, ev.path);
});
// ... do work ...
handle.stop();
```

---

## PTY

`sb.pty` provides interactive terminal sessions.

```typescript
const handle = await sb.pty.create({ rows: 24, cols: 80 });
await sb.pty.resize(handle.pid, { rows: 40, cols: 200 });
await sb.pty.sendInput(handle.pid, 'ls -la\n');
const result = await handle.wait();
console.log(result.stdout);
await sb.pty.kill(handle.pid);
```

---

## Examples

| File | Description |
|---|---|
| [`examples/quickstart.ts`](examples/quickstart.ts) | Create sandbox, run commands |
| [`examples/background_commands.ts`](examples/background_commands.ts) | Background processes |
| [`examples/filesystem.ts`](examples/filesystem.ts) | Read, write, list, watch files |
| [`examples/pty.ts`](examples/pty.ts) | PTY create, resize, input |
| [`examples/sandbox_management.ts`](examples/sandbox_management.ts) | Lifecycle, metrics, disk resize |

```bash
npx tsx examples/quickstart.ts
```

## License

MIT — see [LICENSE](LICENSE).
