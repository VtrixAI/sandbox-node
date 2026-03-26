import { StopOptions, UpdateOptions, Payload, SandboxError } from './types';
import type { Sandbox } from './sandbox';

/** Re-fetch metadata from Atlas and update sandbox.info. */
export async function refresh(sb: Sandbox): Promise<void> {
  sb.info = await sb._client.get(sb.info.id);
}

export async function stop(sb: Sandbox, opts?: StopOptions): Promise<void> {
  await sb._client._doPost(`/api/v1/sandbox/${sb.info.id}/stop`);
  if (!opts?.blocking) return;

  const interval = opts.pollIntervalMs ?? 2000;
  const deadline = opts.timeoutMs ?? 300_000;
  const start = Date.now();

  while (Date.now() - start < deadline) {
    await new Promise<void>((res) => setTimeout(res, interval));
    sb.info = await sb._client.get(sb.info.id);
    if (sb.info.status === 'stopped' || sb.info.status === 'failed') return;
  }
  throw new SandboxError(`stop timeout: sandbox ${sb.info.id} did not reach stopped state`);
}

export async function start(sb: Sandbox): Promise<void> {
  await sb._client._doPost(`/api/v1/sandbox/${sb.info.id}/start`);
}

export async function restart(sb: Sandbox): Promise<void> {
  await sb._client._doPost(`/api/v1/sandbox/${sb.info.id}/restart`);
}

/** Extend TTL by hours. Pass 0 to use the server default (12h). */
export async function extend(sb: Sandbox, hours = 0): Promise<void> {
  await sb._client._doPost(`/api/v1/sandbox/${sb.info.id}/extend`, { hours });
}

/** Extend TTL by hours and refresh info. Pass 0 to use the server default (12h). */
export async function extendTimeout(sb: Sandbox, hours = 0): Promise<void> {
  await extend(sb, hours);
  await refresh(sb);
}

export async function update(sb: Sandbox, opts: UpdateOptions): Promise<void> {
  const body: Record<string, unknown> = {};
  if (opts.spec)     body['spec']     = opts.spec;
  if (opts.image)    body['image']    = opts.image;
  if (opts.payloads) body['payloads'] = opts.payloads;
  await sb._client._doPatch(`/api/v1/sandbox/${sb.info.id}`, body);
}

export async function configure(sb: Sandbox, payloads?: Payload[]): Promise<void> {
  const body = payloads ? { payloads } : undefined;
  await sb._client._doPost(`/api/v1/sandbox/${sb.info.id}/configure`, body);
}

export async function deleteSandbox(sb: Sandbox): Promise<void> {
  await sb._client.delete(sb.info.id);
}

export function close(sb: Sandbox): void {
  sb._ws.close();
}
