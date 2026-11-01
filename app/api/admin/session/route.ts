import { newSession, passwordMatches, sessionCookie, sessionIdentity } from '@/lib/server/auth';
import { ApiError, checkOrigin, errorResponse, json, rateLimit, readJson, requestIdentity } from '@/lib/server/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: Request) { return json({ authenticated: !!sessionIdentity(request) }); }
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    rateLimit('login', requestIdentity(request), 8, 15 * 60_000);
    const body = await readJson(request, 4096);
    if (!passwordMatches(body.password)) throw new ApiError(401, '管理员密码不正确。');
    return json({ authenticated: true }, 200, { 'Set-Cookie': sessionCookie(request, newSession()) });
  } catch (error) { return errorResponse(error); }
}
export function DELETE(request: Request) {
  try { checkOrigin(request); return json({ authenticated: false }, 200, { 'Set-Cookie': sessionCookie(request, '', true) }); }
  catch (error) { return errorResponse(error); }
}
