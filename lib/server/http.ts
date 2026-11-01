import { createHash } from 'node:crypto';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
export function errorResponse(error: unknown): Response {
  return error instanceof ApiError
    ? json({ error: error.message }, error.status)
    : json({ error: '服务暂时不可用，请稍后重试或检查服务器配置。' }, 500);
}
export function checkOrigin(request: Request): void {
  const expected = new URL(process.env.NEXT_PUBLIC_SITE_URL || request.url).origin;
  if (request.headers.get('origin') !== expected) throw new ApiError(403, '请求来源不受信任，请从本站重新操作。');
}
export async function readJson(request: Request, maxBytes = 128 * 1024): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new ApiError(415, '请使用 JSON 请求。');
  }
  const declared = Number(request.headers.get('content-length') || 0);
  if (!Number.isFinite(declared) || declared > maxBytes) throw new ApiError(413, '请求内容过大。');
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, '请求内容为空。');
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new ApiError(413, '请求内容过大。'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch { throw new ApiError(400, '请求 JSON 格式错误。'); }
}

type LimitState = { buckets: Map<string, { count: number; until: number }>; active: number };
// Next may bundle routes separately; keep one process-wide limiter for all APIs.
const runtime = globalThis as typeof globalThis & { __ziweiAiLimits?: LimitState };
const state = runtime.__ziweiAiLimits ??= { buckets: new Map(), active: 0 };
const buckets = state.buckets;
export function rateLimit(scope: string, identity: string, limit: number, windowMs: number): void {
  const now = Date.now();
  if (buckets.size >= 5000) for (const [key, value] of buckets) if (value.until <= now) buckets.delete(key);
  const key = `${scope}:${createHash('sha256').update(identity).digest('hex')}`;
  let bucket = buckets.get(key);
  if (!bucket || bucket.until <= now) {
    if (buckets.size >= 5000) throw new ApiError(429, '请求繁忙，请稍后再试。');
    bucket = { count: 0, until: now + windowMs };
    buckets.set(key, bucket);
  }
  if (++bucket.count > limit) throw new ApiError(429, '操作过于频繁，请稍后再试。');
}
export function requestIdentity(request: Request): string {
  // Nginx overwrites X-Real-IP; the application only listens on loopback.
  return request.headers.get('x-real-ip') || 'local';
}
export function acquireModelSlot(): () => void {
  if (state.active >= 2) throw new ApiError(429, '已有两个模型请求正在处理，请稍后再试。');
  state.active++;
  let released = false;
  return () => { if (!released) { released = true; state.active--; } };
}
