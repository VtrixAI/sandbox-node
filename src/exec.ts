import { ExecEvent, ExecResult, RunOptions, DetachedResult, SandboxError } from './types';
import { Command, CommandFinished, buildExecParams, parseStartedAt } from './command';
import type { Sandbox } from './sandbox';

/**
 * Run a command and return its result as a CommandFinished.
 * args are shell-quoted and appended to cmd to avoid shell injection.
 * If opts.stdout or opts.stderr are set, output is streamed to those writables as it arrives.
 */
export async function runCommand(sb: Sandbox, cmd: string, args?: string[], opts?: RunOptions): Promise<CommandFinished> {
  if (opts?.stdout || opts?.stderr) {
    return _runCommandWithWriters(sb, cmd, args, opts);
  }
  const resp = await sb._call('exec', buildExecParams(cmd, args, sb.defaultEnv, opts));
  const r = resp.result as ExecResult;
  return new CommandFinished(sb, r.cmd_id ?? '', 0, parseStartedAt(r.started_at), opts?.working_dir ?? '', r.exit_code ?? 0, r.output ?? '');
}

/**
 * Start a command in detached (background) mode and return immediately.
 * Use command.wait() to block until completion, or command.logs() to stream output.
 */
export async function runCommandDetached(sb: Sandbox, cmd: string, args?: string[], opts?: RunOptions): Promise<Command> {
  const params = { ...buildExecParams(cmd, args, sb.defaultEnv, opts), detached: true };
  const resp = await sb._call('exec', params);
  const r = resp.result as DetachedResult;
  return new Command(sb, r.cmd_id, r.pid, parseStartedAt(r.started_at), opts?.working_dir ?? '');
}

async function _runCommandWithWriters(sb: Sandbox, cmd: string, args: string[] | undefined, opts: RunOptions): Promise<CommandFinished> {
  const events: (ExecEvent | null)[] = [];
  let head = 0;
  let notify: (() => void) | null = null;
  const onEvent = (ev: ExecEvent | null): void => { events.push(ev); notify?.(); };
  const callPromise = sb._call('exec', buildExecParams(cmd, args, sb.defaultEnv, opts), onEvent);

  while (true) {
    if (head < events.length) {
      const ev = events[head++]!;
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
  return new CommandFinished(sb, r.cmd_id ?? '', 0, parseStartedAt(r.started_at), opts.working_dir ?? '', r.exit_code ?? 0, r.output ?? '');
}

/**
 * Run a command and stream ExecEvents in real time.
 * args are shell-quoted and appended to cmd.
 */
export async function* runCommandStream(sb: Sandbox, cmd: string, args?: string[], opts?: RunOptions): AsyncGenerator<ExecEvent> {
  const events: (ExecEvent | null)[] = [];
  let head = 0;
  let notify: (() => void) | null = null;

  const onEvent = (ev: ExecEvent | null): void => {
    events.push(ev);
    notify?.();
  };

  const callPromise = sb._call('exec', buildExecParams(cmd, args, sb.defaultEnv, opts), onEvent);

  while (true) {
    if (head < events.length) {
      const ev = events[head++]!;
      if (ev === null) break;
      yield ev;
    } else {
      await new Promise<void>((res) => { notify = res; });
      notify = null;
    }
  }

  await callPromise; // propagate errors
}

/** Reconstruct a Command from a known cmdId (e.g. after reconnect). */
export function getCommand(sb: Sandbox, cmdId: string): Command {
  return new Command(sb, cmdId);
}

/** Send a signal to a running command by ID. Defaults to SIGTERM. */
export async function kill(sb: Sandbox, cmdId: string, signal = 'SIGTERM'): Promise<void> {
  await sb._call('kill', { cmd_id: cmdId, signal });
}

/**
 * Attach to a running or completed command and stream its output.
 * Replays ring-buffer first, then streams live output.
 */
export async function* execLogs(sb: Sandbox, cmdId: string): AsyncGenerator<ExecEvent> {
  const events: (ExecEvent | null)[] = [];
  let head = 0;
  let notify: (() => void) | null = null;

  const onEvent = (ev: ExecEvent | null): void => {
    events.push(ev);
    notify?.();
  };

  const callPromise = sb._call('exec_logs', { cmd_id: cmdId }, onEvent);

  while (true) {
    if (head < events.length) {
      const ev = events[head++]!;
      if (ev === null) break;
      yield ev;
    } else {
      await new Promise<void>((res) => { notify = res; });
      notify = null;
    }
  }

  await callPromise; // propagate errors
}
