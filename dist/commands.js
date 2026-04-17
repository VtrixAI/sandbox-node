import { parseAPIError, CommandExitError } from './errors.js';
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
// Decode base64 to UTF-8 string
function decodeBase64(b64) {
    return Buffer.from(b64, 'base64').toString('utf8');
}
// Encode string to base64
function encodeBase64(str) {
    return Buffer.from(str).toString('base64');
}
// Encode Uint8Array to base64
function encodeBase64Bytes(data) {
    return Buffer.from(data).toString('base64');
}
// ---------------------------------------------------------------------------
// CommandHandle
// ---------------------------------------------------------------------------
export class CommandHandle {
    pid;
    // Internal: the SSE generator for ongoing streaming
    _sseGen;
    _abortController;
    _config;
    constructor(pid, sseGen, abortController, config) {
        this.pid = pid;
        this._sseGen = sseGen;
        this._abortController = abortController;
        this._config = config;
    }
    /**
     * Wait for the process to finish, consuming remaining SSE events.
     * Calls onStdout/onStderr for each output chunk received.
     */
    async wait(opts) {
        if (!this._sseGen) {
            // Re-connect to get remaining output
            const gen = await connectToProcessSSE(this._config, this.pid, opts?.onStdout, opts?.onStderr, this._abortController.signal);
            return throwIfNonZero(await consumeSSEUntilEnd(gen, opts?.onStdout, opts?.onStderr));
        }
        return throwIfNonZero(await consumeSSEUntilEnd(this._sseGen, opts?.onStdout, opts?.onStderr));
    }
    /** Send SIGKILL to the process. */
    async kill() {
        const headers = {
            'Connect-Protocol-Version': '1',
            'Content-Type': 'application/json',
        };
        if (this._config.accessToken) {
            headers['X-Access-Token'] = this._config.accessToken;
        }
        try {
            await connectRPC(this._config.envdUrl, 'process.Process/SendSignal', { process: { pid: this.pid }, signal: 'SIGKILL' }, headers);
            return true;
        }
        catch {
            return false;
        }
    }
    /** Abort the SSE stream without killing the process. */
    disconnect() {
        this._abortController.abort();
    }
}
// ---------------------------------------------------------------------------
// Internal SSE helpers for process streaming
// ---------------------------------------------------------------------------
async function connectToProcessSSE(config, pid, onStdout, onStderr, signal) {
    const headers = {
        'Connect-Protocol-Version': '1',
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
    };
    if (config.accessToken)
        headers['X-Access-Token'] = config.accessToken;
    const res = await fetch(`${config.envdUrl}/process.Process/Connect`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ process: { pid } }),
        signal,
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw parseAPIError(res.status, err);
    }
    return parseSSE(res);
}
async function consumeSSEUntilEnd(gen, onStdout, onStderr) {
    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    let error;
    for await (const raw of gen) {
        // Wire format: {"event": {"start":{}, "data":{stdout,stderr,pty}, "end":{status}, "keepalive":{}}}
        const event = (raw['event'] ?? {});
        if (event['data'] != null) {
            const data = event['data'];
            const rawOut = data['stdout'] ?? '';
            const rawPty = data['pty'] ?? '';
            const rawErr = data['stderr'] ?? '';
            if (rawOut) {
                const d = decodeBase64(rawOut);
                stdout += d;
                await onStdout?.(d);
            }
            if (rawPty) {
                const d = decodeBase64(rawPty);
                stdout += d;
                await onStdout?.(d);
            }
            if (rawErr) {
                const d = decodeBase64(rawErr);
                stderr += d;
                await onStderr?.(d);
            }
        }
        if (event['end'] != null) {
            const end = event['end'];
            const status = end['status'] ?? '';
            exitCode = parseExitCode(status);
            error = end['error'];
            break;
        }
    }
    return { stdout, stderr, exitCode, error };
}
function throwIfNonZero(result) {
    if (result.exitCode !== 0) {
        throw new CommandExitError(result.exitCode, result.stdout, result.stderr);
    }
    return result;
}
function parseExitCode(status) {
    if (!status || status === 'exit status 0')
        return 0;
    const parts = status.split(' ');
    const last = parts[parts.length - 1];
    const n = parseInt(last, 10);
    return isNaN(n) ? 1 : n;
}
// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
export class Commands {
    config;
    constructor(config) {
        this.config = config;
    }
    get rpcHeaders() {
        const h = {
            'Connect-Protocol-Version': '1',
            'Content-Type': 'application/json',
        };
        if (this.config.accessToken)
            h['X-Access-Token'] = this.config.accessToken;
        return h;
    }
    get sseHeaders() {
        return { ...this.rpcHeaders, 'Accept': 'text/event-stream' };
    }
    abortSignal(requestTimeoutMs) {
        const ms = requestTimeoutMs ?? this.config.requestTimeoutMs;
        return AbortSignal.timeout(ms);
    }
    /** Connect to an already-running process and stream its output. */
    async connect(pid, opts) {
        const ac = new AbortController();
        if (opts?.timeoutMs)
            setTimeout(() => ac.abort(), opts.timeoutMs);
        const gen = await connectToProcessSSE(this.config, pid, opts?.onStdout, opts?.onStderr, ac.signal);
        // Start streaming in background
        const handle = new CommandHandle(pid, gen, ac, this.config);
        // Drain events in background, notifying callbacks
        (async () => {
            try {
                for await (const raw of gen) {
                    const event = (raw['event'] ?? {});
                    if (event['data'] != null) {
                        const data = event['data'];
                        const rawOut = data['stdout'] ?? '';
                        const rawPty = data['pty'] ?? '';
                        const rawErr = data['stderr'] ?? '';
                        if (rawOut) {
                            const d = decodeBase64(rawOut);
                            if (d)
                                await opts?.onStdout?.(d);
                        }
                        if (rawPty) {
                            const d = decodeBase64(rawPty);
                            if (d)
                                await opts?.onStdout?.(d);
                        }
                        if (rawErr) {
                            const d = decodeBase64(rawErr);
                            if (d)
                                await opts?.onStderr?.(d);
                        }
                    }
                }
            }
            catch {
                // stream ended or aborted — expected
            }
        })();
        return handle;
    }
    /** Kill a process by PID using SIGKILL. */
    async kill(pid, opts) {
        try {
            await connectRPC(this.config.envdUrl, 'process.Process/SendSignal', { process: { pid }, signal: 'SIGKILL' }, this.rpcHeaders, this.abortSignal(opts?.requestTimeoutMs));
            return true;
        }
        catch {
            return false;
        }
    }
    /** List running processes. */
    async list(opts) {
        const raw = await connectRPC(this.config.envdUrl, 'process.Process/List', {}, this.rpcHeaders, this.abortSignal(opts?.requestTimeoutMs));
        return (raw.processes ?? []).map((p) => {
            const cfg = (p['config'] ?? {});
            return {
                pid: Number(p['pid'] ?? 0),
                cmd: cfg['cmd'] ?? '',
                args: cfg['args'] ?? [],
                cwd: cfg['cwd'],
                envs: cfg['envs'] ?? {},
                tag: p['tag'],
            };
        });
    }
    async run(cmd, opts) {
        const background = opts?.background ?? false;
        const ac = new AbortController();
        if (opts?.timeoutMs)
            setTimeout(() => ac.abort(), opts.timeoutMs);
        const process_ = {
            cmd: '/bin/bash',
            args: ['-c', cmd],
        };
        if (opts?.envs)
            process_['envs'] = opts.envs;
        if (opts?.cwd)
            process_['cwd'] = opts.cwd;
        const body = { process: process_ };
        if (opts?.tag)
            body['tag'] = opts.tag;
        if (opts?.stdin === false)
            body['stdin'] = false;
        if (opts?.timeoutMs != null && opts.timeoutMs !== 0)
            body['timeout'] = Math.floor(opts.timeoutMs / 1000);
        const res = await fetch(`${this.config.envdUrl}/process.Process/Start`, {
            method: 'POST',
            headers: this.sseHeaders,
            body: JSON.stringify(body),
            signal: ac.signal,
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw parseAPIError(res.status, err);
        }
        const gen = parseSSE(res);
        // Wait for the 'start' event to get the PID.
        // Use gen.next() directly to avoid for-await-break calling gen.return(),
        // which would close the generator and prevent subsequent reads.
        let pid = 0;
        while (true) {
            const step = await gen.next();
            if (step.done)
                break;
            const raw = step.value;
            const event = (raw['event'] ?? {});
            if (event['start'] != null) {
                const start = event['start'];
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
                        const event = (raw['event'] ?? {});
                        if (event['data'] != null) {
                            const data = event['data'];
                            const rawOut = data['stdout'] ?? '';
                            const rawPty = data['pty'] ?? '';
                            const rawErr = data['stderr'] ?? '';
                            if (rawOut) {
                                const d = decodeBase64(rawOut);
                                if (d)
                                    await opts?.onStdout?.(d);
                            }
                            if (rawPty) {
                                const d = decodeBase64(rawPty);
                                if (d)
                                    await opts?.onStdout?.(d);
                            }
                            if (rawErr) {
                                const d = decodeBase64(rawErr);
                                if (d)
                                    await opts?.onStderr?.(d);
                            }
                        }
                    }
                }
                catch {
                    // stream ended or aborted
                }
            })();
            return handle;
        }
        // Foreground: wait for 'end' event
        try {
            const result = await consumeSSEUntilEnd(gen, opts?.onStdout, opts?.onStderr);
            return throwIfNonZero(result);
        }
        catch (err) {
            if (err.name === 'AbortError') {
                // Process was aborted by timeoutMs — return non-zero exit code
                return { stdout: '', stderr: '', exitCode: -1, error: 'aborted' };
            }
            throw err;
        }
    }
    /** Send data to a process's stdin. */
    async sendStdin(pid, data, opts) {
        await connectRPC(this.config.envdUrl, 'process.Process/SendInput', {
            process: { pid },
            input: { stdin: encodeBase64(data) },
        }, this.rpcHeaders, this.abortSignal(opts?.requestTimeoutMs));
    }
    /** Close stdin of a process (triggers EOF). */
    async closeStdin(pid, opts) {
        await connectRPC(this.config.envdUrl, 'process.Process/CloseStdin', { process: { pid } }, this.rpcHeaders, this.abortSignal(opts?.requestTimeoutMs));
    }
    /** Send a signal to a process by PID. */
    async sendSignal(pid, signal, opts) {
        await connectRPC(this.config.envdUrl, 'process.Process/SendSignal', { process: { pid }, signal }, this.rpcHeaders, this.abortSignal(opts?.requestTimeoutMs));
    }
    /** Connect to an already-running process by tag and stream its output. */
    async connectByTag(tag, opts) {
        const ac = new AbortController();
        if (opts?.timeoutMs)
            setTimeout(() => ac.abort(), opts.timeoutMs);
        const headers = {
            'Connect-Protocol-Version': '1',
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
        };
        if (this.config.accessToken)
            headers['X-Access-Token'] = this.config.accessToken;
        const res = await fetch(`${this.config.envdUrl}/process.Process/Connect`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ process: { tag } }),
            signal: ac.signal,
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw parseAPIError(res.status, err);
        }
        const gen = parseSSE(res);
        // Wait for start event to get PID.
        // Use gen.next() directly to avoid for-await-break calling gen.return().
        let pid = 0;
        while (true) {
            const step = await gen.next();
            if (step.done)
                break;
            const raw = step.value;
            const event = (raw['event'] ?? {});
            if (event['start'] != null) {
                pid = Number(event['start']['pid'] ?? 0);
                break;
            }
        }
        const handle = new CommandHandle(pid, gen, ac, this.config);
        // Drain events in background, notifying callbacks
        (async () => {
            try {
                for await (const raw of gen) {
                    const event = (raw['event'] ?? {});
                    if (event['data'] != null) {
                        const data = event['data'];
                        const rawOut = data['stdout'] ?? '';
                        const rawPty = data['pty'] ?? '';
                        const rawErr = data['stderr'] ?? '';
                        if (rawOut) {
                            const d = decodeBase64(rawOut);
                            if (d)
                                await opts?.onStdout?.(d);
                        }
                        if (rawPty) {
                            const d = decodeBase64(rawPty);
                            if (d)
                                await opts?.onStdout?.(d);
                        }
                        if (rawErr) {
                            const d = decodeBase64(rawErr);
                            if (d)
                                await opts?.onStderr?.(d);
                        }
                    }
                }
            }
            catch {
                // stream ended or aborted — expected
            }
        })();
        return handle;
    }
    /** Send SIGKILL to the process matching tag. */
    async killByTag(tag, opts) {
        try {
            await connectRPC(this.config.envdUrl, 'process.Process/SendSignal', { process: { tag }, signal: 'SIGKILL' }, this.rpcHeaders, this.abortSignal(opts?.requestTimeoutMs));
            return true;
        }
        catch {
            return false;
        }
    }
    /** Send data to the stdin of the process matching tag. */
    async sendStdinByTag(tag, data, opts) {
        await connectRPC(this.config.envdUrl, 'process.Process/SendInput', {
            process: { tag },
            input: { stdin: encodeBase64(data) },
        }, this.rpcHeaders, this.abortSignal(opts?.requestTimeoutMs));
    }
    /**
     * Fetch structured output for a completed process by cmdId.
     * Call after receiving the 'end' SSE event. Returns {exitCode, stdout, stderr, startedAtUnix}.
     */
    async getResult(cmdId, opts) {
        return connectRPC(this.config.envdUrl, 'process.Process/GetResult', { cmdId }, this.rpcHeaders, this.abortSignal(opts?.requestTimeoutMs));
    }
    /**
     * Execute a command synchronously via the v2 agent-friendly API (POST /v2/run).
     * No Connect header required. Returns {stdout, stderr, exit_code, duration_ms, error?}.
     */
    async runV2(cmd, opts) {
        const body = { cmd };
        if (opts?.cwd)
            body['cwd'] = opts.cwd;
        if (opts?.env)
            body['env'] = opts.env;
        if (opts?.timeout != null)
            body['timeout'] = opts.timeout;
        if (opts?.stdin != null)
            body['stdin'] = opts.stdin;
        const res = await fetch(`${this.config.envdUrl}/v2/run`, {
            method: 'POST',
            headers: { ...this.rpcHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: this.abortSignal(opts?.requestTimeoutMs),
        });
        const raw = await res.json().catch(() => ({}));
        if (!res.ok) throw parseAPIError(res.status, raw);
        return raw;
    }
}
// ---------------------------------------------------------------------------
// Pty
// ---------------------------------------------------------------------------
export class Pty {
    config;
    constructor(config) {
        this.config = config;
    }
    get rpcHeaders() {
        const h = {
            'Connect-Protocol-Version': '1',
            'Content-Type': 'application/json',
        };
        if (this.config.accessToken)
            h['X-Access-Token'] = this.config.accessToken;
        return h;
    }
    get sseHeaders() {
        return { ...this.rpcHeaders, 'Accept': 'text/event-stream' };
    }
    abortSignal(requestTimeoutMs) {
        const ms = requestTimeoutMs ?? this.config.requestTimeoutMs;
        return AbortSignal.timeout(ms);
    }
    /** Create a new PTY process. Returns a CommandHandle. */
    async create(opts) {
        const ac = new AbortController();
        if (opts.timeoutMs)
            setTimeout(() => ac.abort(), opts.timeoutMs);
        const ptyProcess = { cmd: '/bin/bash' };
        if (opts.envs)
            ptyProcess['envs'] = opts.envs;
        if (opts.cwd)
            ptyProcess['cwd'] = opts.cwd;
        const body = {
            process: ptyProcess,
            pty: { size: { rows: opts.size.rows, cols: opts.size.cols ?? 80 } },
        };
        if (opts.timeoutMs != null && opts.timeoutMs !== 0)
            body['timeout'] = Math.floor(opts.timeoutMs / 1000);
        const res = await fetch(`${this.config.envdUrl}/process.Process/Start`, {
            method: 'POST',
            headers: this.sseHeaders,
            body: JSON.stringify(body),
            signal: ac.signal,
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw parseAPIError(res.status, err);
        }
        const gen = parseSSE(res);
        // Wait for the 'start' event to get the PID.
        // Use gen.next() directly to avoid for-await-break closing the generator.
        let pid = 0;
        while (true) {
            const step = await gen.next();
            if (step.done)
                break;
            const raw = step.value;
            const event = (raw['event'] ?? {});
            if (event['start'] != null) {
                const start = event['start'];
                pid = Number(start['pid'] ?? 0);
                break;
            }
        }
        return new CommandHandle(pid, gen, ac, this.config);
    }
    /** Kill a PTY process by PID using SIGKILL. */
    async kill(pid, opts) {
        try {
            await connectRPC(this.config.envdUrl, 'process.Process/SendSignal', { process: { pid }, signal: 'SIGKILL' }, this.rpcHeaders, this.abortSignal(opts?.requestTimeoutMs));
            return true;
        }
        catch {
            return false;
        }
    }
    /** Resize the PTY. */
    async resize(pid, size, opts) {
        await connectRPC(this.config.envdUrl, 'process.Process/Update', {
            process: { pid },
            pty: { size: { rows: size.rows, cols: size.cols ?? 80 } },
        }, this.rpcHeaders, this.abortSignal(opts?.requestTimeoutMs));
    }
    /** Send raw input bytes to a PTY process (encoded as base64). */
    async sendInput(pid, data, opts) {
        await connectRPC(this.config.envdUrl, 'process.Process/SendInput', {
            process: { pid },
            input: { pty: encodeBase64Bytes(data) },
        }, this.rpcHeaders, this.abortSignal(opts?.requestTimeoutMs));
    }
}
