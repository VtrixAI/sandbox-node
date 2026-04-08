import { Filesystem } from './filesystem.js';
import { Commands, Pty } from './commands.js';
import type { SandboxInfo, SandboxOpts } from './types.js';
export declare class Sandbox {
    private config;
    readonly sandboxId: string;
    readonly files: Filesystem;
    readonly commands: Commands;
    readonly pty: Pty;
    private constructor();
    /**
     * Create a new sandbox and return a connected Sandbox instance.
     */
    static create(opts?: SandboxOpts): Promise<Sandbox>;
    /**
     * Connect to an existing sandbox, resuming it if paused.
     */
    static connect(sandboxId: string, opts?: SandboxOpts): Promise<Sandbox>;
    /** Kill this sandbox. */
    kill(): Promise<boolean>;
    /** Static: kill a sandbox by ID. */
    static kill(sandboxId: string, opts?: Pick<SandboxOpts, 'apiKey' | 'baseUrl'>): Promise<boolean>;
    /** Set the sandbox lifetime timeout (in seconds). */
    setTimeout(timeoutSeconds: number): Promise<void>;
    /** Get sandbox info. */
    getInfo(): Promise<SandboxInfo>;
    /**
     * Check if the sandbox is running by querying the management API.
     */
    isRunning(): Promise<boolean>;
    /**
     * Get current CPU and memory usage for the sandbox.
     */
    getMetrics(): Promise<{
        cpuUsedPct: number;
        memUsedMiB: number;
    }>;
    /**
     * Resize the sandbox disk to sizeMb megabytes.
     * Sends PATCH /api/v1/sandboxes/:id with {"spec":{"storage_size":"<n>Gi"}}.
     * Atlas performs an in-place PVC expansion — the sandbox does not restart.
     */
    resizeDisk(sizeMb: number): Promise<void>;
    /**
     * Pause (snapshot) the sandbox. Resume later with Sandbox.connect().
     */
    betaPause(): Promise<void>;
    /**
     * Return a short-lived signed URL for directly downloading a file from the sandbox.
     */
    downloadUrl(path: string, opts?: {
        expires?: number;
        user?: string;
    }): Promise<string>;
    /**
     * Return a short-lived signed URL for directly uploading a file into the sandbox.
     */
    uploadUrl(path: string, opts?: {
        expires?: number;
        user?: string;
    }): Promise<string>;
    /** List all sandboxes. */
    static list(opts?: Pick<SandboxOpts, 'apiKey' | 'baseUrl'>): Promise<SandboxInfo[]>;
    /** Static: set the sandbox lifetime timeout (in seconds). */
    static setTimeout(sandboxId: string, timeoutSeconds: number, opts?: Pick<SandboxOpts, 'apiKey' | 'baseUrl'>): Promise<void>;
    /** Static: get sandbox info by ID. */
    static getInfo(sandboxId: string, opts?: Pick<SandboxOpts, 'apiKey' | 'baseUrl'>): Promise<SandboxInfo>;
    /** Static: get CPU and memory metrics for a sandbox by ID. */
    static getMetrics(sandboxId: string, opts?: Pick<SandboxOpts, 'apiKey' | 'baseUrl'>): Promise<{
        cpuUsedPct: number;
        memUsedMiB: number;
    }>;
    /**
     * Get the host used for proxied access to a specific port inside the sandbox.
     */
    getHost(port: number): string;
    /**
     * The domain portion derived from the configured base URL.
     */
    get sandboxDomain(): string;
}
