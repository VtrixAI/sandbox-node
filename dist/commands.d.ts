import type { CommandConnectOpts, CommandRequestOpts, CommandResult, CommandStartOpts, ConnectionConfig, ProcessInfo, PtyCreateOpts } from './types.js';
export declare class CommandHandle {
    readonly pid: number;
    private _sseGen;
    private _abortController;
    private _config;
    constructor(pid: number, sseGen: AsyncGenerator<Record<string, unknown>> | null, abortController: AbortController, config: ConnectionConfig);
    /**
     * Wait for the process to finish, consuming remaining SSE events.
     * Calls onStdout/onStderr for each output chunk received.
     */
    wait(opts?: {
        onStdout?: (d: string) => void | Promise<void>;
        onStderr?: (d: string) => void | Promise<void>;
    }): Promise<CommandResult>;
    /** Send SIGKILL to the process. */
    kill(): Promise<boolean>;
    /** Abort the SSE stream without killing the process. */
    disconnect(): void;
}
export declare class Commands {
    private config;
    constructor(config: ConnectionConfig);
    private get rpcHeaders();
    private get sseHeaders();
    private abortSignal;
    /** Connect to an already-running process and stream its output. */
    connect(pid: number, opts?: CommandConnectOpts): Promise<CommandHandle>;
    /** Kill a process by PID using SIGKILL. */
    kill(pid: number, opts?: CommandRequestOpts): Promise<boolean>;
    /** List running processes. */
    list(opts?: CommandRequestOpts): Promise<ProcessInfo[]>;
    /** Run a command and wait for it to finish. */
    run(cmd: string, opts?: CommandStartOpts & {
        background?: false;
    }): Promise<CommandResult>;
    /** Run a command in the background, return a handle immediately after start. */
    run(cmd: string, opts: CommandStartOpts & {
        background: true;
    }): Promise<CommandHandle>;
    run(cmd: string, opts?: CommandStartOpts): Promise<CommandResult | CommandHandle>;
    /** Send data to a process's stdin. */
    sendStdin(pid: number, data: string, opts?: CommandRequestOpts): Promise<void>;
    /** Close stdin of a process (triggers EOF). */
    closeStdin(pid: number, opts?: CommandRequestOpts): Promise<void>;
    /** Send a signal to a process by PID. */
    sendSignal(pid: number, signal: string, opts?: CommandRequestOpts): Promise<void>;
    /** Connect to an already-running process by tag and stream its output. */
    connectByTag(tag: string, opts?: CommandConnectOpts): Promise<CommandHandle>;
    /** Send SIGKILL to the process matching tag. */
    killByTag(tag: string, opts?: CommandRequestOpts): Promise<boolean>;
    /** Send data to the stdin of the process matching tag. */
    sendStdinByTag(tag: string, data: string, opts?: CommandRequestOpts): Promise<void>;
}
export declare class Pty {
    private config;
    constructor(config: ConnectionConfig);
    private get rpcHeaders();
    private get sseHeaders();
    private abortSignal;
    /** Create a new PTY process. Returns a CommandHandle. */
    create(opts: PtyCreateOpts): Promise<CommandHandle>;
    /** Kill a PTY process by PID using SIGKILL. */
    kill(pid: number, opts?: Pick<CommandRequestOpts, 'requestTimeoutMs'>): Promise<boolean>;
    /** Resize the PTY. */
    resize(pid: number, size: {
        rows: number;
        cols?: number;
    }, opts?: Pick<CommandRequestOpts, 'requestTimeoutMs'>): Promise<void>;
    /** Send raw input bytes to a PTY process (encoded as base64). */
    sendInput(pid: number, data: Uint8Array, opts?: Pick<CommandRequestOpts, 'requestTimeoutMs'>): Promise<void>;
}
