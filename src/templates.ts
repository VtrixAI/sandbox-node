/**
 * Template and build management — wraps the sandbox-builder API.
 *
 * All endpoints live under /api/v1/templates and are proxied through hermes.
 * Auth is X-API-Key (same as sandbox management).
 */

import { parseAPIError } from './errors.js';

export interface TemplateClientOpts {
  apiKey?: string;
  baseUrl?: string;
  namespaceId?: string;
  userId?: string;
  requestTimeoutMs?: number;
}

function resolveApiKey(opts?: Pick<TemplateClientOpts, 'apiKey'>): string {
  const key = opts?.apiKey ?? process.env['SANDBOX_API_KEY'];
  if (!key) {
    throw new Error('API key required. Set SANDBOX_API_KEY or pass apiKey.');
  }
  return key;
}

function resolveBaseUrl(opts?: Pick<TemplateClientOpts, 'baseUrl'>): string {
  return (
    opts?.baseUrl ??
    process.env['SANDBOX_BASE_URL'] ??
    'https://api.sandbox.vtrix.ai'
  ).replace(/\/$/, '');
}

// ---------------------------------------------------------------------------
// TemplateClient
// ---------------------------------------------------------------------------

export class TemplateClient {
  private apiKey: string;
  private baseUrl: string;
  private namespaceId: string;
  private userId: string;
  private requestTimeoutMs: number;

  constructor(opts?: TemplateClientOpts) {
    this.apiKey = resolveApiKey(opts);
    this.baseUrl = resolveBaseUrl(opts);
    this.namespaceId = opts?.namespaceId ?? '';
    this.userId = opts?.userId ?? '';
    this.requestTimeoutMs = opts?.requestTimeoutMs ?? 30_000;
  }

  private get headers(): Record<string, string> {
    const h: Record<string, string> = {
      'X-API-Key': this.apiKey,
      'Content-Type': 'application/json',
    };
    if (this.namespaceId) h['X-Namespace-ID'] = this.namespaceId;
    if (this.userId) h['X-User-ID'] = this.userId;
    return h;
  }

  private signal(): AbortSignal {
    return AbortSignal.timeout(this.requestTimeoutMs);
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    params?: Record<string, string | number>
  ): Promise<unknown> {
    let url = `${this.baseUrl}${path}`;
    if (params) {
      const qs = Object.entries(params)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&');
      url += `?${qs}`;
    }
    const res = await fetch(url, {
      method,
      headers: this.headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: this.signal(),
    });
    if (res.status === 204) return {};
    const raw = await res.json().catch(() => ({}));
    if (!res.ok) throw parseAPIError(res.status, raw);
    return (raw as Record<string, unknown>)['data'] ?? raw;
  }

  // ── Template CRUD ────────────────────────────────────────────────────────

  async create(opts: {
    name: string;
    visibility?: string;
    dockerfile?: string;
    image?: string;
    cpuCount?: number;
    memoryMB?: number;
    envs?: Record<string, string>;
    ttlSeconds?: number;
    storageType?: string;
    storageSizeGB?: number;
    daemonImage?: string;
    cloudsinkURL?: string;
    [key: string]: unknown;
  }): Promise<Record<string, unknown>> {
    return this.request('POST', '/api/v1/templates', {
      visibility: 'personal',
      cpuCount: 1,
      memoryMB: 512,
      ttlSeconds: 300,
      ...opts,
    }) as Promise<Record<string, unknown>>;
  }

  async list(opts?: {
    visibility?: string;
    limit?: number;
    offset?: number;
  }): Promise<Record<string, unknown>> {
    const params: Record<string, string | number> = {
      limit: opts?.limit ?? 50,
      offset: opts?.offset ?? 0,
    };
    if (opts?.visibility) params['visibility'] = opts.visibility;
    return this.request('GET', '/api/v1/templates', undefined, params) as Promise<Record<string, unknown>>;
  }

  async get(templateId: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/api/v1/templates/${templateId}`) as Promise<Record<string, unknown>>;
  }

  async getByAlias(alias: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/api/v1/templates/aliases/${alias}`) as Promise<Record<string, unknown>>;
  }

  async update(templateId: string, fields: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request('PATCH', `/api/v1/templates/${templateId}`, fields) as Promise<Record<string, unknown>>;
  }

  async delete(templateId: string): Promise<void> {
    await this.request('DELETE', `/api/v1/templates/${templateId}`);
  }

  // ── Build operations ─────────────────────────────────────────────────────

  async build(
    templateId: string,
    opts?: { fromImage?: string; filesHash?: string }
  ): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {};
    if (opts?.fromImage) body['fromImage'] = opts.fromImage;
    if (opts?.filesHash !== undefined) body['filesHash'] = opts.filesHash;
    return this.request('POST', `/api/v1/templates/${templateId}/builds`, body) as Promise<Record<string, unknown>>;
  }

  async rollback(templateId: string, buildId: string): Promise<Record<string, unknown>> {
    return this.request('POST', `/api/v1/templates/${templateId}/rollback`, { buildId }) as Promise<Record<string, unknown>>;
  }

  async listBuilds(
    templateId: string,
    opts?: { limit?: number; offset?: number }
  ): Promise<Record<string, unknown>> {
    return this.request('GET', `/api/v1/templates/${templateId}/builds`, undefined, {
      limit: opts?.limit ?? 50,
      offset: opts?.offset ?? 0,
    }) as Promise<Record<string, unknown>>;
  }

  async getBuild(templateId: string, buildId: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/api/v1/templates/${templateId}/builds/${buildId}`) as Promise<Record<string, unknown>>;
  }

  async getBuildStatus(
    templateId: string,
    buildId: string,
    opts?: { logsOffset?: number; limit?: number; level?: string }
  ): Promise<Record<string, unknown>> {
    const params: Record<string, string | number> = {
      logsOffset: opts?.logsOffset ?? 0,
      limit: opts?.limit ?? 100,
    };
    if (opts?.level) params['level'] = opts.level;
    return this.request(
      'GET',
      `/api/v1/templates/${templateId}/builds/${buildId}/status`,
      undefined,
      params
    ) as Promise<Record<string, unknown>>;
  }

  async getBuildLogs(
    templateId: string,
    buildId: string,
    opts?: {
      cursor?: number;
      limit?: number;
      direction?: string;
      level?: string;
      source?: string;
    }
  ): Promise<Record<string, unknown>> {
    const params: Record<string, string | number> = {
      cursor: opts?.cursor ?? 0,
      limit: opts?.limit ?? 100,
      direction: opts?.direction ?? 'forward',
      source: opts?.source ?? 'temporary',
    };
    if (opts?.level) params['level'] = opts.level;
    return this.request(
      'GET',
      `/api/v1/templates/${templateId}/builds/${buildId}/logs`,
      undefined,
      params
    ) as Promise<Record<string, unknown>>;
  }

  async getFilesUploadUrl(
    templateId: string,
    filesHash: string
  ): Promise<{ present: boolean; url?: string }> {
    return this.request(
      'GET',
      `/api/v1/templates/${templateId}/files/${filesHash}`
    ) as Promise<{ present: boolean; url?: string }>;
  }

  /**
   * Directly build an image without pre-creating a template. No auth required.
   */
  static async quickBuild(opts: {
    project: string;
    image: string;
    tag: string;
    dockerfile: string;
    baseUrl?: string;
    requestTimeoutMs?: number;
  }): Promise<{ templateID: string; buildID: string; imageFullName: string }> {
    const baseUrl = resolveBaseUrl(opts);
    const timeoutMs = opts.requestTimeoutMs ?? 30_000;
    const res = await fetch(`${baseUrl}/build`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: opts.project,
        image: opts.image,
        tag: opts.tag,
        dockerfile: opts.dockerfile,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await res.json().catch(() => ({}));
    if (!res.ok) throw parseAPIError(res.status, raw);
    return raw as { templateID: string; buildID: string; imageFullName: string };
  }
}
