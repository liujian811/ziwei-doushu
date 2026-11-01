import { requireSession } from '@/lib/server/auth';
import { checkOrigin, errorResponse, json, rateLimit, readJson } from '@/lib/server/http';
import { publicConfig, readConfig, saveConfig } from '@/lib/server/model-config';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try { requireSession(request); return json(publicConfig(await readConfig())); }
  catch (error) { return errorResponse(error); }
}
export async function PUT(request: Request) {
  try {
    requireSession(request); checkOrigin(request); rateLimit('config', 'shared-admin', 20, 60_000);
    return json(publicConfig(await saveConfig(await readJson(request, 16 * 1024))));
  } catch (error) { return errorResponse(error); }
}
