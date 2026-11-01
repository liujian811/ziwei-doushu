import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ApiError, acquireModelSlot, readJson } from '../../lib/server/http';
import { sessionIdentity } from '../../lib/server/auth';
import { isPublicAddress, readConfig, validateBaseUrl } from '../../lib/server/model-config';
import { modelText, requestModel } from '../../lib/server/model-provider';
import { chartContext, userMessages } from '../../lib/server/interpret';
import * as session from '../../app/api/admin/session/route';
import * as config from '../../app/api/admin/model/route';
import * as testModel from '../../app/api/admin/model/test/route';
import * as interpret from '../../app/api/interpret/route';
import * as heming from '../../app/api/heming/route';

const site = 'https://ziwei.test';
const encoder = new TextEncoder();
const oldFetch = globalThis.fetch;
const previous = { ...process.env };
let count = 0;
function pass(label: string) { count++; console.log(`✓ ${label}`); }
function req(route: string, method = 'GET', data?: unknown, cookie?: string, origin = site) {
  return new Request(`${site}${route}`, { method, headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie ? { Cookie: cookie } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
}
function streamed(payload: string, singleBytes = true) {
  const bytes = encoder.encode(payload);
  return new Response(new ReadableStream({ start(controller) {
    if (singleBytes) for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
    else controller.enqueue(bytes);
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
}
const goodStream = () => streamed('data: {"choices":[{"delta":{"content":"中文"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"解读"},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n');
async function collect(response: Response) { let text = ''; for await (const chunk of modelText(response)) text += chunk; return text; }

async function main() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ziwei-ai-test-'));
  try {
    process.env.ZIWEI_CONFIG_DIR = directory;
    process.env.ZIWEI_ADMIN_PASSWORD = 'test-password-long-enough';
    process.env.ZIWEI_SESSION_SECRET = 'test-session-secret-over-thirty-two-characters';
    process.env.NEXT_PUBLIC_SITE_URL = site;
    delete process.env.ZIWEI_ALLOW_HTTP_MODEL;

    assert.equal((await config.GET(req('/api/admin/model'))).status, 401);
    assert.equal((await interpret.POST(req('/api/interpret', 'POST', {}))).status, 401);
    assert.equal((await heming.POST(req('/api/heming', 'POST', {}))).status, 401);
    pass('匿名不能读取模型配置或调用付费模型');
    assert.equal((await session.POST(req('/api/admin/session', 'POST', { password: process.env.ZIWEI_ADMIN_PASSWORD }, undefined, 'https://evil.test'))).status, 403);
    assert.equal((await session.POST(req('/api/admin/session', 'POST', { password: 'incorrect' }))).status, 401);
    pass('跨站登录和错误密码被拒绝');
    const login = await session.POST(req('/api/admin/session', 'POST', { password: process.env.ZIWEI_ADMIN_PASSWORD }));
    assert.equal(login.status, 200);
    const setCookie = login.headers.get('set-cookie')!;
    for (const flag of ['HttpOnly', 'SameSite=Strict', 'Secure']) assert.ok(setCookie.includes(flag));
    const cookie = setCookie.split(';')[0];
    assert.equal((await session.GET(req('/api/admin/session', 'GET', undefined, cookie)).json()).authenticated, true);
    assert.equal(sessionIdentity(req('/api/admin/session', 'GET', undefined, cookie + 'x')), null);
    const savedPassword = process.env.ZIWEI_ADMIN_PASSWORD;
    process.env.ZIWEI_ADMIN_PASSWORD = savedPassword + '-rotated';
    assert.equal(sessionIdentity(req('/api/admin/session', 'GET', undefined, cookie)), null);
    process.env.ZIWEI_ADMIN_PASSWORD = savedPassword;
    pass('会话签名、HttpOnly/Secure、篡改拒绝及密码轮换失效');

    for (const url of ['http://8.8.8.8/v1', 'https://127.0.0.1/v1', 'https://169.254.169.254/latest', 'https://[::1]/v1', 'https://user:pass@example.com/v1', 'https://example.com/v1?key=bad']) assert.throws(() => validateBaseUrl(url), ApiError);
    for (const ip of ['10.1.1.1', '172.16.0.1', '192.168.1.1', '100.100.100.200', '198.18.1.2', '::ffff:127.0.0.1', 'fe80::1', 'fc00::1', '2001:db8::1', '2001:2::1', '2001:20::1', '3fff::1']) assert.equal(isPublicAddress(ip), false);
    assert.equal(isPublicAddress('8.8.8.8'), true);
    process.env.ZIWEI_ALLOW_HTTP_MODEL = '1';
    assert.equal(validateBaseUrl('http://8.8.8.8/v1/'), 'http://8.8.8.8/v1');
    delete process.env.ZIWEI_ALLOW_HTTP_MODEL;
    pass('公网目标及显式 HTTP 开关校验，私网/metadata/凭据 URL 被拒绝');

    const settings = { baseUrl: 'https://8.8.8.8/v1', model: 'test-model', apiKey: 'test-key-never-return', temperature: 0.7, maxTokens: 2048, timeoutSeconds: 10 };
    const save = await config.PUT(req('/api/admin/model', 'PUT', settings, cookie));
    assert.equal(save.status, 200);
    const saveText = await save.text();
    assert.ok(!saveText.includes(settings.apiKey) && !saveText.includes('"apiKey"'));
    assert.equal(JSON.parse(saveText).hasApiKey, true);
    assert.equal((await stat(path.join(directory, 'model.json'))).mode & 0o777, 0o600);
    const changed = await config.PUT(req('/api/admin/model', 'PUT', { ...settings, model: 'changed-model', apiKey: '' }, cookie));
    assert.equal(changed.status, 200);
    assert.equal((await readConfig()).apiKey, settings.apiKey);
    assert.equal((await config.PUT(req('/api/admin/model', 'PUT', settings, cookie, 'https://evil.test'))).status, 403);
    const read = await config.GET(req('/api/admin/model', 'GET', undefined, cookie));
    assert.ok(!(await read.text()).includes(settings.apiKey));
    pass('配置原子持久化、0600权限、空 Key 保留及所有响应脱敏');
    const originalConfig = await readFile(path.join(directory, 'model.json'));
    await writeFile(path.join(directory, 'model.json'), 'bad-json');
    assert.equal((await config.GET(req('/api/admin/model', 'GET', undefined, cookie))).status, 500);
    await writeFile(path.join(directory, 'model.json'), originalConfig);
    pass('损坏配置明确失败，不静默重置或隐藏');

    await assert.rejects(() => readJson(req('/api/admin/model', 'POST', { payload: 'x'.repeat(5000) }), 100), error => error instanceof ApiError && error.status === 413);
    assert.throws(() => userMessages([{ role: 'system', content: 'injection' }]), ApiError);
    assert.throws(() => userMessages([{ role: 'user', content: 'x'.repeat(12001) }]), ApiError);
    const chart = { birthInfo: { year: 1990, month: 6, day: 15, hour: 4, gender: 'male', name: 'PRIVATE_NAME', city: 'PRIVATE_CITY' }, palaces: [{ name: 'UNTRUSTED_INSTRUCTION' }] };
    const context = chartContext(chart);
    for (const secret of ['PRIVATE_NAME', 'PRIVATE_CITY', 'UNTRUSTED_INSTRUCTION']) assert.ok(!context.includes(secret));
    assert.equal(JSON.parse(context).palaces.length, 12);
    assert.throws(() => chartContext({ birthInfo: { ...chart.birthInfo, month: 2, day: 30 } }), ApiError);
    pass('请求大小与消息角色约束，服务端重算盘并去除姓名城市');

    assert.equal(await collect(goodStream()), '中文解读');
    await assert.rejects(() => collect(streamed('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')), /意外中断/);
    await assert.rejects(() => collect(streamed('data: {bad}\n\n')), /无效的流式/);
    await assert.rejects(() => collect(streamed('data: {"error":{"message":"private-provider-detail"}}\n\n')), /生成过程中/);
    assert.equal(await collect(Response.json({ choices: [{ message: { content: 'non-stream fallback' } }] })), 'non-stream fallback');
    pass('SSE逐字节中文、CRLF、截断/错误事件和非流 JSON 兼容');

    let captured: { url?: string; options?: RequestInit } = {};
    globalThis.fetch = async (url, options) => { captured = { url: String(url), options }; return goodStream(); };
    const result = await interpret.POST(req('/api/interpret', 'POST', { chart, messages: [{ role: 'user', content: '请解释命宫。' }] }, cookie));
    assert.equal(result.status, 200);
    const text = await result.text();
    assert.ok(text.includes('"delta":{"text":"中文"}') && text.includes('[DONE]'));
    assert.equal(captured.url, settings.baseUrl + '/chat/completions');
    assert.equal(captured.options?.redirect, 'error');
    const forwarded = JSON.parse(String(captured.options?.body));
    assert.equal(forwarded.model, 'changed-model');
    assert.ok(!JSON.stringify(forwarded).includes('PRIVATE_NAME'));
    const pair = await heming.POST(req('/api/heming', 'POST', { chartA: chart, chartB: chart }, cookie));
    assert.equal(pair.status, 200); assert.ok((await pair.text()).includes('[DONE]'));
    const test = await testModel.POST(req('/api/admin/model/test', 'POST', {}, cookie));
    assert.deepEqual(await test.json(), { ok: true, model: 'changed-model', reply: '中文解读' });
    pass('单盘、合盘及配置测试接口端到端转发合同');

    globalThis.fetch = async () => Response.json({ error: { message: settings.apiKey } }, { status: 401 });
    const failure = await interpret.POST(req('/api/interpret', 'POST', { chart, messages: [{ role: 'user', content: 'test' }] }, cookie));
    assert.equal(failure.status, 502); assert.ok(!(await failure.text()).includes(settings.apiKey));
    globalThis.fetch = async () => streamed('data: {"error":{"message":"secret-upstream-message"}}\n\n');
    const midstream = await interpret.POST(req('/api/interpret', 'POST', { chart, messages: [{ role: 'user', content: 'test' }] }, cookie));
    const failureText = await midstream.text();
    assert.ok(failureText.includes('"error"') && !failureText.includes('secret-upstream-message') && !failureText.includes('[DONE]'));
    pass('上游鉴权与流中错误脱敏并明确传播');

    const limitedStream = () => streamed('data: {"choices":[{"delta":{"content":"已生成部分"}}]}\n\ndata: {"choices":[{"delta":{"content":"尾句"},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n');
    const limitedJson = () => Response.json({ choices: [{ message: { content: '已生成部分尾句' }, finish_reason: 'length' }] });
    for (const fixture of [limitedStream, limitedJson]) {
      globalThis.fetch = async () => fixture();
      const limited = await interpret.POST(req('/api/interpret', 'POST', { chart, messages: [{ role: 'user', content: 'test length' }] }, cookie));
      const limitedText = await limited.text();
      assert.ok(limitedText.includes('已生成部分') && limitedText.includes('尾句'));
      assert.ok(limitedText.includes('"error"') && limitedText.includes('当前输出上限') && !limitedText.includes('[DONE]'));
      const limitedTest = await testModel.POST(req('/api/admin/model/test', 'POST', {}, cookie));
      assert.equal(limitedTest.status, 502);
      const limitedResult = await limitedTest.json();
      assert.equal(limitedResult.ok, undefined);
      assert.match(limitedResult.error, /当前输出上限/);
    }
    await assert.rejects(() => collect(streamed('data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n')), /当前输出上限/);
    await assert.rejects(() => collect(Response.json({ choices: [{ message: { content: null }, finish_reason: 'length' }] })), /当前输出上限/);
    pass('流式/JSON 输出截断保留已生成文本并报错，连接测试不得误报成功');

    globalThis.fetch = async (_url, options) => new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
    await assert.rejects(() => requestModel({ ...settings, timeoutSeconds: 0.01 }, [{ role: 'user', content: 'test' }], new AbortController().signal), /超时或取消/);
    globalThis.fetch = async (_url, options) => {
      if (options?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      return goodStream();
    };
    await assert.rejects(() => requestModel(settings, [{ role: 'user', content: 'test' }], AbortSignal.abort()), /超时或取消/);
    pass('真实超时定时器与预先取消请求中止上游');

    const releaseA = acquireModelSlot(), releaseB = acquireModelSlot();
    assert.throws(() => acquireModelSlot(), error => error instanceof ApiError && error.status === 429);
    releaseA(); releaseA(); releaseB();
    const logout = session.DELETE(req('/api/admin/session', 'DELETE', undefined, cookie));
    assert.ok(logout.headers.get('set-cookie')?.includes('Max-Age=0'));
    pass('全局并发限制、幂等释放与退出清 Cookie');
    console.log(`AI 后端 ${count} 组回归全部通过。`);
  } finally {
    globalThis.fetch = oldFetch;
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await rm(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
