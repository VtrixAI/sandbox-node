// Error classes — mirrors e2b exactly
export class SandboxError extends Error {
    stackTrace;
    constructor(message, stackTrace) {
        super(message);
        this.stackTrace = stackTrace;
        this.name = 'SandboxError';
    }
}
export class TimeoutError extends SandboxError {
    name = 'TimeoutError';
}
export class NotFoundError extends SandboxError {
    name = 'NotFoundError';
}
export class AuthenticationError extends SandboxError {
    name = 'AuthenticationError';
}
export class InvalidArgumentError extends SandboxError {
    name = 'InvalidArgumentError';
}
export class NotEnoughSpaceError extends SandboxError {
    name = 'NotEnoughSpaceError';
}
export class RateLimitError extends SandboxError {
    name = 'RateLimitError';
}
export class TemplateError extends SandboxError {
    name = 'TemplateError';
}
export class BuildError extends SandboxError {
    name = 'BuildError';
}
export class FileUploadError extends SandboxError {
    name = 'FileUploadError';
}
export class CommandExitError extends SandboxError {
    name = 'CommandExitError';
    exitCode;
    stdout;
    stderr;
    constructor(exitCode, stdout, stderr) {
        super(`Process exited with code ${exitCode}`);
        this.exitCode = exitCode;
        this.stdout = stdout;
        this.stderr = stderr;
    }
}
export function parseAPIError(status, body) {
    const msg = body.message ?? `HTTP ${status}`;
    switch (status) {
        case 401:
        case 403:
            return new AuthenticationError(msg);
        case 404:
            return new NotFoundError(msg);
        case 408:
        case 504:
            return new TimeoutError(msg);
        case 422:
            return new InvalidArgumentError(msg);
        case 429:
            return new RateLimitError(msg);
        case 507:
            return new NotEnoughSpaceError(msg);
        default:
            return new SandboxError(msg);
    }
}
