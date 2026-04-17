export interface TemplateClientOpts {
    apiKey?: string;
    baseUrl?: string;
    namespaceId?: string;
    userId?: string;
    requestTimeoutMs?: number;
}
export declare class TemplateClient {
    private apiKey;
    private baseUrl;
    private namespaceId;
    private userId;
    private requestTimeoutMs;
    constructor(opts?: TemplateClientOpts);
    private get headers();
    private signal;
    private request;
    create(opts: {
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
    }): Promise<Record<string, unknown>>;
    list(opts?: {
        visibility?: string;
        limit?: number;
        offset?: number;
    }): Promise<Record<string, unknown>>;
    get(templateId: string): Promise<Record<string, unknown>>;
    getByAlias(alias: string): Promise<Record<string, unknown>>;
    update(templateId: string, fields: Record<string, unknown>): Promise<Record<string, unknown>>;
    delete(templateId: string): Promise<void>;
    build(templateId: string, opts?: {
        fromImage?: string;
        filesHash?: string;
    }): Promise<Record<string, unknown>>;
    rollback(templateId: string, buildId: string): Promise<Record<string, unknown>>;
    listBuilds(templateId: string, opts?: {
        limit?: number;
        offset?: number;
    }): Promise<Record<string, unknown>>;
    getBuild(templateId: string, buildId: string): Promise<Record<string, unknown>>;
    getBuildStatus(templateId: string, buildId: string, opts?: {
        logsOffset?: number;
        limit?: number;
        level?: string;
    }): Promise<Record<string, unknown>>;
    getBuildLogs(templateId: string, buildId: string, opts?: {
        cursor?: number;
        limit?: number;
        direction?: string;
        level?: string;
        source?: string;
    }): Promise<Record<string, unknown>>;
    getFilesUploadUrl(templateId: string, filesHash: string): Promise<{
        present: boolean;
        url?: string;
    }>;
    static quickBuild(opts: {
        project: string;
        image: string;
        tag: string;
        dockerfile: string;
        baseUrl?: string;
        requestTimeoutMs?: number;
    }): Promise<{
        templateID: string;
        buildID: string;
        imageFullName: string;
    }>;
}
