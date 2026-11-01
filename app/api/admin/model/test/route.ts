import { requireSession } from '@/lib/server/auth';
import { acquireModelSlot, ApiError, checkOrigin, errorResponse, json, rateLimit } from '@/lib/server/http';
import { publicConfig, readConfig } from '@/lib/server/model-config';
import { modelText, requestModel, type ModelRequest } from '@/lib/server/model-provider';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  let release: (() => void) | undefined, upstream: ModelRequest | undefined;
  try {
    requireSession(request); checkOrigin(request); rateLimit('model-test', 'shared-admin', 5, 60_000);
    const config = await readConfig();
    if (!publicConfig(config).configured) throw new ApiError(503, '请先保存完整模型配置。');
    release = acquireModelSlot();
    upstream = await requestModel(config, [{ role: 'user', content: '连接测试。请只用中文回复：连接成功。' }], request.signal, 64);
    let reply = '';
    for await (const text of modelText(upstream.response)) reply += text;
    return json({ ok: true, model: config.model, reply: reply.slice(0, 1000) });
  } catch (error) { return errorResponse(error); }
  finally { upstream?.cancel(); upstream?.finish(); release?.(); }
}
