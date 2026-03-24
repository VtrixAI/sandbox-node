import WebSocket from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import {
  RunOptions, ExecResult, ExecEvent, LogEvent, DetachedResult, WriteFileEntry,
  ReadResult, WriteResult, EditResult, DownloadOptions, DownloadEntry, StopOptions,
  FileEntry, FileInfo,
  SandboxInfo, RpcResponse, SandboxError, UpdateOptions, Payload,
} from './types';
import type { Client } from './client';

interface PendingCall {
  resolve: (resp: RpcResponse) => void;
  reject: (err: Error) => void;
  /** Non-null for streaming exec calls */
  onEvent?: (ev: ExecEvent | null) => void;
  /** Non-null for generic notification streaming (read_stream etc.) */
  onNotification?: (msg: RpcResponse | null) => void;
}

// ── Command object model ──────────────────────────────────

/**
 * A background command that may still be running.
 * Obtained via `sandbox.runCommand({ detached: true })` or `Sandbox.getCommand`.
 */
export class Command {
  readonly cmdId: string;
  readonly pid: number;
  readonly startedAt: Date;
  /** Working directory the command was started in (empty if not known). */
  readonly cwd: string;
  protected readonly _sandbox: Sandbox;
  protected _exitCode: number | null = null;

  constructor(sandbox: Sandbox, cmdId: string, pid = 0, startedAt?: Date, cwd = '') {
    this.cmdId = cmdId;
    this.pid = pid;
    this.startedAt = startedAt ?? new Date();
    this.cwd = cwd;
    this._sandbox = sandbox;
  }

  /**
   * Exit code of the command. `null` while the command is still running;
   * populated with the actual exit code after `wait()` resolves.
   */
  get exitCode(): number | null {
    return this._exitCode;
  }

  /** Wait for the command to finish and return its result. */
  async wait(): Promise<CommandFinished> {
    const events: (ExecEvent | null)[] = [];
    let notify: (() => void) | null = null;
    const onEvent = (ev: ExecEvent | null): void => { events.push(ev); notify?.(); };
    const callPromise = this._sandbox._call('exec_logs', { cmd_id: this.cmdId }, onEvent);

    // drain events
    while (true) {
      if (events.length > 0) {
        const ev = events.shift()!;
        if (ev === null) break;
      } else {
        await new Promise<void>((res) => { notify = res; });
        notify = null;
      }
    }

    const resp = await callPromise;
    const r = resp.result as ExecResult;
    const ec = r.exit_code ?? 0;
    // populate the live exitCode property
    this._exitCode = ec;
    return new CommandFinished(this._sandbox, this.cmdId, this.pid, this.startedAt, this.cwd, ec, r.output ?? '');
  }

  /** Stream stdout/stderr log events from the command. */
  async *logs(): AsyncGenerator<LogEvent> {
    for await (const ev of this._sandbox.execLogs(this.cmdId)) {
      if (ev.type === 'stdout' || ev.type === 'stderr') {
        yield { stream: ev.type, data: ev.data ?? '' };
      }
    }
  }

  /** Collect and return all stdout output as a string. */
  async stdout(): Promise<string> {
    return this._collectOutput('stdout');
  }

  /** Collect and return all stderr output as a string. */
  async stderr(): Promise<string> {
    return this._collectOutput('stderr');
  }

  /** Collect output from the specified stream: "stdout", "stderr", or "both". */
  async collectOutput(stream: 'stdout' | 'stderr' | 'both' = 'both'): Promise<string> {
    return this._collectOutput(stream);
  }

  /** Send a signal to the command. Defaults to SIGTERM. */
  async kill(signal = 'SIGTERM'): Promise<void> {
    await this._sandbox.kill(this.cmdId, signal);
  }

  private async _collectOutput(stream: 'stdout' | 'stderr' | 'both'): Promise<string> {
    const parts: string[] = [];
    for await (const ev of this._sandbox.execLogs(this.cmdId)) {
      if (stream === 'both' && (ev.type === 'stdout' || ev.type === 'stderr')) {
        parts.push(ev.data ?? '');
      } else if (ev.type === stream) {
        parts.push(ev.data ?? '');
      }
    }
    return parts.join('');
  }
}

/** A completed command with its exit code and combined output. */
export class CommandFinished extends Command {
  readonly output: string;

  constructor(
    sandbox: Sandbox,
    cmdId = '',
    pid = 0,
    startedAt?: Date,
    cwd = '',
    exitCode = 0,
    output = '',
  ) {
    super(sandbox, cmdId, pid, startedAt, cwd);
    this._exitCode = exitCode;
    this.output = output;
  }
}

// ── Sandbox ───────────────────────────────────────────────

export class Sandbox {
  info: SandboxInfo;  // mutable so refresh() can update it
  private readonly ws: WebSocket;
  private idGen = 0;
  private readonly pending = new Map<number, PendingCall>();
  private readonly defaultEnv: Record<string, string>;

  constructor(info: SandboxInfo, ws: WebSocket, defaultEnv: Record<string, string> = {}) {
    this.info = info;
    this.ws = ws;
    this.defaultEnv = defaultEnv;
    ws.on('message', (raw) => this._onMessage(String(raw)));
    ws.on('close', () => this._onClose());
    ws.on('error', (err) => this._onClose(err));
  }

  private _nextId(): number {
    return ++this.idGen;
  }

  private _onMessage(raw: string): void {
    let msg: RpcResponse;
    try {
      msg = JSON.parse(raw) as RpcResponse;
    } catch {
      return;
    }

    // Notification
    if (msg.method) {
      this._dispatchNotification(msg);
      return;
    }

    // Response
    if (msg.id == null) return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);

    // signal stream end before resolving
    if (p.onEvent) p.onEvent(null);
    if (p.onNotification) p.onNotification(null);

    if (msg.error) {
      p.reject(new SandboxError(msg.error.message, msg.error.code));
    } else {
      p.resolve(msg);
    }
  }

  private _dispatchNotification(msg: RpcResponse): void {
    const params = msg.params as Record<string, unknown> | undefined;
    if (!params) return;
    const targetId = Number(params['id']);
    if (!Number.isFinite(targetId)) return;

    const p = this.pending.get(targetId);
    if (!p) return;

    if (p.onEvent) {
      switch (msg.method) {
        case 'exec.start':
          p.onEvent({ type: 'start' });
          break;
        case 'exec.stdout':
          p.onEvent({ type: 'stdout', data: String(params['data'] ?? '') });
          break;
        case 'exec.stderr':
          p.onEvent({ type: 'stderr', data: String(params['data'] ?? '') });
          break;
        case 'exec.done':
          p.onEvent({ type: 'done', data: String(params['output'] ?? '') });
          break;
      }
      return;
    }

    if (p.onNotification) {
      p.onNotification(msg);
    }
  }

  private _onClose(err?: Error): void {
    for (const [, p] of this.pending) {
      if (p.onEvent) p.onEvent(null);
      if (p.onNotification) p.onNotification(null);
      p.reject(err ?? new SandboxError('WebSocket closed'));
    }
    this.pending.clear();
  }

  _call(method: string, params: unknown, onEvent?: PendingCall['onEvent'], onNotification?: PendingCall['onNotification']): Promise<RpcResponse> {
    return new Promise((resolve, reject) => {
      const id = this._nextId();
      this.pending.set(id, { resolve, reject, onEvent, onNotification });
      const req = JSON.stringify({ jsonrpc: '2.0', method, params, id });
      this.ws.send(req, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(new SandboxError(`ws send failed: ${err.message}`));
        }
      });
    });
  }

  // ── Public API ─────────────────────────────────────────

  /**
   * Run a command and return its result as a CommandFinished.
   * args are shell-quoted and appended to cmd to avoid shell injection.
   * If opts.detached is true, returns a Command immediately (background execution).
   * If opts.stdout or opts.stderr are set, output is streamed to those writables as it arrives.
   */
  async runCommand(cmd: string, args?: string[], opts?: RunOptions & { detached: true }): Promise<Command>;
  async runCommand(cmd: string, args?: string[], opts?: RunOptions & { detached?: false }): Promise<CommandFinished>;
  async runCommand(cmd: string, args?: string[], opts?: RunOptions): Promise<Command | CommandFinished> {
    if (opts?.detached) {
      const params = { ...buildExecParams(cmd, args, this.defaultEnv, opts), detached: true };
      const resp = await this._call('exec', params);
      const r = resp.result as DetachedResult;
      return new Command(this, r.cmd_id, r.pid, parseStartedAt(r.started_at), opts?.working_dir ?? '');
    }
    if (opts?.stdout || opts?.stderr) {
      return this._runCommandWithWriters(cmd, args, opts);
    }
    const resp = await this._call('exec', buildExecParams(cmd, args, this.defaultEnv, opts));
    const r = resp.result as ExecResult;
    return new CommandFinished(this, r.cmd_id ?? '', 0, parseStartedAt(r.started_at), opts?.working_dir ?? '', r.exit_code ?? 0, r.output ?? '');
  }

  private async _runCommandWithWriters(cmd: string, args: string[] | undefined, opts: RunOptions): Promise<CommandFinished> {
    const events: (ExecEvent | null)[] = [];
    let notify: (() => void) | null = null;
    const onEvent = (ev: ExecEvent | null): void => { events.push(ev); notify?.(); };
    const callPromise = this._call('exec', buildExecParams(cmd, args, this.defaultEnv, opts), onEvent);

    while (true) {
      if (events.length > 0) {
        const ev = events.shift()!;
        if (ev === null) break;
        if (ev.type === 'stdout' && opts.stdout) opts.stdout.write(ev.data ?? '');
        else if (ev.type === 'stderr' && opts.stderr) opts.stderr.write(ev.data ?? '');
      } else {
        await new Promise<void>((res) => { notify = res; });
        notify = null;
      }
    }

    const resp = await callPromise;
    const r = resp.result as ExecResult;
    return new CommandFinished(this, r.cmd_id ?? '', 0, parseStartedAt(r.started_at), opts.working_dir ?? '', r.exit_code ?? 0, r.output ?? '');
  }

  /**
   * Run a command and stream ExecEvents in real time.
   * args are shell-quoted and appended to cmd.
   */
  async *runCommandStream(cmd: string, args?: string[], opts?: RunOptions): AsyncGenerator<ExecEvent> {
    const events: (ExecEvent | null)[] = [];
    let notify: (() => void) | null = null;

    const onEvent = (ev: ExecEvent | null): void => {
      events.push(ev);
      notify?.();
    };

    const callPromise = this._call('exec', buildExecParams(cmd, args, this.defaultEnv, opts), onEvent);

    while (true) {
      if (events.length > 0) {
        const ev = events.shift()!;
        if (ev === null) break;
        yield ev;
      } else {
        await new Promise<void>((res) => { notify = res; });
        notify = null;
      }
    }

    await callPromise; // propagate errors
  }

  async read(path: string): Promise<ReadResult> {
    const resp = await this._call('read', { path });
    return resp.result as ReadResult;
  }

  async write(path: string, content: string): Promise<WriteResult> {
    const resp = await this._call('write', { path, content });
    return resp.result as WriteResult;
  }

  async edit(path: string, oldText: string, newText: string): Promise<EditResult> {
    const resp = await this._call('edit', { path, old_text: oldText, new_text: newText });
    return resp.result as EditResult;
  }

  // ── Command system ───────────────────────────────────────

  /** Reconstruct a Command from a known cmdId (e.g. after reconnect). */
  getCommand(cmdId: string): Command {
    return new Command(this, cmdId);
  }

  /** Send a signal to a running command by ID. Defaults to SIGTERM. */
  async kill(cmdId: string, signal = 'SIGTERM'): Promise<void> {
    await this._call('kill', { cmd_id: cmdId, signal });
  }

  /**
   * Attach to a running or completed command and stream its output.
   * Replays ring-buffer first, then streams live output.
   */
  async *execLogs(cmdId: string): AsyncGenerator<ExecEvent> {
    const events: (ExecEvent | null)[] = [];
    let notify: (() => void) | null = null;

    const onEvent = (ev: ExecEvent | null): void => {
      events.push(ev);
      notify?.();
    };

    const callPromise = this._call('exec_logs', { cmd_id: cmdId }, onEvent);

    while (true) {
      if (events.length > 0) {
        const ev = events.shift()!;
        if (ev === null) break;
        yield ev;
      } else {
        await new Promise<void>((res) => { notify = res; });
        notify = null;
      }
    }

    await callPromise; // propagate errors
  }

  // ── File operations ──────────────────────────────────────

  /** Write multiple files. content is raw bytes (base64-encoded over the wire).
   * If WriteFileEntry.mode is set, that Unix permission is applied after writing.
   */
  async writeFiles(files: WriteFileEntry[]): Promise<void> {
    for (const f of files) {
      const encoded = Buffer.from(f.content).toString('base64');
      const params: Record<string, unknown> = { path: f.path, data: encoded };
      if (f.mode !== undefined) params['mode'] = f.mode;
      await this._call('write_binary', params);
    }
  }

  /** Read a file and return its raw bytes. Returns null if the file does not exist. */
  async readToBuffer(path: string): Promise<Buffer | null> {
    let result: ReadResult;
    try {
      result = await this.read(path);
    } catch (e) {
      if (e instanceof SandboxError && e.code === -32001) return null; // file not found
      throw e;
    }
    if (result.type === 'image') {
      return Buffer.from(result.data ?? '', 'base64');
    }
    return Buffer.from(result.content ?? '', 'utf-8');
}

  /** Create a directory (and all parents) inside the sandbox. */
  async mkDir(path: string): Promise<void> {
    await this.runCommand(`mkdir -p ${JSON.stringify(path)}`);
  }

  /**
   * Download a file from the sandbox to a local path.
   * Returns the absolute local path of the saved file, or null if the file does not exist.
   */
  async downloadFile(sandboxPath: string, localPath: string, opts?: DownloadOptions): Promise<string | null> {
    const data = await this.readToBuffer(sandboxPath);
    if (data === null) return null;
    const abs = path.resolve(localPath);
    if (opts?.mkdirRecursive) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
    }
    fs.writeFileSync(abs, data);
    return abs;
  }

  /**
   * Download multiple files concurrently from the sandbox to local paths.
   * Returns a map of sandboxPath → absolute local path (null if file not found).
   * Rejects on first error.
   */
  async downloadFiles(files: DownloadEntry[], opts?: DownloadOptions): Promise<Map<string, string | null>> {
    const results = await Promise.all(
      files.map(async (f) => {
        const localPath = await this.downloadFile(f.sandboxPath, f.localPath, opts);
        return [f.sandboxPath, localPath] as const;
      }),
    );
    return new Map(results);
  }

  /** Return the publicly accessible URL for the given port on this sandbox. */
  domain(port: number): string {
    if (this.info.preview_host) {
      return `https://${port}-${this.info.preview_host}`;
    }
    return this.info.preview_url;
  }

  /**
   * Upload a local file into the sandbox at sandboxPath.
   * If opts.mkdirRecursive is true, parent directories are created in the sandbox first.
   */
  async uploadFile(localPath: string, sandboxPath: string, opts?: DownloadOptions): Promise<void> {
    const data = fs.readFileSync(localPath);
    if (opts?.mkdirRecursive) {
      await this.mkDir(path.posix.dirname(sandboxPath));
    }
    const encoded = Buffer.from(data).toString('base64');
    await this._call('write_binary', { path: sandboxPath, data: encoded });
  }

  /** List the contents of a directory inside the sandbox. */
  async listFiles(dirPath: string): Promise<FileEntry[]> {
    const resp = await this._call('list_files', { path: dirPath });
    return resp.result as FileEntry[];
  }

  /**
   * Return metadata about a file or directory inside the sandbox.
   * FileInfo.exists will be false if the path does not exist (no error raised).
   */
  async stat(filePath: string): Promise<FileInfo> {
    const resp = await this._call('stat', { path: filePath });
    return resp.result as FileInfo;
  }

  /** Report whether the given path exists inside the sandbox. */
  async exists(filePath: string): Promise<boolean> {
    const info = await this.stat(filePath);
    return info.exists;
  }

  /**
   * Stream a file in chunks, yielding decoded Buffer per chunk.
   * Useful for large files. chunkSize defaults to 64KB.
   */
  async *readStream(filePath: string, chunkSize = 65536): AsyncGenerator<Buffer> {
    const notifications: (RpcResponse | null)[] = [];
    let notify: (() => void) | null = null;

    const onNotification = (msg: RpcResponse | null): void => {
      notifications.push(msg);
      notify?.();
    };

    const callPromise = this._call('read_stream', { path: filePath, chunk_size: chunkSize }, undefined, onNotification);

    while (true) {
      if (notifications.length > 0) {
        const msg = notifications.shift()!;
        if (msg === null) break;
        if (msg.method === 'read_stream.chunk') {
          const params = msg.params as Record<string, unknown> | undefined;
          const data = String(params?.['data'] ?? '');
          if (data) yield Buffer.from(data, 'base64');
        }
      } else {
        await new Promise<void>((res) => { notify = res; });
        notify = null;
      }
    }

    await callPromise; // propagate errors
  }

  close(): void {
    this.ws.close();
  }

  // ── Lifecycle (require a Client instance) ───────────────

  /** Re-fetch metadata from Atlas and update this.info. */
  async refresh(client: Client): Promise<void> {
    this.info = await client.get(this.info.id);
  }

  async stop(client: Client, opts?: StopOptions): Promise<void> {
    await client._doPost(`/api/v1/sandbox/${this.info.id}/stop`);
    if (!opts?.blocking) return;

    const interval = opts.pollIntervalMs ?? 2000;
    const deadline = opts.timeoutMs ?? 300_000;
    const start = Date.now();

    while (Date.now() - start < deadline) {
      await new Promise<void>((res) => setTimeout(res, interval));
      this.info = await client.get(this.info.id);
      if (this.info.status === 'stopped' || this.info.status === 'failed') return;
    }
    throw new SandboxError(`stop timeout: sandbox ${this.info.id} did not reach stopped state`);
  }

  async start(client: Client): Promise<void> {
    await client._doPost(`/api/v1/sandbox/${this.info.id}/start`);
  }

  async restart(client: Client): Promise<void> {
    await client._doPost(`/api/v1/sandbox/${this.info.id}/restart`);
  }

  /** Extend TTL by durationMs milliseconds. Pass 0 to use the server default (12h). */
  async extend(client: Client, durationMs = 0): Promise<void> {
    const hours = Math.floor(durationMs / 3_600_000);
    await client._doPost(`/api/v1/sandbox/${this.info.id}/extend`, { hours });
  }

  /** Extend TTL by durationMs milliseconds and refresh info. Pass 0 to use the server default (12h). */
  async extendTimeout(client: Client, durationMs = 0): Promise<void> {
    await this.extend(client, durationMs);
    await this.refresh(client);
  }

  /** Current status from cached info (call refresh() first for live data). */
  get status(): string { return this.info.status; }

  /** Sandbox creation time parsed from cached info.created_at. Returns a new Date each call. */
  get createdAt(): Date { return new Date(this.info.created_at); }

  /** Sandbox expiry time from cached info (RFC3339). */
  get expireAt(): string { return this.info.expire_at; }

  /**
   * Remaining sandbox lifetime in milliseconds based on cached info.expire_at.
   * Returns 0 if expire_at is empty or already past. Call refresh() first for live data.
   */
  get timeout(): number {
    if (!this.info.expire_at) return 0;
    const ms = new Date(this.info.expire_at).getTime() - Date.now();
    return ms > 0 ? ms : 0;
  }

  async update(client: Client, opts: UpdateOptions): Promise<void> {
    const body: Record<string, unknown> = {};
    if (opts.spec)     body['spec']     = opts.spec;
    if (opts.image)    body['image']    = opts.image;
    if (opts.payloads) body['payloads'] = opts.payloads;
    await client._doPatch(`/api/v1/sandbox/${this.info.id}`, body);
  }

  async configure(client: Client, payloads?: Payload[]): Promise<void> {
    const body = payloads ? { payloads } : undefined;
    await client._doPost(`/api/v1/sandbox/${this.info.id}/configure`, body);
  }

  async delete(client: Client): Promise<void> {
    await client.delete(this.info.id);
  }
}

function buildExecParams(cmd: string, args: string[] | undefined, defaultEnv: Record<string, string>, opts?: RunOptions): Record<string, unknown> {
  // Append shell-quoted args to the command string if provided.
  if (args && args.length > 0) {
    cmd = cmd + ' ' + args.map(shellQuote).join(' ');
  }
  const params: Record<string, unknown> = { command: cmd };
  const merged = { ...defaultEnv, ...(opts?.env ?? {}) };
  if (Object.keys(merged).length > 0) params['env'] = merged;
  if (opts?.working_dir) params['working_dir'] = opts.working_dir;
  if (opts?.timeout_sec) params['timeout'] = opts.timeout_sec;
  if (opts?.sudo) params['sudo'] = true;
  if (opts?.stdin) params['stdin'] = opts.stdin;
  return params;
}

/** Return a single-quoted shell-safe version of s. */
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Parse an RFC3339 string from the server into a Date.
 * Falls back to the current time when the string is empty or invalid.
 */
function parseStartedAt(s?: string): Date {
  if (!s) return new Date();
  const d = new Date(s);
  return isNaN(d.getTime()) ? new Date() : d;
}
