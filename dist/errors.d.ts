export declare class SandboxError extends Error {
    readonly stackTrace?: string | undefined;
    constructor(message?: string, stackTrace?: string | undefined);
}
export declare class TimeoutError extends SandboxError {
    name: string;
}
export declare class NotFoundError extends SandboxError {
    name: string;
}
export declare class AuthenticationError extends SandboxError {
    name: string;
}
export declare class InvalidArgumentError extends SandboxError {
    name: string;
}
export declare class NotEnoughSpaceError extends SandboxError {
    name: string;
}
export declare class RateLimitError extends SandboxError {
    name: string;
}
export declare class TemplateError extends SandboxError {
    name: string;
}
export declare class BuildError extends SandboxError {
    name: string;
}
export declare class FileUploadError extends SandboxError {
    name: string;
}
export declare class CommandExitError extends SandboxError {
    name: string;
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
    constructor(exitCode: number, stdout: string, stderr: string);
}
export declare function parseAPIError(status: number, body: {
    code?: number;
    message?: string;
}): SandboxError;
