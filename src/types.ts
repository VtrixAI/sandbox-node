/** A single initialisation call bundled with sandbox creation/update. */
export interface Payload {
  api: string;
  body?: unknown;
}

export interface SandboxInfo {
  id: string;
  user_id: string;
  namespace: string;
  status: string;
  ip: string;
  preview_url: string;
  preview_host: string;
  port: number;
  image_tag: string;
  spec?: Spec;
  labels: Record<string, string>;
  created_at: string;
  allocated_at: string;
  expire_at: string;
  last_active_at: string;
}

export interface Spec {
  cpu?: string;
  memory?: string;
  image?: string;
}

export interface CreateOptions {
  user_id: string;
  spec?: Spec;
  labels?: Record<string, string>;
  payloads?: Payload[];
  ttl_hours?: number;
  /** Bearer token — not serialised to JSON */
  token?: string;
  /** X-Service-ID — not serialised to JSON */
  service_id?: string;
  /** Default env variables inherited by all commands — not serialised to JSON */
  env?: Record<string, string>;
}

export interface ExecOptions {
  working_dir?: string;
  timeout_sec?: number;
  env?: Record<string, string>;
  /** Prepend "sudo -E" to the command inside the sandbox. */
  sudo?: boolean;
  /** Data written to the command's stdin before reading output. */
  stdin?: string;
}

/** Options for Sandbox.downloadFile. */
export interface DownloadOptions {
  /** Create local parent directories if they don't exist. */
  mkdirRecursive?: boolean;
}

/** A single file to download from the sandbox. */
export interface DownloadEntry {
  sandboxPath: string;
  localPath: string;
}

/** Options for Sandbox.stop. */
export interface StopOptions {
  /** Poll until status is "stopped" or "failed". */
  blocking?: boolean;
  /** Poll interval in milliseconds (default 2000). */
  pollIntervalMs?: number;
  /** Maximum time to wait in milliseconds (default 300_000). */
  timeoutMs?: number;
}

export interface ExecResult {
  cmd_id: string;
  output: string;
  exit_code: number;
}

/** Result of executeDetached — identifies the background command. */
export interface DetachedResult {
  cmd_id: string;
  pid: number;
}

/** A single line of output from a running command. */
export interface LogEvent {
  stream: 'stdout' | 'stderr';
  data: string;
}

/** A single file entry for writeFiles. content is raw bytes. */
export interface WriteFileEntry {
  path: string;
  content: Buffer | Uint8Array;
}

export interface ExecEvent {
  type: 'start' | 'stdout' | 'stderr' | 'done';
  data?: string;
}

export interface ReadResult {
  type: 'text' | 'image';
  content?: string;
  truncated?: boolean;
  mime_type?: string;
  data?: string;
}

export interface WriteResult {
  bytes_written: number;
}

export interface EditResult {
  message: string;
}

/** A single file or directory entry returned by Sandbox.listFiles(). */
export interface FileEntry {
  name: string;
  path: string;
  size: number;
  is_dir: boolean;
  modified_at?: string;  // RFC 3339 or undefined
}

/** File metadata returned by Sandbox.stat(). */
export interface FileInfo {
  exists: boolean;
  size: number;
  is_dir: boolean;
  is_file: boolean;
  modified_at?: string;  // RFC 3339 or undefined
}

export interface ClientOptions {
  baseURL: string;
  token?: string;
  serviceID?: string;
}

export interface ListOptions {
  user_id?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export interface Pagination {
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}

export interface ListResult {
  items: SandboxInfo[];
  pagination: Pagination;
}

export interface UpdateOptions {
  spec?: Spec;
  image?: string;
  /** Replaces all stored payloads and triggers a sandbox restart. */
  payloads?: Payload[];
}

// ── Internal wire types ───────────────────────────────────

export interface AtlasEnvelope<T = unknown> {
  code: number;
  message: string;
  data: T;
  request_id?: string;
}

export interface RpcRequest {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
  id?: number;
}

export interface RpcResponse {
  jsonrpc: '2.0';
  method?: string;       // present for notifications
  params?: unknown;      // present for notifications
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  id?: number;
}

export class SandboxError extends Error {
  constructor(message: string, public readonly code: number = 0) {
    super(message);
    this.name = 'SandboxError';
  }
}
