import { parseAPIError, NotFoundError } from './errors.js';
import type {
  ConnectionConfig,
  EntryInfo,
  FileType,
  FilesystemEvent,
  FilesystemListOpts,
  FilesystemRequestOpts,
  WatchOpts,
  WriteEntry,
  WriteInfo,
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

// ---------------------------------------------------------------------------
// WatchHandle
// ---------------------------------------------------------------------------

export class WatchHandle {
  private abortController: AbortController;

  constructor(ac: AbortController) {
    this.abortController = ac;
  }

  stop(): void {
    this.abortController.abort();
  }
}

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

export class Filesystem {
  constructor(private config: ConnectionConfig) {}

  private get headers(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.config.accessToken) h['X-Access-Token'] = this.config.accessToken;
    else if (this.config.apiKey) h['X-API-Key'] = this.config.apiKey;
    return h;
  }

  private abortSignal(requestTimeoutMs?: number): AbortSignal {
    const ms = requestTimeoutMs ?? this.config.requestTimeoutMs;
    return AbortSignal.timeout(ms);
  }

  private mapEntry(raw: Record<string, unknown>): EntryInfo {
    return {
      name: raw['name'] as string ?? '',
      type: raw['type'] as FileType | undefined,
      path: raw['path'] as string ?? '',
      size: Number(raw['size'] ?? 0),
      mode: Number(raw['mode'] ?? 0),
      permissions: raw['permissions'] as string ?? '',
      owner: raw['owner'] as string ?? '',
      group: raw['group'] as string ?? '',
      modifiedTime: raw['modifiedTime'] != null
        ? new Date(raw['modifiedTime'] as string)
        : undefined,
      symlinkTarget: raw['symlinkTarget'] as string | undefined,
    };
  }

  // exists: POST /filesystem.Filesystem/Stat — check for 404
  async exists(path: string, opts?: FilesystemRequestOpts): Promise<boolean> {
    try {
      await connectRPC(
        this.config.envdUrl,
        'filesystem.Filesystem/Stat',
        { path },
        this.headers,
        this.abortSignal(opts?.requestTimeoutMs)
      );
      return true;
    } catch (err) {
      if (err instanceof NotFoundError) return false;
      throw err;
    }
  }

  // getInfo: POST /filesystem.Filesystem/Stat
  async getInfo(path: string, opts?: FilesystemRequestOpts): Promise<EntryInfo> {
    const raw = await connectRPC(
      this.config.envdUrl,
      'filesystem.Filesystem/Stat',
      { path },
      this.headers,
      this.abortSignal(opts?.requestTimeoutMs)
    ) as Record<string, unknown>;
    // Stat response wraps the entry: {"entry": {...}}
    const entry = (raw['entry'] ?? raw) as Record<string, unknown>;
    return this.mapEntry(entry);
  }

  // list: POST /filesystem.Filesystem/ListDir body: {path, depth}
  async list(path: string, opts?: FilesystemListOpts): Promise<EntryInfo[]> {
    const raw = await connectRPC(
      this.config.envdUrl,
      'filesystem.Filesystem/ListDir',
      { path, depth: opts?.depth },
      this.headers,
      this.abortSignal(opts?.requestTimeoutMs)
    ) as { entries?: Record<string, unknown>[] };
    return (raw.entries ?? []).map((e) => this.mapEntry(e));
  }

  // makeDir: POST /filesystem.Filesystem/MakeDir body: {path}
  async makeDir(path: string, opts?: FilesystemRequestOpts): Promise<boolean> {
    await connectRPC(
      this.config.envdUrl,
      'filesystem.Filesystem/MakeDir',
      { path },
      this.headers,
      this.abortSignal(opts?.requestTimeoutMs)
    );
    return true;
  }

  // read overloads
  async read(
    path: string,
    opts?: FilesystemRequestOpts & { format?: 'text' }
  ): Promise<string>;
  async read(
    path: string,
    opts: FilesystemRequestOpts & { format: 'bytes' }
  ): Promise<Uint8Array>;
  async read(
    path: string,
    opts: FilesystemRequestOpts & { format: 'blob' }
  ): Promise<Blob>;
  async read(
    path: string,
    opts: FilesystemRequestOpts & { format: 'stream' }
  ): Promise<ReadableStream<Uint8Array>>;
  async read(
    path: string,
    opts?: FilesystemRequestOpts & { format?: 'text' | 'bytes' | 'blob' | 'stream' }
  ): Promise<string | Uint8Array | Blob | ReadableStream<Uint8Array>> {
    const url = `${this.config.envdUrl}/files?path=${encodeURIComponent(path)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: this.headers,
      signal: this.abortSignal(opts?.requestTimeoutMs),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { code?: number; message?: string };
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
        if (!res.body) throw new Error('No response body');
        return res.body;
      default:
        return res.text();
    }
  }

  // remove: POST /filesystem.Filesystem/Remove body: {path}
  async remove(path: string, opts?: FilesystemRequestOpts): Promise<void> {
    await connectRPC(
      this.config.envdUrl,
      'filesystem.Filesystem/Remove',
      { path },
      this.headers,
      this.abortSignal(opts?.requestTimeoutMs)
    );
  }

  // rename: POST /filesystem.Filesystem/Move body: {path, newPath}
  async rename(
    oldPath: string,
    newPath: string,
    opts?: FilesystemRequestOpts
  ): Promise<EntryInfo> {
    const raw = await connectRPC(
      this.config.envdUrl,
      'filesystem.Filesystem/Move',
      { source: oldPath, destination: newPath },
      this.headers,
      this.abortSignal(opts?.requestTimeoutMs)
    ) as Record<string, unknown>;
    return this.mapEntry(raw);
  }

  // write single file: PUT /files?path=... with body as octet-stream
  async write(
    path: string,
    data: string | ArrayBuffer | Blob | ReadableStream,
    opts?: FilesystemRequestOpts
  ): Promise<WriteInfo>;
  // write multiple files: POST /files/batch
  async write(
    files: WriteEntry[],
    opts?: FilesystemRequestOpts
  ): Promise<WriteInfo[]>;
  async write(
    pathOrFiles: string | WriteEntry[],
    dataOrOpts?: string | ArrayBuffer | Blob | ReadableStream | FilesystemRequestOpts,
    opts?: FilesystemRequestOpts
  ): Promise<WriteInfo | WriteInfo[]> {
    if (Array.isArray(pathOrFiles)) {
      // Batch write
      const files = pathOrFiles;
      const batchOpts = dataOrOpts as FilesystemRequestOpts | undefined;
      return this.writeBatch(files, batchOpts);
    }

    // Single file write
    const path = pathOrFiles;
    const data = dataOrOpts as string | ArrayBuffer | Blob | ReadableStream;
    const url = `${this.config.envdUrl}/files?path=${encodeURIComponent(path)}`;

    let body: BodyInit;
    if (typeof data === 'string') {
      body = data;
    } else if (data instanceof ArrayBuffer) {
      body = data;
    } else if (data instanceof Blob) {
      body = data;
    } else {
      // ReadableStream
      body = data as ReadableStream;
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
      const err = await res.json().catch(() => ({})) as { code?: number; message?: string };
      throw parseAPIError(res.status, err);
    }

    const raw = await res.json() as Record<string, unknown>;
    return {
      name: raw['name'] as string ?? '',
      path: raw['path'] as string ?? '',
      type: raw['type'] as FileType | undefined,
    };
  }

  private async writeBatch(
    files: WriteEntry[],
    opts?: FilesystemRequestOpts
  ): Promise<WriteInfo[]> {
    // Build JSON body: { "files": [{ "path", "content" }, ...] }
    const fileEntries: Array<{ path: string; content: string }> = [];
    for (const file of files) {
      let content: string;
      if (typeof file.data === 'string') {
        content = file.data;
      } else if (file.data instanceof ArrayBuffer) {
        content = Buffer.from(file.data).toString('base64');
      } else if (file.data instanceof Blob) {
        const buf = await file.data.arrayBuffer();
        content = Buffer.from(buf).toString('base64');
      } else {
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
      const err = await res.json().catch(() => ({})) as { code?: number; message?: string };
      throw parseAPIError(res.status, err);
    }

    const raw = await res.json() as { files?: Record<string, unknown>[] };
    return (raw.files ?? []).map((f) => ({
      name: (f['path'] as string ?? '').split('/').pop() ?? '',
      path: f['path'] as string ?? '',
      type: f['type'] as FileType | undefined,
    }));
  }

  // edit: POST /filesystem.Filesystem/Edit body: {path, oldText, newText}
  async edit(
    path: string,
    oldText: string,
    newText: string,
    opts?: FilesystemRequestOpts
  ): Promise<void> {
    await connectRPC(
      this.config.envdUrl,
      'filesystem.Filesystem/Edit',
      { path, oldText, newText },
      this.headers,
      this.abortSignal(opts?.requestTimeoutMs)
    );
  }

  // watchDir: POST /filesystem.Filesystem/WatchDir — SSE streaming
  async watchDir(
    path: string,
    onEvent: (event: FilesystemEvent) => void | Promise<void>,
    opts?: WatchOpts
  ): Promise<WatchHandle> {
    const ac = new AbortController();

    // If a timeoutMs is given, auto-abort after that duration
    if (opts?.timeoutMs) {
      setTimeout(() => ac.abort(), opts.timeoutMs);
    }

    const res = await fetch(
      `${this.config.envdUrl}/filesystem.Filesystem/WatchDir`,
      {
        method: 'POST',
        headers: {
          'Connect-Protocol-Version': '1',
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          ...this.headers,
        },
        body: JSON.stringify({ path, recursive: opts?.recursive ?? false }),
        signal: ac.signal,
      }
    );

    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { code?: number; message?: string };
      throw parseAPIError(res.status, err);
    }

    // Consume SSE in background
    (async () => {
      try {
        for await (const event of parseSSE(res)) {
          const fsEvent: FilesystemEvent = {
            name: event['name'] as string ?? '',
            type: event['type'] as string ?? '',
          };
          await onEvent(fsEvent);
        }
        opts?.onExit?.();
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          opts?.onExit?.();
        } else {
          opts?.onExit?.(err as Error);
        }
      }
    })();

    return new WatchHandle(ac);
  }
}
