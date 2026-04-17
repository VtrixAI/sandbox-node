import { parseAPIError } from './errors.js';

function resolveApiKey(opts) {
    const key = opts?.apiKey ?? process.env['SANDBOX_API_KEY'];
    if (!key) {
        throw new Error('API key required. Set SANDBOX_API_KEY or pass apiKey.');
    }
    return key;
}
function resolveBaseUrl(opts) {
    return (opts?.baseUrl ??
        process.env['SANDBOX_BASE_URL'] ??
        'https://api.sandbox.vtrix.ai').replace(/\/$/, '');
}
export class TemplateClient {
    apiKey;
    baseUrl;
    namespaceId;
    userId;
    requestTimeoutMs;
    constructor(opts) {
        this.apiKey = resolveApiKey(opts);
        this.baseUrl = resolveBaseUrl(opts);
        this.namespaceId = opts?.namespaceId ?? '';
        this.userId = opts?.userId ?? '';
        this.requestTimeoutMs = opts?.requestTimeoutMs ?? 30_000;
    }
    get headers() {
        const h = {
            'X-API-Key': this.apiKey,
            'Content-Type': 'application/json',
        };
        if (this.namespaceId) h['X-Namespace-ID'] = this.namespaceId;
        if (this.userId) h['X-User-ID'] = this.userId;
        return h;
    }
    signal() {
        return AbortSignal.timeout(this.requestTimeoutMs);
    }
    async request(method, path, body, params) {
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
        return raw['data'] ?? raw;
    }
    async create(opts) {
        return this.request('POST', '/api/v1/templates', {
            visibility: 'personal',
            cpuCount: 1,
            memoryMB: 512,
            ttlSeconds: 300,
            ...opts,
        });
    }
    async list(opts) {
        const params = { limit: opts?.limit ?? 50, offset: opts?.offset ?? 0 };
        if (opts?.visibility) params['visibility'] = opts.visibility;
        return this.request('GET', '/api/v1/templates', undefined, params);
    }
    async get(templateId) {
        return this.request('GET', `/api/v1/templates/${templateId}`);
    }
    async getByAlias(alias) {
        return this.request('GET', `/api/v1/templates/aliases/${alias}`);
    }
    async update(templateId, fields) {
        return this.request('PATCH', `/api/v1/templates/${templateId}`, fields);
    }
    async delete(templateId) {
        await this.request('DELETE', `/api/v1/templates/${templateId}`);
    }
    async build(templateId, opts) {
        const body = {};
        if (opts?.fromImage) body['fromImage'] = opts.fromImage;
        if (opts?.filesHash !== undefined) body['filesHash'] = opts.filesHash;
        return this.request('POST', `/api/v1/templates/${templateId}/builds`, body);
    }
    async rollback(templateId, buildId) {
        return this.request('POST', `/api/v1/templates/${templateId}/rollback`, { buildId });
    }
    async listBuilds(templateId, opts) {
        return this.request('GET', `/api/v1/templates/${templateId}/builds`, undefined, {
            limit: opts?.limit ?? 50,
            offset: opts?.offset ?? 0,
        });
    }
    async getBuild(templateId, buildId) {
        return this.request('GET', `/api/v1/templates/${templateId}/builds/${buildId}`);
    }
    async getBuildStatus(templateId, buildId, opts) {
        const params = { logsOffset: opts?.logsOffset ?? 0, limit: opts?.limit ?? 100 };
        if (opts?.level) params['level'] = opts.level;
        return this.request('GET', `/api/v1/templates/${templateId}/builds/${buildId}/status`, undefined, params);
    }
    async getBuildLogs(templateId, buildId, opts) {
        const params = {
            cursor: opts?.cursor ?? 0,
            limit: opts?.limit ?? 100,
            direction: opts?.direction ?? 'forward',
            source: opts?.source ?? 'temporary',
        };
        if (opts?.level) params['level'] = opts.level;
        return this.request('GET', `/api/v1/templates/${templateId}/builds/${buildId}/logs`, undefined, params);
    }
    async getFilesUploadUrl(templateId, filesHash) {
        return this.request('GET', `/api/v1/templates/${templateId}/files/${filesHash}`);
    }
    static async quickBuild(opts) {
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
        return raw;
    }
}
