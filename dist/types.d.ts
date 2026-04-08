export interface SandboxOpts {
    apiKey?: string;
    baseUrl?: string;
    timeout?: number;
    template?: string;
    metadata?: Record<string, string>;
    envs?: Record<string, string>;
    requestTimeoutMs?: number;
}
export interface ConnectionConfig {
    sandboxId: string;
    envdUrl: string;
    accessToken?: string;
    apiKey: string;
    baseUrl: string;
    requestTimeoutMs: number;
}
export interface SandboxInfo {
    sandboxId: string;
    templateId: string;
    alias?: string;
    startedAt?: Date;
    endAt?: Date;
    metadata?: Record<string, string>;
    state: 'running' | 'paused';
    cpuCount?: number;
    memoryMB?: number;
}
export declare enum FileType {
    FILE = "file",
    DIR = "dir"
}
export interface EntryInfo {
    name: string;
    type?: FileType;
    path: string;
    size: number;
    mode: number;
    permissions: string;
    owner: string;
    group: string;
    modifiedTime?: Date;
    symlinkTarget?: string;
}
export interface WriteInfo {
    name: string;
    path: string;
    type?: FileType;
}
export interface WriteEntry {
    path: string;
    data: string | ArrayBuffer | Blob;
}
export interface ProcessInfo {
    pid: number;
    cmd: string;
    args: string[];
    cwd?: string;
    envs: Record<string, string>;
    tag?: string;
}
export interface CommandResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    error?: string;
}
export interface FilesystemEvent {
    name: string;
    type: string;
}
export interface CommandRequestOpts {
    requestTimeoutMs?: number;
}
export interface CommandStartOpts extends CommandRequestOpts {
    background?: boolean;
    cwd?: string;
    envs?: Record<string, string>;
    onStdout?: (data: string) => void | Promise<void>;
    onStderr?: (data: string) => void | Promise<void>;
    stdin?: boolean;
    timeoutMs?: number;
    user?: string;
}
export type CommandConnectOpts = Pick<CommandStartOpts, 'onStderr' | 'onStdout' | 'timeoutMs'> & CommandRequestOpts;
export interface FilesystemRequestOpts {
    requestTimeoutMs?: number;
    user?: string;
}
export interface FilesystemListOpts extends FilesystemRequestOpts {
    depth?: number;
}
export interface WatchOpts extends FilesystemRequestOpts {
    timeoutMs?: number;
    recursive?: boolean;
    onExit?: (err?: Error) => void | Promise<void>;
}
export interface PtyCreateOpts {
    size: {
        rows: number;
        cols?: number;
    };
    cwd?: string;
    envs?: Record<string, string>;
    user?: string;
    timeoutMs?: number;
    requestTimeoutMs?: number;
}
