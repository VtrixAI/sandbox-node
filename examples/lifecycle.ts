/**
 * lifecycle.ts — 停止 / 启动 / 延期 / 更新 / 列表 / 删除
 *
 * Run: npx ts-node examples/lifecycle.ts
 */
import { Client, ListOptions, UpdateOptions, Payload } from '../src';

async function main() {
  const client = new Client({
    baseURL: 'http://localhost:8080',
    token: 'your-token',
    serviceID: 'seaclaw',
  });

  // ── 列表查询 ──────────────────────────────────────────
  const result = await client.list({ status: 'active', limit: 10 } satisfies ListOptions);
  console.log(`Active sandboxes: ${result.items.length} (total=${result.pagination.total})`);
  for (const info of result.items) {
    console.log(`  ${info.id}  status=${info.status.padEnd(10)}  expires=${info.expire_at}`);
  }

  // ── 创建 ─────────────────────────────────────────────
  const sb = await client.create({
    user_id: 'user-123',
    ttl_hours: 1,
    payloads: [{ api: '/api/v1/env', body: { LOG_LEVEL: 'info' } }] satisfies Payload[],
  });
  console.log(`\nCreated: ${sb.info.id}`);

  // ── 查询单个 ──────────────────────────────────────────
  const info = await client.get(sb.info.id);
  console.log(`Get: status=${info.status}, ip=${info.ip}`);

  // ── 延期 (12h = 43_200_000 ms) ────────────────────────
  await sb.extend(client, 43_200_000);
  console.log('Extended TTL by 12h');

  // ── 更新配置 ──────────────────────────────────────────
  await sb.update(client, {
    payloads: [{ api: '/api/v1/env', body: { LOG_LEVEL: 'debug' } }],
  } satisfies UpdateOptions);
  console.log('Updated payloads');

  // ── 立即应用配置 ──────────────────────────────────────
  await sb.configure(client);
  console.log('Configured');

  // ── 刷新本地 info ─────────────────────────────────────
  await sb.refresh(client);
  console.log(`Refreshed: status=${sb.info.status}`);

  // ── 停止 / 启动 ───────────────────────────────────────
  await sb.stop(client);
  console.log('Stopped');
  await sleep(2000);

  await sb.start(client);
  console.log('Started');

  // ── 重启 ──────────────────────────────────────────────
  await sb.restart(client);
  console.log('Restarted');

  // ── 删除 ──────────────────────────────────────────────
  sb.close();
  await sb.delete(client);
  console.log(`Deleted ${sb.info.id}`);
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

main().catch(console.error);
