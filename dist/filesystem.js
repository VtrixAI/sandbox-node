import { parseAPIError, NotFoundError } from './errors.js';
// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
/**
 * Parse Server-Sent Events from a streaming fetch Response body.
 * Yields parsed JSON objects for every `data:` line received.
 */
async function* parseSSE(response) {
    if (!response.body)
        throw new Error('No response body');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done)
            break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
            const dataLine = part.split('\n').find((l) => l.startsWith('data: '));
            if (dataLine) {
                try {
                    yield JSON.parse(dataLine.slice(6));
                }
                catch {
                    // skip malformed events
                }
            }
        }
    }
}
/**
 * Perform a Connect-RPC call (unary) against the envd service.
 */
async function connectRPC(envdUrl, method, body, headers, signal) {
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
        const err = await res.json().catch(() => ({}));
        throw parseAPIError(res.status, err);
    }
    return res.json();
}
// ---------------------------------------------------------------------------
// WatchHandle
// ---------------------------------------------------------------------------
export class WatchHandle {
    abortController;
    constructor(ac) {
        this.abortController = ac;
    }
    stop() {
        this.abortController.abort();
    }
}
// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------
export class Filesystem {
    config;
    constructor(config) {
        this.config = config;
    }
    get headers() {
        const h = {};
        if (this.config.accessToken)
            h['X-Access-Token'] = this.config.accessToken;
        return h;
    }
    abortSignal(requestTimeoutMs) {
        const ms = requestTimeoutMs ?? this.config.requestTimeoutMs;
        return AbortSignal.timeout(ms);
    }
    mapEntry(raw) {
        return {
            name: raw['name'] ?? '',
            type: raw['type'],
            path: raw['path'] ?? '',
            size: Number(raw['size'] ?? 0),
            mode: Number(raw['mode'] ?? 0),
            permissions: raw['permissions'] ?? '',
            owner: raw['owner'] ?? '',
            group: raw['group'] ?? '',
            modifiedTime: raw['modifiedTime'] != null
                ? new Date(raw['modifiedTime'])
                : undefined,
            symlinkTarget: raw['symlinkTarget'],
        };
    }
    // exists: POST /filesystem.Filesystem/Stat — check for 404
    async exists(path, opts) {
        try {
            await connectRPC(this.config.envdUrl, 'filesystem.Filesystem/Stat', { path }, this.headers, this.abortSignal(opts?.requestTimeoutMs));
            return true;
        }
        catch (err) {
            if (err instanceof NotFoundError)
                return false;
            throw err;
        }
    }
    // getInfo: POST /filesystem.Filesystem/Stat
    async getInfo(path, opts) {
        const raw = await connectRPC(this.config.envdUrl, 'filesystem.Filesystem/Stat', { path }, this.headers, this.abortSignal(opts?.requestTimeoutMs));
        // Stat response wraps the entry: {"entry": {...}}
        const entry = (raw['entry'] ?? raw);
        return this.mapEntry(entry);
    }
    // list: POST /filesystem.Filesystem/ListDir body: {path, depth}
    async list(path, opts) {
        const raw = await connectRPC(this.config.envdUrl, 'filesystem.Filesystem/ListDir', { path, depth: opts?.depth }, this.headers, this.abortSignal(opts?.requestTimeoutMs));
        return (raw.entries ?? []).map((e) => this.mapEntry(e));
    }
    // makeDir: POST /filesystem.Filesystem/MakeDir body: {path}
    async makeDir(path, opts) {
        await connectRPC(this.config.envdUrl, 'filesystem.Filesystem/MakeDir', { path }, this.headers, this.abortSignal(opts?.requestTimeoutMs));
        return true;
    }
    async read(path, opts) {
        const url = `${this.config.envdUrl}/files?path=${encodeURIComponent(path)}`;
        const res = await fetch(url, {
            method: 'GET',
            headers: this.headers,
            signal: this.abortSignal(opts?.requestTimeoutMs),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw parseAPIError(res.status, err);
        }
        const format = opts?.format ?? 'text';
        switch (format) {
            case 'text':
                return res.text();
            case 'bytes': {
                const buf = await res.arrayBuffer();
                return new Uint8Array(buf);
            }
            case 'blob':
                return res.blob();
            case 'stream':
                if (!res.body)
                    throw new Error('No response body');
                return res.body;
            default:
                return res.text();
        }
    }
    // remove: POST /filesystem.Filesystem/Remove body: {path}
    async remove(path, opts) {
        await connectRPC(this.config.envdUrl, 'filesystem.Filesystem/Remove', { path }, this.headers, this.abortSignal(opts?.requestTimeoutMs));
    }
    // rename: POST /filesystem.Filesystem/Move body: {path, newPath}
    async rename(oldPath, newPath, opts) {
        const raw = await connectRPC(this.config.envdUrl, 'filesystem.Filesystem/Move', { source: oldPath, destination: newPath }, this.headers, this.abortSignal(opts?.requestTimeoutMs));
        return this.mapEntry(raw);
    }
    async write(pathOrFiles, dataOrOpts, opts) {
        if (Array.isArray(pathOrFiles)) {
            // Batch write
            const files = pathOrFiles;
            const batchOpts = dataOrOpts;
            return this.writeBatch(files, batchOpts);
        }
        // Single file write
        const path = pathOrFiles;
        const data = dataOrOpts;
        const url = `${this.config.envdUrl}/files?path=${encodeURIComponent(path)}`;
        let body;
        if (typeof data === 'string') {
            body = data;
        }
        else if (data instanceof ArrayBuffer) {
            body = data;
        }
        else if (data instanceof Blob) {
            body = data;
        }
        else {
            // ReadableStream
            body = data;
        }
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                ...this.headers,
                'Content-Type': 'application/octet-stream',
            },
            body,
            signal: this.abortSignal(opts?.requestTimeoutMs),
            // @ts-ignore — duplex needed for streaming bodies in Node 18+
            duplex: 'half',
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw parseAPIError(res.status, err);
        }
        const raw = await res.json();
        return {
            name: raw['name'] ?? '',
            path: raw['path'] ?? '',
            type: raw['type'],
        };
    }
    async writeBatch(files, opts) {
        // Build JSON body: { "files": [{ "path", "content" }, ...] }
        const fileEntries = [];
        for (const file of files) {
            let content;
            if (typeof file.data === 'string') {
                content = file.data;
            }
            else if (file.data instanceof ArrayBuffer) {
                content = Buffer.from(file.data).toString('base64');
            }
            else if (file.data instanceof Blob) {
                const buf = await file.data.arrayBuffer();
                content = Buffer.from(buf).toString('base64');
            }
            else {
                content = '';
            }
            fileEntries.push({ path: file.path, content });
        }
        const res = await fetch(`${this.config.envdUrl}/files/batch`, {
            method: 'POST',
            headers: { ...this.headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ files: fileEntries }),
            signal: this.abortSignal(opts?.requestTimeoutMs),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw parseAPIError(res.status, err);
        }
        const raw = await res.json();
        return (raw.files ?? []).map((f) => ({
            name: (f['path'] ?? '').split('/').pop() ?? '',
            path: f['path'] ?? '',
            type: f['type'],
        }));
    }
    // edit: POST /filesystem.Filesystem/Edit body: {path, oldText, newText}
    async edit(path, oldText, newText, opts) {
        await connectRPC(this.config.envdUrl, 'filesystem.Filesystem/Edit', { path, oldText, newText }, this.headers, this.abortSignal(opts?.requestTimeoutMs));
    }
    // watchDir: POST /filesystem.Filesystem/WatchDir — SSE streaming
    async watchDir(path, onEvent, opts) {
        const ac = new AbortController();
        // If a timeoutMs is given, auto-abort after that duration
        if (opts?.timeoutMs) {
            setTimeout(() => ac.abort(), opts.timeoutMs);
        }
        const res = await fetch(`${this.config.envdUrl}/filesystem.Filesystem/WatchDir`, {
            method: 'POST',
            headers: {
                'Connect-Protocol-Version': '1',
                'Content-Type': 'application/json',
                'Accept': 'text/event-stream',
                ...this.headers,
            },
            body: JSON.stringify({ path, recursive: opts?.recursive ?? false }),
            signal: ac.signal,
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw parseAPIError(res.status, err);
        }
        // Consume SSE in background
        (async () => {
            try {
                for await (const event of parseSSE(res)) {
                    const fsEvent = {
                        name: event['name'] ?? '',
                        type: event['type'] ?? '',
                    };
                    await onEvent(fsEvent);
                }
                opts?.onExit?.();
            }
            catch (err) {
                if (err.name === 'AbortError') {
                    opts?.onExit?.();
                }
                else {
                    opts?.onExit?.(err);
                }
            }
        })();
        return new WatchHandle(ac);
    }
}
