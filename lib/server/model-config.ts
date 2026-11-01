import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { ApiError } from './http';

export interface ModelConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  temperature: number;
  maxTokens: number;
  timeoutSeconds: number;
}
export const DEFAULT_CONFIG: ModelConfig = { baseUrl: '', model: '', apiKey: '', temperature: 0.7, maxTokens: 2048, timeoutSeconds: 90 };
function configPath(): string {
  const dir = process.env.ZIWEI_CONFIG_DIR;
  if (!dir || !path.isAbsolute(dir)) throw new ApiError(503, '模型配置存储目录尚未设置。');
  return path.join(dir, 'model.json');
}
export function publicConfig(config: ModelConfig) {
  const { apiKey, ...safe } = config;
  return { ...safe, hasApiKey: !!apiKey, configured: !!(config.baseUrl && config.model && apiKey) };
}
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 2))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) === 6) {
    const value = address.toLowerCase();
    const [first, second] = value.split(':').map(part => Number.parseInt(part || '0', 16));
    // Globally routable unicast only; reject special-use /23, documentation
    // and 6to4 prefixes as well as all mapped/translated IPv4 forms.
    return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 && first !== 0x3fff &&
      !(first === 0x2001 && (second < 0x200 || second === 0xdb8));
  }
  return false;
}
export function validateBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1024) throw new ApiError(400, '模型 API 地址无效。');
  let url: URL;
  try { url = new URL(value); } catch { throw new ApiError(400, '请输入完整的模型 API 地址。'); }
  const allowed = url.protocol === 'https:' || (url.protocol === 'http:' && process.env.ZIWEI_ALLOW_HTTP_MODEL === '1');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!allowed || url.username || url.password || url.search || url.hash ||
      host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      (!isIP(host) && !host.includes('.')) || (isIP(host) && !isPublicAddress(host))) {
    throw new ApiError(400, '模型地址须为获准协议的公网地址，不能包含账号、查询参数或片段。');
  }
  return url.toString().replace(/\/+$/, '');
}
export async function validateDestination(baseUrl: string): Promise<void> {
  const host = new URL(validateBaseUrl(baseUrl)).hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return;
  let addresses;
  try { addresses = await lookup(host, { all: true }); }
  catch { throw new ApiError(502, '模型 API 域名无法解析，请检查地址。'); }
  if (!addresses.length || addresses.some(x => !isPublicAddress(x.address))) throw new ApiError(400, '模型域名解析到了不允许访问的网络地址。');
}
function numberField(value: unknown, name: string, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new ApiError(400, `${name}应在 ${min} 至 ${max} 之间${integer ? '且为整数' : ''}。`);
  }
  return value;
}
export function validateConfig(input: Record<string, unknown>, previous = DEFAULT_CONFIG): ModelConfig {
  const baseUrl = validateBaseUrl(input.baseUrl);
  if (typeof input.model !== 'string' || !input.model.trim() || input.model.length > 200 || /[\r\n]/.test(input.model)) throw new ApiError(400, '模型名称不能为空或过长。');
  if (input.apiKey !== undefined && typeof input.apiKey !== 'string') throw new ApiError(400, 'API Key 格式错误。');
  const apiKey = typeof input.apiKey === 'string' && input.apiKey.trim() ? input.apiKey.trim() : previous.apiKey;
  if (!apiKey || apiKey.length > 4096 || /[\r\n]/.test(apiKey)) throw new ApiError(400, '请填写有效的 API Key。');
  return {
    baseUrl, model: input.model.trim(), apiKey,
    temperature: numberField(input.temperature ?? previous.temperature, '温度', 0, 2),
    maxTokens: numberField(input.maxTokens ?? previous.maxTokens, '最大输出长度', 128, 8192, true),
    timeoutSeconds: numberField(input.timeoutSeconds ?? previous.timeoutSeconds, '超时时间', 10, 180, true),
  };
}
export async function readConfig(): Promise<ModelConfig> {
  let raw: string;
  try { raw = await readFile(configPath(), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_CONFIG };
    throw error;
  }
  try { return validateConfig(JSON.parse(raw)); }
  catch { throw new ApiError(500, '已保存的模型配置无法读取，请联系管理员修复。'); }
}
let writeQueue = Promise.resolve();
export function saveConfig(input: Record<string, unknown>): Promise<ModelConfig> {
  const operation = writeQueue.then(async () => {
    const config = validateConfig(input, await readConfig());
    await validateDestination(config.baseUrl);
    const destination = configPath();
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    const temp = `${destination}.${randomBytes(8).toString('hex')}.tmp`;
    try { await writeFile(temp, JSON.stringify(config) + '\n', { mode: 0o600, flag: 'wx' }); await rename(temp, destination); }
    catch (error) { await unlink(temp).catch(() => {}); throw error; }
    return config;
  });
  writeQueue = operation.then(() => {}, () => {});
  return operation;
}
