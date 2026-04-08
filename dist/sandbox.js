import { parseAPIError } from './errors.js';
import { Filesystem } from './filesystem.js';
import { Commands, Pty } from './commands.js';
// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
function resolveApiKey(opts) {
    const key = opts?.apiKey ?? process.env['SANDBOX_API_KEY'];
    if (!key) {
        throw new Error('API key is required. Set SANDBOX_API_KEY environment variable or pass apiKey in options.');
    }
    return key;
}
function resolveBaseUrl(opts) {
    return (opts?.baseUrl ??
        process.env['SANDBOX_BASE_URL'] ??
        'https://api.sandbox.vtrix.ai');
}
function mgmtHeaders(apiKey) {
    return {
        'X-API-Key': apiKey,
        'Content-Type': 'application/json',
    };
}
/**
 * Build the envd URL routed through hermes.
 */
function buildEnvdUrl(sandboxId, baseUrl) {
    // The /rpc suffix tells hermes to strip it and forward to the nano-executor,
    // while leaving /api/v1/sandboxes/:id/* (no /rpc) transparently proxied to Atlas.
    return `${baseUrl.replace(/\/$/, '')}/api/v1/sandboxes/${sandboxId}/rpc`;
}
/**
 * Convert megabytes to a Kubernetes storage-size string.
 * Uses Gi when sizeMb is a whole number of gibibytes, Mi otherwise.
 */
function mbToStorageSize(sizeMb) {
    if (sizeMb % 1024 === 0) {
        return `${sizeMb / 1024}Gi`;
    }
    return `${sizeMb}Mi`;
}
function mapSandboxInfo(raw) {
    return {
        sandboxId: (raw['sandboxID'] ?? raw['sandboxId']) ?? '',
        templateId: (raw['templateID'] ?? raw['templateId']) ?? '',
        alias: raw['alias'],
        startedAt: raw['startedAt'] != null
            ? new Date(raw['startedAt'])
            : undefined,
        endAt: raw['endAt'] != null
            ? new Date(raw['endAt'])
            : undefined,
        metadata: raw['metadata'],
        state: (raw['status'] ?? raw['state']) ?? 'running',
        cpuCount: raw['cpuCount'] != null ? Number(raw['cpuCount']) : undefined,
        memoryMB: raw['memoryMB'] != null ? Number(raw['memoryMB']) : undefined,
    };
}
// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------
export class Sandbox {
    config;
    sandboxId;
    files;
    commands;
    pty;
    constructor(config) {
        this.config = config;
        this.sandboxId = config.sandboxId;
        this.files = new Filesystem(config);
        this.commands = new Commands(config);
        this.pty = new Pty(config);
    }
    // ---------------------------------------------------------------------------
    // Static factory: create
    // ---------------------------------------------------------------------------
    /**
     * Create a new sandbox and return a connected Sandbox instance.
     */
    static async create(opts) {
        const apiKey = resolveApiKey(opts);
        const baseUrl = resolveBaseUrl(opts);
        const requestTimeoutMs = opts?.requestTimeoutMs ?? 60_000;
        const body = {
            templateID: opts?.template ?? 'base',
            timeout: opts?.timeout ?? 300,
            metadata: opts?.metadata ?? {},
            envVars: opts?.envs ?? {},
        };
        const res = await fetch(`${baseUrl}/api/v1/sandboxes`, {
            method: 'POST',
            headers: mgmtHeaders(apiKey),
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(requestTimeoutMs),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw parseAPIError(res.status, err);
        }
        const data = await res.json();
        const sandboxId = (data['sandboxID'] ?? data['sandboxId']);
        const accessToken = data['envdAccessToken'];
        const config = {
            sandboxId,
            envdUrl: buildEnvdUrl(sandboxId, baseUrl),
            accessToken,
            apiKey,
            baseUrl,
            requestTimeoutMs,
        };
        return new Sandbox(config);
    }
    // ---------------------------------------------------------------------------
    // Static factory: connect
    // ---------------------------------------------------------------------------
    /**
     * Connect to an existing sandbox, resuming it if paused.
     */
    static async connect(sandboxId, opts) {
        const apiKey = resolveApiKey(opts);
        const baseUrl = resolveBaseUrl(opts);
        const requestTimeoutMs = opts?.requestTimeoutMs ?? 60_000;
        const res = await fetch(`${baseUrl}/api/v1/sandboxes/${sandboxId}`, {
            method: 'GET',
            headers: mgmtHeaders(apiKey),
            signal: AbortSignal.timeout(requestTimeoutMs),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw parseAPIError(res.status, err);
        }
        const data = await res.json();
        const status = (data['status'] ?? data['state']);
        // Resume if paused/stopped
        if (status === 'paused' || status === 'stopped') {
            const resumeRes = await fetch(`${baseUrl}/api/v1/sandboxes/${sandboxId}/connect`, {
                method: 'POST',
                headers: mgmtHeaders(apiKey),
                body: JSON.stringify({ timeout: opts?.timeout ?? 300 }),
                signal: AbortSignal.timeout(requestTimeoutMs),
            });
            if (!resumeRes.ok) {
                const err = await resumeRes.json().catch(() => ({}));
                throw parseAPIError(resumeRes.status, err);
            }
        }
        const accessToken = data['envdAccessToken'];
        const config = {
            sandboxId,
            envdUrl: buildEnvdUrl(sandboxId, baseUrl),
            accessToken,
            apiKey,
            baseUrl,
            requestTimeoutMs,
        };
        return new Sandbox(config);
    }
    // ---------------------------------------------------------------------------
    // Instance methods
    // ---------------------------------------------------------------------------
    /** Kill this sandbox. */
    async kill() {
        return Sandbox.kill(this.sandboxId, {
            apiKey: this.config.apiKey,
            baseUrl: this.config.baseUrl,
        });
    }
    /** Static: kill a sandbox by ID. */
    static async kill(sandboxId, opts) {
        const apiKey = resolveApiKey(opts);
        const baseUrl = resolveBaseUrl(opts);
        const res = await fetch(`${baseUrl}/api/v1/sandboxes/${sandboxId}`, {
            method: 'DELETE',
            headers: mgmtHeaders(apiKey),
            signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw parseAPIError(res.status, err);
        }
        return true;
    }
    /** Set the sandbox lifetime timeout (in seconds). */
    async setTimeout(timeoutSeconds) {
        const res = await fetch(`${this.config.baseUrl}/api/v1/sandboxes/${this.sandboxId}/timeout`, {
            method: 'POST',
            headers: mgmtHeaders(this.config.apiKey),
            body: JSON.stringify({ timeout: timeoutSeconds }),
            signal: AbortSignal.timeout(this.config.requestTimeoutMs),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw parseAPIError(res.status, err);
        }
    }
    /** Get sandbox info. */
    async getInfo() {
        const res = await fetch(`${this.config.baseUrl}/api/v1/sandboxes/${this.sandboxId}`, {
            method: 'GET',
            headers: mgmtHeaders(this.config.apiKey),
            signal: AbortSignal.timeout(this.config.requestTimeoutMs),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw parseAPIError(res.status, err);
        }
        const raw = await res.json();
        return mapSandboxInfo(raw);
    }
    /**
     * Check if the sandbox is running by querying the management API.
     */
    async isRunning() {
        try {
            const info = await this.getInfo();
            return info.state === 'running' || info.state === 'active';
        }
        catch {
            return false;
        }
    }
    /**
     * Get current CPU and memory usage for the sandbox.
     */
    async getMetrics() {
        const res = await fetch(`${this.config.baseUrl}/api/v1/sandboxes/${this.sandboxId}/exec/metrics`, {
            method: 'GET',
            headers: mgmtHeaders(this.config.apiKey),
            signal: AbortSignal.timeout(this.config.requestTimeoutMs),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw parseAPIError(res.status, err);
        }
        const raw = await res.json();
        return { cpuUsedPct: raw.cpu_used_pct ?? 0, memUsedMiB: raw.mem_used_mib ?? 0 };
    }
    /**
     * Resize the sandbox disk to sizeMb megabytes.
     * Sends PATCH /api/v1/sandboxes/:id with {"spec":{"storage_size":"<n>Gi"}}
     * (or "<n>Mi" when sizeMb is not a whole number of gibibytes).
     * Atlas performs an in-place PVC expansion — the sandbox does not restart.
     */
    async resizeDisk(sizeMb) {
        if (sizeMb <= 0) {
            throw new Error('resizeDisk: sizeMb must be a positive integer');
        }
        const storageSize = mbToStorageSize(sizeMb);
        const res = await fetch(`${this.config.baseUrl}/api/v1/sandboxes/${this.sandboxId}`, {
            method: 'PATCH',
            headers: mgmtHeaders(this.config.apiKey),
            body: JSON.stringify({ spec: { storage_size: storageSize } }),
            signal: AbortSignal.timeout(this.config.requestTimeoutMs),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw parseAPIError(res.status, err);
        }
    }
    /**
     * Pause (snapshot) the sandbox. Resume later with Sandbox.connect().
     */
    async betaPause() {
        const res = await fetch(`${this.config.baseUrl}/api/v1/sandboxes/${this.sandboxId}/pause`, {
            method: 'POST',
            headers: mgmtHeaders(this.config.apiKey),
            signal: AbortSignal.timeout(this.config.requestTimeoutMs),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw parseAPIError(res.status, err);
        }
    }
    /**
     * Return a short-lived signed URL for directly downloading a file from the sandbox.
     */
    async downloadUrl(path, opts) {
        const expires = opts?.expires ?? 300;
        let url = `${this.config.baseUrl}/api/v1/sandboxes/${this.sandboxId}/exec/files/download-url?path=${encodeURIComponent(path)}&expires=${expires}`;
        if (opts?.user)
            url += `&username=${encodeURIComponent(opts.user)}`;
        const res = await fetch(url, {
            method: 'GET',
            headers: mgmtHeaders(this.config.apiKey),
            signal: AbortSignal.timeout(this.config.requestTimeoutMs),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw parseAPIError(res.status, err);
        }
        const data = await res.json();
        return data.url;
    }
    /**
     * Return a short-lived signed URL for directly uploading a file into the sandbox.
     */
    async uploadUrl(path, opts) {
        const expires = opts?.expires ?? 300;
        let url = `${this.config.baseUrl}/api/v1/sandboxes/${this.sandboxId}/exec/files/upload-url?path=${encodeURIComponent(path)}&expires=${expires}`;
        if (opts?.user)
            url += `&username=${encodeURIComponent(opts.user)}`;
        const res = await fetch(url, {
            method: 'GET',
            headers: mgmtHeaders(this.config.apiKey),
            signal: AbortSignal.timeout(this.config.requestTimeoutMs),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw parseAPIError(res.status, err);
        }
        const data = await res.json();
        return data.url;
    }
    /** List all sandboxes. */
    static async list(opts) {
        const apiKey = resolveApiKey(opts);
        const baseUrl = resolveBaseUrl(opts);
        const res = await fetch(`${baseUrl}/api/v1/sandboxes`, {
            method: 'GET',
            headers: mgmtHeaders(apiKey),
            signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw parseAPIError(res.status, err);
        }
        const raw = await res.json();
        const items = Array.isArray(raw) ? raw : raw.sandboxes ?? [];
        return items.map((s) => mapSandboxInfo(s));
    }
    /** Static: set the sandbox lifetime timeout (in seconds). */
    static async setTimeout(sandboxId, timeoutSeconds, opts) {
        const apiKey = resolveApiKey(opts);
        const baseUrl = resolveBaseUrl(opts);
        const res = await fetch(`${baseUrl}/api/v1/sandboxes/${sandboxId}/timeout`, {
            method: 'POST',
            headers: mgmtHeaders(apiKey),
            body: JSON.stringify({ timeout: timeoutSeconds }),
            signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw parseAPIError(res.status, err);
        }
    }
    /** Static: get sandbox info by ID. */
    static async getInfo(sandboxId, opts) {
        const apiKey = resolveApiKey(opts);
        const baseUrl = resolveBaseUrl(opts);
        const res = await fetch(`${baseUrl}/api/v1/sandboxes/${sandboxId}`, {
            method: 'GET',
            headers: mgmtHeaders(apiKey),
            signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw parseAPIError(res.status, err);
        }
        const raw = await res.json();
        return mapSandboxInfo(raw);
    }
    /** Static: get CPU and memory metrics for a sandbox by ID. */
    static async getMetrics(sandboxId, opts) {
        const apiKey = resolveApiKey(opts);
        const baseUrl = resolveBaseUrl(opts);
        const res = await fetch(`${baseUrl}/api/v1/sandboxes/${sandboxId}/exec/metrics`, {
            method: 'GET',
            headers: mgmtHeaders(apiKey),
            signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw parseAPIError(res.status, err);
        }
        const raw = await res.json();
        return { cpuUsedPct: raw.cpu_used_pct ?? 0, memUsedMiB: raw.mem_used_mib ?? 0 };
    }
    /**
     * Get the host used for proxied access to a specific port inside the sandbox.
     */
    getHost(port) {
        // Build proxy host: <port>-<sandboxId>.<domain>
        try {
            const url = new URL(this.config.baseUrl);
            return `${port}-${this.sandboxId}.${url.hostname}`;
        }
        catch {
            return `${port}-${this.sandboxId}.sandbox`;
        }
    }
    /**
     * The domain portion derived from the configured base URL.
     */
    get sandboxDomain() {
        try {
            const url = new URL(this.config.baseUrl);
            return url.hostname;
        }
        catch {
            return 'sandbox';
        }
    }
}
