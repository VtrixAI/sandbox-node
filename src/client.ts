import WebSocket from 'ws';
import {
  ClientOptions, CreateOptions, SandboxInfo,
  AtlasEnvelope, SandboxError,
  ListOptions, ListResult, Pagination, UpdateOptions,
} from './types';
import { Sandbox } from './sandbox';

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS  = 180_000;

export class Client {
  private readonly baseURL: string;
  private readonly token: string;
  private readonly serviceID: string;

  constructor(opts: ClientOptions) {
    this.baseURL = opts.baseURL.replace(/\/$/, '');
    this.token = opts.token ?? '';
    this.serviceID = opts.serviceID ?? '';
  }

  async create(opts: CreateOptions): Promise<Sandbox> {
    const info = await this._createSandbox(opts);
    const active = await this._pollUntilActive(info.id, opts);
    return this._connect(active, opts);
  }

  async attach(sandboxId: string, token?: string, serviceID?: string): Promise<Sandbox> {
    const opts: CreateOptions = { user_id: '', token, service_id: serviceID };
    const info = await this._getSandbox(sandboxId, opts);
    return this._connect(info, opts);
  }

  // ── Lifecycle ────────────────────────────────────────────

  async list(opts?: ListOptions): Promise<ListResult> {
    const resp = await fetch(`${this.baseURL}/api/v1/sandbox/list`, {
      method: 'POST',
      headers: this._authHeaders({ user_id: '' }),
      body: JSON.stringify(opts ?? {}),
    });
    const env = await resp.json() as AtlasEnvelope<{ items: SandboxInfo[]; pagination: Pagination }>;
    checkAtlas(env);
    return { items: env.data.items ?? [], pagination: env.data.pagination };
  }

  async get(sandboxId: string): Promise<SandboxInfo> {
    return this._getSandbox(sandboxId, { user_id: '' });
  }

  async delete(sandboxId: string): Promise<void> {
    const resp = await fetch(`${this.baseURL}/api/v1/sandbox/${sandboxId}`, {
      method: 'DELETE',
      headers: this._authHeaders({ user_id: '' }),
    });
    const env = await resp.json() as AtlasEnvelope;
    checkAtlas(env);
  }

  /** @internal used by Sandbox lifecycle methods */
  async _doPost(path: string, body?: unknown): Promise<void> {
    const resp = await fetch(`${this.baseURL}${path}`, {
      method: 'POST',
      headers: this._authHeaders({ user_id: '' }),
      body: JSON.stringify(body ?? {}),
    });
    const env = await resp.json() as AtlasEnvelope;
    checkAtlas(env);
  }

  /** @internal used by Sandbox.update */
  async _doPatch(path: string, body: unknown): Promise<void> {
    const resp = await fetch(`${this.baseURL}${path}`, {
      method: 'PATCH',
      headers: this._authHeaders({ user_id: '' }),
      body: JSON.stringify(body),
    });
    const env = await resp.json() as AtlasEnvelope;
    checkAtlas(env);
  }

  // ── HTTP helpers ────────────────────────────────────────

  private _authHeaders(opts: CreateOptions): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = opts.token ?? this.token;
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const sid = opts.service_id ?? this.serviceID;
    if (sid) headers['X-Service-ID'] = sid;
    return headers;
  }

  private async _createSandbox(opts: CreateOptions): Promise<SandboxInfo> {
    const body: Record<string, unknown> = { user_id: opts.user_id };
    if (opts.spec)     body['spec']     = opts.spec;
    if (opts.labels)   body['labels']   = opts.labels;
    if (opts.payloads) body['payloads'] = opts.payloads;
    if (opts.ttl_hours) body['ttl_hours'] = opts.ttl_hours;

    const resp = await fetch(`${this.baseURL}/api/v1/sandbox/create`, {
      method: 'POST',
      headers: this._authHeaders(opts),
      body: JSON.stringify(body),
    });
    const env = await resp.json() as AtlasEnvelope<{ sandbox: SandboxInfo }>;
    checkAtlas(env);
    return env.data.sandbox;
  }

  private async _getSandbox(id: string, opts: CreateOptions): Promise<SandboxInfo> {
    const resp = await fetch(`${this.baseURL}/api/v1/sandbox/${id}`, {
      headers: this._authHeaders(opts),
    });
    const env = await resp.json() as AtlasEnvelope<SandboxInfo>;
    checkAtlas(env);
    return env.data;
  }

  private async _pollUntilActive(id: string, opts: CreateOptions): Promise<SandboxInfo> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      let info: SandboxInfo;
      try {
        info = await this._getSandbox(id, opts);
      } catch {
        continue;
      }
      if (info.status === 'active') return info;
      if (info.status === 'stopped' || info.status === 'destroying') {
        throw new SandboxError(`sandbox ${id} entered terminal status '${info.status}'`);
      }
    }
    throw new SandboxError(`timed out waiting for sandbox ${id} to become active`);
  }

  private _connect(info: SandboxInfo, opts: CreateOptions): Sandbox {
    const wsURL = this.baseURL
      .replace(/^https:\/\//, 'wss://')
      .replace(/^http:\/\//, 'ws://');
    const url = `${wsURL}/api/v1/sandbox/${info.id}/connect`;

    const headers: Record<string, string> = {};
    const token = opts.token ?? this.token;
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const sid = opts.service_id ?? this.serviceID;
    if (sid) headers['X-Service-ID'] = sid;

    // Pass token as a WebSocket subprotocol so browsers can authenticate.
    // Browsers cannot set custom HTTP headers during WebSocket handshake;
    // the server reads the Sec-WebSocket-Protocol header and echoes it back.
    const protocols: string[] = token ? [`bearer.${token}`] : [];

    const ws = new WebSocket(url, protocols, { headers });
    return new Sandbox(info, ws, opts.env ?? {});
  }
}

function checkAtlas(env: AtlasEnvelope): void {
  if (env.code !== 0) {
    throw new SandboxError(env.message, env.code);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
