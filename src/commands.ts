import { parseAPIError, CommandExitError } from './errors.js';
import type {
  CommandConnectOpts,
  CommandRequestOpts,
  CommandResult,
  CommandStartOpts,
  ConnectionConfig,
  ProcessInfo,
  PtyCreateOpts,
} from './types.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse Server-Sent Events from a streaming fetch Response body.
 * Yields parsed JSON objects for every `data:` line received.
 */
async function* parseSSE(
  response: Response
): AsyncGenerator<Record<string, unknown>> {
  if (!response.body) throw new Error('No response body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      const dataLine = part.split('\n').find((l) => l.startsWith('data: '));
      if (dataLine) {
        try {
          yield JSON.parse(dataLine.slice(6)) as Record<string, unknown>;
        } catch {
          // skip malformed events
        }
      }
    }
  }
}

/**
 * Perform a Connect-RPC call (unary) against the envd service.
 */
async function connectRPC(
  envdUrl: string,
  method: string,
  body: unknown,
  headers: Record<string, string>,
  signal?: AbortSignal
): Promise<unknown> {
  const res = await fetch(`${envdUrl}/${method}`, {
    method: 'POST',
    headers: {
      'Connect-Protocol-Version': '1',
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { code?: number; message?: string };
    throw parseAPIError(res.status, err);
  }
  return res.json();
}

// Decode base64 to UTF-8 string
function decodeBase64(b64: string): string {
  return Buffer.from(b64, 'base64').toString('utf8');
}

// Encode string to base64
function encodeBase64(str: string): string {
  return Buffer.from(str).toString('base64');
}

// Encode Uint8Array to base64
function encodeBase64Bytes(data: Uint8Array): string {
  return Buffer.from(data).toString('base64');
}

// ---------------------------------------------------------------------------
// CommandHandle
// ---------------------------------------------------------------------------

export class CommandHandle {
  readonly pid: number;

  // Internal: the SSE generator for ongoing streaming
  private _sseGen: AsyncGenerator<Record<string, unknown>> | null;
  private _abortController: AbortController;
  private _config: ConnectionConfig;

  constructor(
    pid: number,
    sseGen: AsyncGenerator<Record<string, unknown>> | null,
    abortController: AbortController,
    config: ConnectionConfig
  ) {
    this.pid = pid;
    this._sseGen = sseGen;
    this._abortController = abortController;
    this._config = config;
  }

  /**
   * Wait for the process to finish, consuming remaining SSE events.
   * Calls onStdout/onStderr for each output chunk received.
   */
  async wait(opts?: {
    onStdout?: (d: string) => void | Promise<void>;
    onStderr?: (d: string) => void | Promise<void>;
  }): Promise<CommandResult> {
    if (!this._sseGen) {
      // Re-connect to get remaining output
      const gen = await connectToProcessSSE(
        this._config,
        this.pid,
        opts?.onStdout,
        opts?.onStderr,
        this._abortController.signal
      );
      return throwIfNonZero(await consumeSSEUntilEnd(gen, opts?.onStdout, opts?.onStderr));
    }
    return throwIfNonZero(await consumeSSEUntilEnd(this._sseGen, opts?.onStdout, opts?.onStderr));
  }

  /** Send SIGKILL to the process. */
  async kill(): Promise<boolean> {
    const headers: Record<string, string> = {
      'Connect-Protocol-Version': '1',
      'Content-Type': 'application/json',
    };
    if (this._config.accessToken) {
      headers['X-Access-Token'] = this._config.accessToken;
    } else if (this._config.apiKey) {
      headers['X-API-Key'] = this._config.apiKey;
    }
    try {
      await connectRPC(
        this._config.envdUrl,
        'process.Process/SendSignal',
        { process: { pid: this.pid }, signal: 'SIGKILL' },
        headers
      );
      return true;
    } catch {
      return false;
    }
  }

  /** Send data to the process's stdin. */
  async sendStdin(data: string): Promise<void> {
    const headers: Record<string, string> = {
      'Connect-Protocol-Version': '1',
      'Content-Type': 'application/json',
    };
    if (this._config.accessToken) {
      headers['X-Access-Token'] = this._config.accessToken;
    } else if (this._config.apiKey) {
      headers['X-API-Key'] = this._config.apiKey;
    }
    await connectRPC(
      this._config.envdUrl,
      'process.Process/SendInput',
      { process: { pid: this.pid }, input: { stdin: encodeBase64(data) } },
      headers
    );
  }

  /** Abort the SSE stream without killing the process. */
  disconnect(): void {
    this._abortController.abort();
  }
}

// ---------------------------------------------------------------------------
// Internal SSE helpers for process streaming
// ---------------------------------------------------------------------------

async function connectToProcessSSE(
  config: ConnectionConfig,
  pid: number,
  onStdout?: (d: string) => void | Promise<void>,
  onStderr?: (d: string) => void | Promise<void>,
  signal?: AbortSignal
): Promise<AsyncGenerator<Record<string, unknown>>> {
  const headers: Record<string, string> = {
    'Connect-Protocol-Version': '1',
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
  };
  if (config.accessToken) headers['X-Access-Token'] = config.accessToken;
  else if (config.apiKey) headers['X-API-Key'] = config.apiKey;

  const res = await fetch(`${config.envdUrl}/process.Process/Connect`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ process: { pid } }),
    signal,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { code?: number; message?: string };
    throw parseAPIError(res.status, err);
  }

  return parseSSE(res);
}

async function consumeSSEUntilEnd(
  gen: AsyncGenerator<Record<string, unknown>>,
  onStdout?: (d: string) => void | Promise<void>,
  onStderr?: (d: string) => void | Promise<void>
): Promise<CommandResult> {
  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  let error: string | undefined;

  for await (const raw of gen) {
    // Wire format: {"event": {"start":{}, "data":{stdout,stderr,pty}, "end":{status}, "keepalive":{}}}
    const event = (raw['event'] ?? {}) as Record<string, unknown>;

    if (event['data'] != null) {
      const data = event['data'] as Record<string, unknown>;
      const rawOut = (data['stdout'] as string | undefined) ?? '';
      const rawPty = (data['pty'] as string | undefined) ?? '';
      const rawErr = (data['stderr'] as string | undefined) ?? '';
      if (rawOut) { const d = decodeBase64(rawOut); stdout += d; await onStdout?.(d); }
      if (rawPty) { const d = decodeBase64(rawPty); stdout += d; await onStdout?.(d); }
      if (rawErr) { const d = decodeBase64(rawErr); stderr += d; await onStderr?.(d); }
    }

    if (event['end'] != null) {
      const end = event['end'] as Record<string, unknown>;
      const status = (end['status'] as string | undefined) ?? '';
      exitCode = parseExitCode(status);
      error = end['error'] as string | undefined;
      break;
    }
  }

  return { stdout, stderr, exitCode, error };
}

function throwIfNonZero(result: CommandResult): CommandResult {
  if (result.exitCode !== 0) {
    throw new CommandExitError(result.exitCode, result.stdout, result.stderr);
  }
  return result;
}

function parseExitCode(status: string): number {
  if (!status || status === 'exit status 0') return 0;
  const parts = status.split(' ');
  const last = parts[parts.length - 1];
  const n = parseInt(last, 10);
  return isNaN(n) ? 1 : n;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export class Commands {
  constructor(private config: ConnectionConfig) {}

  private get rpcHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      'Connect-Protocol-Version': '1',
      'Content-Type': 'application/json',
    };
    if (this.config.accessToken) h['X-Access-Token'] = this.config.accessToken;
    else if (this.config.apiKey) h['X-API-Key'] = this.config.apiKey;
    return h;
  }

  private get sseHeaders(): Record<string, string> {
    return { ...this.rpcHeaders, 'Accept': 'text/event-stream' };
  }

  private abortSignal(requestTimeoutMs?: number): AbortSignal {
    const ms = requestTimeoutMs ?? this.config.requestTimeoutMs;
    return AbortSignal.timeout(ms);
  }

  /** Connect to an already-running process and stream its output. */
  async connect(pid: number, opts?: CommandConnectOpts): Promise<CommandHandle> {
    const ac = new AbortController();
    if (opts?.timeoutMs) setTimeout(() => ac.abort(), opts.timeoutMs);

    const gen = await connectToProcessSSE(
      this.config,
      pid,
      opts?.onStdout,
      opts?.onStderr,
      ac.signal
    );

    // Start streaming in background
    const handle = new CommandHandle(pid, gen, ac, this.config);

    // Drain events in background, notifying callbacks
    (async () => {
      try {
        for await (const raw of gen) {
          const event = (raw['event'] ?? {}) as Record<string, unknown>;
          if (event['data'] != null) {
            const data = event['data'] as Record<string, unknown>;
            const rawOut = (data['stdout'] as string | undefined) ?? '';
            const rawPty = (data['pty'] as string | undefined) ?? '';
            const rawErr = (data['stderr'] as string | undefined) ?? '';
            if (rawOut) { const d = decodeBase64(rawOut); if (d) await opts?.onStdout?.(d); }
            if (rawPty) { const d = decodeBase64(rawPty); if (d) await opts?.onStdout?.(d); }
            if (rawErr) { const d = decodeBase64(rawErr); if (d) await opts?.onStderr?.(d); }
          }
        }
      } catch {
        // stream ended or aborted — expected
      }
    })();

    return handle;
  }

  /** Kill a process by PID using SIGKILL. */
  async kill(pid: number, opts?: CommandRequestOpts): Promise<boolean> {
    try {
      await connectRPC(
        this.config.envdUrl,
        'process.Process/SendSignal',
        { process: { pid }, signal: 'SIGKILL' },
        this.rpcHeaders,
        this.abortSignal(opts?.requestTimeoutMs)
      );
      return true;
    } catch {
      return false;
    }
  }

  /** List running processes. */
  async list(opts?: CommandRequestOpts): Promise<ProcessInfo[]> {
    const raw = await connectRPC(
      this.config.envdUrl,
      'process.Process/List',
      {},
      this.rpcHeaders,
      this.abortSignal(opts?.requestTimeoutMs)
    ) as { processes?: Record<string, unknown>[] };

    return (raw.processes ?? []).map((p) => {
      const cfg = (p['config'] ?? {}) as Record<string, unknown>;
      return {
        pid: Number(p['pid'] ?? 0),
        cmd: cfg['cmd'] as string ?? '',
        args: (cfg['args'] as string[] | undefined) ?? [],
        cwd: cfg['cwd'] as string | undefined,
        envs: (cfg['envs'] as Record<string, string> | undefined) ?? {},
        tag: p['tag'] as string | undefined,
      };
    });
  }

  /** Run a command and wait for it to finish. */
  async run(
    cmd: string,
    opts?: CommandStartOpts & { background?: false }
  ): Promise<CommandResult>;
  /** Run a command in the background, return a handle immediately after start. */
  async run(
    cmd: string,
    opts: CommandStartOpts & { background: true }
  ): Promise<CommandHandle>;
  async run(
    cmd: string,
    opts?: CommandStartOpts
  ): Promise<CommandResult | CommandHandle>;
  async run(
    cmd: string,
    opts?: CommandStartOpts
  ): Promise<CommandResult | CommandHandle> {
    const background = opts?.background ?? false;
    const ac = new AbortController();
    if (opts?.timeoutMs) setTimeout(() => ac.abort(), opts.timeoutMs);

    const process_: Record<string, unknown> = {
      cmd: '/bin/bash',
      args: ['-c', cmd],
    };
    if (opts?.envs) process_['envs'] = opts.envs;
    if (opts?.cwd) process_['cwd'] = opts.cwd;
    if (opts?.user) process_['user'] = opts.user;

    const body: Record<string, unknown> = { process: process_ };
    if (opts?.timeoutMs != null && opts.timeoutMs !== 0) body['timeout'] = Math.floor(opts.timeoutMs / 1000);

    const res = await fetch(
      `${this.config.envdUrl}/process.Process/Start`,
      {
        method: 'POST',
        headers: this.sseHeaders,
        body: JSON.stringify(body),
        signal: ac.signal,
      }
    );

    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { code?: number; message?: string };
      throw parseAPIError(res.status, err);
    }

    const gen = parseSSE(res);

    // Wait for the 'start' event to get the PID.
    // Use gen.next() directly to avoid for-await-break calling gen.return(),
    // which would close the generator and prevent subsequent reads.
    let pid = 0;
    while (true) {
      const step = await gen.next();
      if (step.done) break;
      const raw = step.value;
      const event = (raw['event'] ?? {}) as Record<string, unknown>;
      if (event['start'] != null) {
        const start = event['start'] as Record<string, unknown>;
        pid = Number(start['pid'] ?? 0);
        break;
      }
    }

    if (background) {
      // Pass null for sseGen so handle.wait() uses re-connect instead of
      // the original gen (which the drainer below is consuming).
      const handle = new CommandHandle(pid, null, ac, this.config);

      // Drain events in background, delivering callbacks only.
      // wait() will re-connect independently when called.
      (async () => {
        try {
          for await (const raw of gen) {
            const event = (raw['event'] ?? {}) as Record<string, unknown>;
            if (event['data'] != null) {
              const data = event['data'] as Record<string, unknown>;
              const rawOut = (data['stdout'] as string | undefined) ?? '';
              const rawPty = (data['pty'] as string | undefined) ?? '';
              const rawErr = (data['stderr'] as string | undefined) ?? '';
              if (rawOut) { const d = decodeBase64(rawOut); if (d) await opts?.onStdout?.(d); }
              if (rawPty) { const d = decodeBase64(rawPty); if (d) await opts?.onStdout?.(d); }
              if (rawErr) { const d = decodeBase64(rawErr); if (d) await opts?.onStderr?.(d); }
            }
          }
        } catch {
          // stream ended or aborted
        }
      })();

      return handle;
    }

    // Foreground: wait for 'end' event
    try {
      const result = await consumeSSEUntilEnd(gen, opts?.onStdout, opts?.onStderr);
      return throwIfNonZero(result);
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        // Process was aborted by timeoutMs — return non-zero exit code
        return { stdout: '', stderr: '', exitCode: -1, error: 'aborted' };
      }
      throw err;
    }
  }

  /** Send data to a process's stdin. */
  async sendStdin(pid: number, data: string, opts?: CommandRequestOpts): Promise<void> {
    await connectRPC(
      this.config.envdUrl,
      'process.Process/SendInput',
      {
        process: { pid },
        input: { stdin: encodeBase64(data) },
      },
      this.rpcHeaders,
      this.abortSignal(opts?.requestTimeoutMs)
    );
  }

  /** Close stdin of a process (triggers EOF). */
  async closeStdin(pid: number, opts?: CommandRequestOpts): Promise<void> {
    await connectRPC(
      this.config.envdUrl,
      'process.Process/CloseStdin',
      { process: { pid } },
      this.rpcHeaders,
      this.abortSignal(opts?.requestTimeoutMs)
    );
  }

  /** Send a signal to a process by PID. */
  async sendSignal(pid: number, signal: string, opts?: CommandRequestOpts): Promise<void> {
    await connectRPC(
      this.config.envdUrl,
      'process.Process/SendSignal',
      { process: { pid }, signal },
      this.rpcHeaders,
      this.abortSignal(opts?.requestTimeoutMs)
    );
  }

  /** Connect to an already-running process by tag and stream its output. */
  async connectByTag(tag: string, opts?: CommandConnectOpts): Promise<CommandHandle> {
    const ac = new AbortController();
    if (opts?.timeoutMs) setTimeout(() => ac.abort(), opts.timeoutMs);

    const headers: Record<string, string> = {
      'Connect-Protocol-Version': '1',
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
    };
    if (this.config.accessToken) headers['X-Access-Token'] = this.config.accessToken;
    else if (this.config.apiKey) headers['X-API-Key'] = this.config.apiKey;

    const res = await fetch(`${this.config.envdUrl}/process.Process/Connect`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ process: { tag } }),
      signal: ac.signal,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { code?: number; message?: string };
      throw parseAPIError(res.status, err);
    }

    const gen = parseSSE(res);

    // Wait for start event to get PID.
    // Use gen.next() directly to avoid for-await-break calling gen.return().
    let pid = 0;
    while (true) {
      const step = await gen.next();
      if (step.done) break;
      const raw = step.value;
      const event = (raw['event'] ?? {}) as Record<string, unknown>;
      if (event['start'] != null) {
        pid = Number((event['start'] as Record<string, unknown>)['pid'] ?? 0);
        break;
      }
    }

    const handle = new CommandHandle(pid, gen, ac, this.config);

    // Drain events in background, notifying callbacks
    (async () => {
      try {
        for await (const raw of gen) {
          const event = (raw['event'] ?? {}) as Record<string, unknown>;
          if (event['data'] != null) {
            const data = event['data'] as Record<string, unknown>;
            const rawOut = (data['stdout'] as string | undefined) ?? '';
            const rawPty = (data['pty'] as string | undefined) ?? '';
            const rawErr = (data['stderr'] as string | undefined) ?? '';
            if (rawOut) { const d = decodeBase64(rawOut); if (d) await opts?.onStdout?.(d); }
            if (rawPty) { const d = decodeBase64(rawPty); if (d) await opts?.onStdout?.(d); }
            if (rawErr) { const d = decodeBase64(rawErr); if (d) await opts?.onStderr?.(d); }
          }
        }
      } catch {
        // stream ended or aborted — expected
      }
    })();

    return handle;
  }

  /** Send SIGKILL to the process matching tag. */
  async killByTag(tag: string, opts?: CommandRequestOpts): Promise<boolean> {
    try {
      await connectRPC(
        this.config.envdUrl,
        'process.Process/SendSignal',
        { process: { tag }, signal: 'SIGKILL' },
        this.rpcHeaders,
        this.abortSignal(opts?.requestTimeoutMs)
      );
      return true;
    } catch {
      return false;
    }
  }

  /** Send data to the stdin of the process matching tag. */
  async sendStdinByTag(tag: string, data: string, opts?: CommandRequestOpts): Promise<void> {
    await connectRPC(
      this.config.envdUrl,
      'process.Process/SendInput',
      {
        process: { tag },
        input: { stdin: encodeBase64(data) },
      },
      this.rpcHeaders,
      this.abortSignal(opts?.requestTimeoutMs)
    );
  }
}

// ---------------------------------------------------------------------------
// Pty
// ---------------------------------------------------------------------------

export class Pty {
  constructor(private config: ConnectionConfig) {}

  private get rpcHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      'Connect-Protocol-Version': '1',
      'Content-Type': 'application/json',
    };
    if (this.config.accessToken) h['X-Access-Token'] = this.config.accessToken;
    else if (this.config.apiKey) h['X-API-Key'] = this.config.apiKey;
    return h;
  }

  private get sseHeaders(): Record<string, string> {
    return { ...this.rpcHeaders, 'Accept': 'text/event-stream' };
  }

  private abortSignal(requestTimeoutMs?: number): AbortSignal {
    const ms = requestTimeoutMs ?? this.config.requestTimeoutMs;
    return AbortSignal.timeout(ms);
  }

  /** Create a new PTY process. Returns a CommandHandle. */
  async create(opts: PtyCreateOpts): Promise<CommandHandle> {
    const ac = new AbortController();
    if (opts.timeoutMs) setTimeout(() => ac.abort(), opts.timeoutMs);

    const ptyProcess: Record<string, unknown> = { cmd: '/bin/bash' };
    if (opts.envs) ptyProcess['envs'] = opts.envs;
    if (opts.cwd) ptyProcess['cwd'] = opts.cwd;
    if (opts.user) ptyProcess['user'] = opts.user;

    const body: Record<string, unknown> = {
      process: ptyProcess,
      pty: { size: { rows: opts.size.rows, cols: opts.size.cols ?? 80 } },
    };
    if (opts.timeoutMs != null && opts.timeoutMs !== 0) body['timeout'] = Math.floor(opts.timeoutMs / 1000);

    const res = await fetch(
      `${this.config.envdUrl}/process.Process/Start`,
      {
        method: 'POST',
        headers: this.sseHeaders,
        body: JSON.stringify(body),
        signal: ac.signal,
      }
    );

    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { code?: number; message?: string };
      throw parseAPIError(res.status, err);
    }

    const gen = parseSSE(res);

    // Wait for the 'start' event to get the PID.
    // Use gen.next() directly to avoid for-await-break closing the generator.
    let pid = 0;
    while (true) {
      const step = await gen.next();
      if (step.done) break;
      const raw = step.value;
      const event = (raw['event'] ?? {}) as Record<string, unknown>;
      if (event['start'] != null) {
        const start = event['start'] as Record<string, unknown>;
        pid = Number(start['pid'] ?? 0);
        break;
      }
    }

    return new CommandHandle(pid, gen, ac, this.config);
  }

  /** Kill a PTY process by PID using SIGKILL. */
  async kill(
    pid: number,
    opts?: Pick<CommandRequestOpts, 'requestTimeoutMs'>
  ): Promise<boolean> {
    try {
      await connectRPC(
        this.config.envdUrl,
        'process.Process/SendSignal',
        { process: { pid }, signal: 'SIGKILL' },
        this.rpcHeaders,
        this.abortSignal(opts?.requestTimeoutMs)
      );
      return true;
    } catch {
      return false;
    }
  }

  /** Resize the PTY. */
  async resize(
    pid: number,
    size: { rows: number; cols?: number },
    opts?: Pick<CommandRequestOpts, 'requestTimeoutMs'>
  ): Promise<void> {
    await connectRPC(
      this.config.envdUrl,
      'process.Process/Update',
      {
        process: { pid },
        pty: { size: { rows: size.rows, cols: size.cols ?? 80 } },
      },
      this.rpcHeaders,
      this.abortSignal(opts?.requestTimeoutMs)
    );
  }

  /** Send raw input bytes to a PTY process (encoded as base64). */
  async sendInput(
    pid: number,
    data: Uint8Array,
    opts?: Pick<CommandRequestOpts, 'requestTimeoutMs'>
  ): Promise<void> {
    await connectRPC(
      this.config.envdUrl,
      'process.Process/SendInput',
      {
        process: { pid },
        input: { pty: encodeBase64Bytes(data) },
      },
      this.rpcHeaders,
      this.abortSignal(opts?.requestTimeoutMs)
    );
  }
}
