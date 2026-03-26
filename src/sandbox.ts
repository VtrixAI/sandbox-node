import WebSocket from 'ws';
import {
  RunOptions, ExecEvent, WriteFileEntry,
  ReadResult, WriteResult, EditResult, FileOptions, DownloadEntry,
  FileEntry, FileInfo, StopOptions, UpdateOptions, Payload,
  RpcResponse, SandboxInfo, SandboxError,
} from './types';
import type { Client } from './client';
import { Command, CommandFinished, PendingCall } from './command';
import * as Exec from './exec';
import * as Files from './files';
import * as Lifecycle from './lifecycle';

export { Command, CommandFinished };

// ── Sandbox ───────────────────────────────────────────────

export class Sandbox {
  info: SandboxInfo;  // mutable so refresh() can update it
  /** @internal used by lifecycle.ts */
  readonly _client: Client;
  /** @internal used by lifecycle.ts */
  readonly _ws: WebSocket;
  private idGen = 0;
  private readonly pending = new Map<number, PendingCall>();
  /** @internal used by exec.ts */
  readonly defaultEnv: Record<string, string>;

  constructor(info: SandboxInfo, ws: WebSocket, client: Client, defaultEnv: Record<string, string> = {}) {
    this.info = info;
    this._client = client;
    this._ws = ws;
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

  /** @internal used by exec.ts, files.ts, command.ts */
  _call(method: string, params: unknown, onEvent?: PendingCall['onEvent'], onNotification?: PendingCall['onNotification']): Promise<RpcResponse> {
    return new Promise((resolve, reject) => {
      const id = this._nextId();
      this.pending.set(id, { resolve, reject, onEvent, onNotification });
      const req = JSON.stringify({ jsonrpc: '2.0', method, params, id });
      this._ws.send(req, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(new SandboxError(`ws send failed: ${err.message}`));
        }
      });
    });
  }

  // ── Exec delegation ───────────────────────────────────────

  async runCommand(cmd: string, args?: string[], opts?: RunOptions): Promise<CommandFinished> {
    return Exec.runCommand(this, cmd, args, opts);
  }

  async runCommandDetached(cmd: string, args?: string[], opts?: RunOptions): Promise<Command> {
    return Exec.runCommandDetached(this, cmd, args, opts);
  }

  async *runCommandStream(cmd: string, args?: string[], opts?: RunOptions): AsyncGenerator<ExecEvent> {
    yield* Exec.runCommandStream(this, cmd, args, opts);
  }

  getCommand(cmdId: string): Command {
    return Exec.getCommand(this, cmdId);
  }

  async kill(cmdId: string, signal = 'SIGTERM'): Promise<void> {
    return Exec.kill(this, cmdId, signal);
  }

  async *execLogs(cmdId: string): AsyncGenerator<ExecEvent> {
    yield* Exec.execLogs(this, cmdId);
  }

  // ── File delegation ───────────────────────────────────────

  async read(filePath: string): Promise<ReadResult> {
    return Files.read(this, filePath);
  }

  async write(filePath: string, content: string): Promise<WriteResult> {
    return Files.write(this, filePath, content);
  }

  async edit(filePath: string, oldText: string, newText: string): Promise<EditResult> {
    return Files.edit(this, filePath, oldText, newText);
  }

  async writeFiles(files: WriteFileEntry[]): Promise<void> {
    return Files.writeFiles(this, files);
  }

  async readToBuffer(filePath: string): Promise<Buffer | null> {
    return Files.readToBuffer(this, filePath);
  }

  async mkDir(dirPath: string): Promise<void> {
    return Files.mkDir(this, dirPath);
  }

  async downloadFile(sandboxPath: string, localPath: string, opts?: FileOptions): Promise<string | null> {
    return Files.downloadFile(this, sandboxPath, localPath, opts);
  }

  async downloadFiles(files: DownloadEntry[], opts?: FileOptions): Promise<Map<string, string | null>> {
    return Files.downloadFiles(this, files, opts);
  }

  async uploadFile(localPath: string, sandboxPath: string, opts?: FileOptions): Promise<void> {
    return Files.uploadFile(this, localPath, sandboxPath, opts);
  }

  async listFiles(dirPath: string): Promise<FileEntry[]> {
    return Files.listFiles(this, dirPath);
  }

  async stat(filePath: string): Promise<FileInfo> {
    return Files.stat(this, filePath);
  }

  async exists(filePath: string): Promise<boolean> {
    return Files.exists(this, filePath);
  }

  async *readStream(filePath: string, chunkSize = 65536): AsyncGenerator<Buffer> {
    yield* Files.readStream(this, filePath, chunkSize);
  }

  domain(port: number): string {
    return Files.domain(this, port);
  }

  // ── Lifecycle delegation ──────────────────────────────────

  async refresh(): Promise<void> {
    return Lifecycle.refresh(this);
  }

  async stop(opts?: StopOptions): Promise<void> {
    return Lifecycle.stop(this, opts);
  }

  async start(): Promise<void> {
    return Lifecycle.start(this);
  }

  async restart(): Promise<void> {
    return Lifecycle.restart(this);
  }

  async extend(hours = 0): Promise<void> {
    return Lifecycle.extend(this, hours);
  }

  async extendTimeout(hours = 0): Promise<void> {
    return Lifecycle.extendTimeout(this, hours);
  }

  get status(): string { return this.info.status; }

  get createdAt(): Date { return new Date(this.info.created_at); }

  get expireAt(): string { return this.info.expire_at; }

  get timeout(): number {
    if (!this.info.expire_at) return 0;
    const ms = new Date(this.info.expire_at).getTime() - Date.now();
    return ms > 0 ? ms : 0;
  }

  async update(opts: UpdateOptions): Promise<void> {
    return Lifecycle.update(this, opts);
  }

  async configure(payloads?: Payload[]): Promise<void> {
    return Lifecycle.configure(this, payloads);
  }

  async delete(): Promise<void> {
    return Lifecycle.deleteSandbox(this);
  }

  close(): void {
    Lifecycle.close(this);
  }
}
