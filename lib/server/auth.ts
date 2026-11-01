import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ApiError } from './http';

const COOKIE = 'ziwei_session';
const LIFETIME = 8 * 60 * 60;
function secrets() {
  const password = process.env.ZIWEI_ADMIN_PASSWORD || '';
  const secret = process.env.ZIWEI_SESSION_SECRET || '';
  if (password.length < 16 || secret.length < 32) throw new ApiError(503, '管理员登录尚未配置，请联系站点管理员。');
  return { password, secret };
}
const digest = (value: string) => createHash('sha256').update(value).digest();
function sign(payload: string): string {
  const { password, secret } = secrets();
  return createHmac('sha256', secret).update(`${payload}.${digest(password).toString('hex')}`).digest('base64url');
}
export function passwordMatches(value: unknown): boolean {
  const { password } = secrets();
  return typeof value === 'string' && value.length <= 1024 && timingSafeEqual(digest(value), digest(password));
}
export function newSession(): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + LIFETIME, nonce: randomBytes(24).toString('base64url') })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
export function sessionIdentity(request: Request): string | null {
  const token = (request.headers.get('cookie') || '').split(';').map(x => x.trim()).find(x => x.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!token || token.length > 1024) return null;
  try {
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra || !timingSafeEqual(digest(signature), digest(sign(payload)))) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!Number.isInteger(data.exp) || data.exp <= Date.now() / 1000 || typeof data.nonce !== 'string') return null;
    return data.nonce;
  } catch { return null; }
}
export function requireSession(request: Request): string {
  const identity = sessionIdentity(request);
  if (!identity) throw new ApiError(401, '请先前往 /settings 登录，再使用 AI 解读。');
  return identity;
}
export function sessionCookie(request: Request, token: string, remove = false): string {
  const secure = new URL(process.env.NEXT_PUBLIC_SITE_URL || request.url).protocol === 'https:';
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${remove ? 0 : LIFETIME}${secure ? '; Secure' : ''}`;
}
