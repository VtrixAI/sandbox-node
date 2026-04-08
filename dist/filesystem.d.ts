import type { ConnectionConfig, EntryInfo, FilesystemEvent, FilesystemListOpts, FilesystemRequestOpts, WatchOpts, WriteEntry, WriteInfo } from './types.js';
export declare class WatchHandle {
    private abortController;
    constructor(ac: AbortController);
    stop(): void;
}
export declare class Filesystem {
    private config;
    constructor(config: ConnectionConfig);
    private get headers();
    private abortSignal;
    private mapEntry;
    exists(path: string, opts?: FilesystemRequestOpts): Promise<boolean>;
    getInfo(path: string, opts?: FilesystemRequestOpts): Promise<EntryInfo>;
    list(path: string, opts?: FilesystemListOpts): Promise<EntryInfo[]>;
    makeDir(path: string, opts?: FilesystemRequestOpts): Promise<boolean>;
    read(path: string, opts?: FilesystemRequestOpts & {
        format?: 'text';
    }): Promise<string>;
    read(path: string, opts: FilesystemRequestOpts & {
        format: 'bytes';
    }): Promise<Uint8Array>;
    read(path: string, opts: FilesystemRequestOpts & {
        format: 'blob';
    }): Promise<Blob>;
    read(path: string, opts: FilesystemRequestOpts & {
        format: 'stream';
    }): Promise<ReadableStream<Uint8Array>>;
    remove(path: string, opts?: FilesystemRequestOpts): Promise<void>;
    rename(oldPath: string, newPath: string, opts?: FilesystemRequestOpts): Promise<EntryInfo>;
    write(path: string, data: string | ArrayBuffer | Blob | ReadableStream, opts?: FilesystemRequestOpts): Promise<WriteInfo>;
    write(files: WriteEntry[], opts?: FilesystemRequestOpts): Promise<WriteInfo[]>;
    private writeBatch;
    edit(path: string, oldText: string, newText: string, opts?: FilesystemRequestOpts): Promise<void>;
    watchDir(path: string, onEvent: (event: FilesystemEvent) => void | Promise<void>, opts?: WatchOpts): Promise<WatchHandle>;
}
