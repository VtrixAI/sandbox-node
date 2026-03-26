import { ExecEvent, ExecResult, LogEvent, RunOptions, DetachedResult } from './types';
import type { Sandbox } from './sandbox';

export interface PendingCall {
  resolve: (resp: import('./types').RpcResponse) => void;
  reject: (err: Error) => void;
  /** Non-null for streaming exec calls */
  onEvent?: (ev: ExecEvent | null) => void;
  /** Non-null for generic notification streaming (read_stream etc.) */
  onNotification?: (msg: import('./types').RpcResponse | null) => void;
}

// ── Command object model ──────────────────────────────────

/**
 * A background command that may still be running.
 * Obtained via `sandbox.runCommandDetached()` or `Sandbox.getCommand`.
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
    let head = 0;
    let notify: (() => void) | null = null;
    const onEvent = (ev: ExecEvent | null): void => { events.push(ev); notify?.(); };
    const callPromise = this._sandbox._call('exec_logs', { cmd_id: this.cmdId }, onEvent);

    // drain events
    while (true) {
      if (head < events.length) {
        const ev = events[head++]!;
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

// ── Helpers used by exec.ts ───────────────────────────────

/** Build JSON-RPC exec params from command, args, env and options. */
export function buildExecParams(cmd: string, args: string[] | undefined, defaultEnv: Record<string, string>, opts?: RunOptions): Record<string, unknown> {
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
  if (opts?.stdin) params['stdin_data'] = opts.stdin;
  return params;
}

/** Return a single-quoted shell-safe version of s. */
export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Parse an RFC3339 string from the server into a Date.
 * Falls back to the current time when the string is empty or invalid.
 */
export function parseStartedAt(s?: string): Date {
  if (!s) return new Date();
  const d = new Date(s);
  return isNaN(d.getTime()) ? new Date() : d;
}
