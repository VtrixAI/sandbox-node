import * as fsp from 'fs/promises';
import * as path from 'path';
import { WriteFileEntry, ReadResult, WriteResult, EditResult, FileOptions, DownloadEntry, FileEntry, FileInfo, RpcResponse, SandboxError } from './types';
import type { Sandbox } from './sandbox';

export async function read(sb: Sandbox, filePath: string): Promise<ReadResult> {
  const resp = await sb._call('read', { path: filePath });
  return resp.result as ReadResult;
}

export async function write(sb: Sandbox, filePath: string, content: string): Promise<WriteResult> {
  const resp = await sb._call('write', { path: filePath, content });
  return resp.result as WriteResult;
}

export async function edit(sb: Sandbox, filePath: string, oldText: string, newText: string): Promise<EditResult> {
  const resp = await sb._call('edit', { path: filePath, old_text: oldText, new_text: newText });
  return resp.result as EditResult;
}

/** Write multiple files. content is raw bytes (base64-encoded over the wire).
 * If WriteFileEntry.mode is set, that Unix permission is applied after writing.
 */
export async function writeFiles(sb: Sandbox, files: WriteFileEntry[]): Promise<void> {
  for (const f of files) {
    const encoded = Buffer.from(f.content).toString('base64');
    const params: Record<string, unknown> = { path: f.path, data: encoded };
    if (f.mode !== undefined) params['mode'] = f.mode;
    await sb._call('write_binary', params);
  }
}

/** Read a file and return its raw bytes. Returns null if the file does not exist. */
export async function readToBuffer(sb: Sandbox, filePath: string): Promise<Buffer | null> {
  let result: ReadResult;
  try {
    result = await read(sb, filePath);
  } catch (e) {
    if (e instanceof SandboxError && e.code === -32001) return null; // file not found
    throw e;
  }
  if (result.type === 'image') {
    return Buffer.from(result.data ?? '', 'base64');
  }
  return Buffer.from(result.content ?? '', 'utf-8');
}

/** Create a directory (and all parents) inside the sandbox. */
export async function mkDir(sb: Sandbox, dirPath: string): Promise<void> {
  await sb.runCommand(`mkdir -p ${JSON.stringify(dirPath)}`);
}

/**
 * Download a file from the sandbox to a local path.
 * Returns the absolute local path of the saved file, or null if the file does not exist.
 */
export async function downloadFile(sb: Sandbox, sandboxPath: string, localPath: string, opts?: FileOptions): Promise<string | null> {
  const data = await readToBuffer(sb, sandboxPath);
  if (data === null) return null;
  const abs = path.resolve(localPath);
  if (opts?.mkdirRecursive) {
    await fsp.mkdir(path.dirname(abs), { recursive: true });
  }
  await fsp.writeFile(abs, data);
  return abs;
}

/**
 * Download multiple files concurrently from the sandbox to local paths.
 * Returns a map of sandboxPath → absolute local path (null if file not found).
 * Rejects on first error. At most 8 downloads run in parallel.
 */
export async function downloadFiles(sb: Sandbox, files: DownloadEntry[], opts?: FileOptions): Promise<Map<string, string | null>> {
  const limit = 8;
  const results: [string, string | null][] = [];
  for (let i = 0; i < files.length; i += limit) {
    const batch = files.slice(i, i + limit);
    const batchResults = await Promise.all(
      batch.map(async (f) => {
        const localPath = await downloadFile(sb, f.sandboxPath, f.localPath, opts);
        return [f.sandboxPath, localPath] as [string, string | null];
      }),
    );
    results.push(...batchResults);
  }
  return new Map(results);
}

/**
 * Upload a local file into the sandbox at sandboxPath.
 * If opts.mkdirRecursive is true, parent directories are created in the sandbox first.
 */
export async function uploadFile(sb: Sandbox, localPath: string, sandboxPath: string, opts?: FileOptions): Promise<void> {
  const data = await fsp.readFile(localPath);
  if (opts?.mkdirRecursive) {
    await mkDir(sb, path.posix.dirname(sandboxPath));
  }
  const encoded = Buffer.from(data).toString('base64');
  await sb._call('write_binary', { path: sandboxPath, data: encoded });
}

/** List the contents of a directory inside the sandbox. */
export async function listFiles(sb: Sandbox, dirPath: string): Promise<FileEntry[]> {
  const resp = await sb._call('list_files', { path: dirPath });
  return resp.result as FileEntry[];
}

/**
 * Return metadata about a file or directory inside the sandbox.
 * FileInfo.exists will be false if the path does not exist (no error raised).
 */
export async function stat(sb: Sandbox, filePath: string): Promise<FileInfo> {
  const resp = await sb._call('stat', { path: filePath });
  return resp.result as FileInfo;
}

/** Report whether the given path exists inside the sandbox. */
export async function exists(sb: Sandbox, filePath: string): Promise<boolean> {
  const info = await stat(sb, filePath);
  return info.exists;
}

/**
 * Stream a file in chunks, yielding decoded Buffer per chunk.
 * Useful for large files. chunkSize defaults to 64KB.
 */
export async function* readStream(sb: Sandbox, filePath: string, chunkSize = 65536): AsyncGenerator<Buffer> {
  const notifications: (RpcResponse | null)[] = [];
  let head = 0;
  let notify: (() => void) | null = null;

  const onNotification = (msg: RpcResponse | null): void => {
    notifications.push(msg);
    notify?.();
  };

  const callPromise = sb._call('read_stream', { path: filePath, chunk_size: chunkSize }, undefined, onNotification);

  while (true) {
    if (head < notifications.length) {
      const msg = notifications[head++]!;
      if (msg === null) break;
      if (msg.method === 'read_stream.chunk') {
        const params = msg.params as Record<string, unknown> | undefined;
        const data = String(params?.['data'] ?? '');
        if (data) yield Buffer.from(data, 'base64');
      }
    } else {
      await new Promise<void>((res) => { notify = res; });
      notify = null;
    }
  }

  await callPromise; // propagate errors
}

/** Return the publicly accessible URL for the given port on this sandbox. */
export function domain(sb: Sandbox, port: number): string {
  if (sb.info.preview_host) {
    return `https://${port}-${sb.info.preview_host}`;
  }
  return sb.info.preview_url;
}
