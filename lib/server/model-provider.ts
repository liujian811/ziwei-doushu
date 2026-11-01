import type { ModelConfig } from './model-config';
import { validateDestination } from './model-config';
import { ApiError } from './http';

const OUTPUT_LIMIT_MESSAGE = '模型已达到当前输出上限，解读尚未完成。请在 /settings 提高最大输出长度，或继续追问。';

export interface ModelMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface ModelRequest {
  response: Response;
  cancel: () => void;
  finish: () => void;
}
export async function requestModel(config: ModelConfig, messages: ModelMessage[], signal: AbortSignal, maxTokens?: number): Promise<ModelRequest> {
  await validateDestination(config.baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutSeconds * 1000);
  const cancel = () => controller.abort();
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); };
  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ model: config.model, messages, temperature: config.temperature, max_tokens: maxTokens ?? config.maxTokens, stream: true }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) throw new ApiError(502, '模型服务拒绝了 API Key 或模型权限，请检查设置。');
      if (response.status === 429) throw new ApiError(503, '模型服务额度不足或请求繁忙，请稍后重试。');
      throw new ApiError(502, `模型服务请求失败（HTTP ${response.status}），请检查模型地址和名称。`);
    }
    if (!response.body) throw new ApiError(502, '模型服务未返回响应内容。');
    return { response, cancel, finish };
  } catch (error) {
    finish(); cancel();
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, controller.signal.aborted ? '模型请求已超时或取消，请稍后重试。' : '无法连接模型服务，请检查地址及服务器网络。');
  }
}

/** Buffer whole SSE frames, including UTF-8 split across network chunks. */
export async function* modelText(response: Response): AsyncGenerator<string> {
  if (!response.body) throw new ApiError(502, '模型没有返回内容。');
  if (response.headers.get('content-type')?.includes('application/json')) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let value = '';
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        value += decoder.decode(chunk.value, { stream: true });
        if (value.length > 512 * 1024) throw new ApiError(502, '模型返回内容过大。');
      }
      value += decoder.decode();
      const data = JSON.parse(value);
      const choice = data.choices?.[0];
      const content = choice?.message?.content;
      if (data.error || (typeof content !== 'string' && content !== null && content !== undefined)) throw new ApiError(502, '模型未返回有效解读。');
      if (content) yield content;
      if (choice?.finish_reason === 'length') throw new ApiError(502, OUTPUT_LIMIT_MESSAGE);
      if (!content) throw new ApiError(502, '模型未返回有效解读。');
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '', total = 0, produced = false, completed = false, truncated = false;
  function parse(frame: string): string | null {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data) return null;
    if (data === '[DONE]') { completed = true; return null; }
    let payload;
    try { payload = JSON.parse(data); } catch { throw new ApiError(502, '模型返回了无效的流式数据。'); }
    if (payload.error) throw new ApiError(502, '模型在生成过程中返回了错误，请重试或检查设置。');
    const choice = payload.choices?.[0];
    if (choice?.finish_reason && !['stop', 'length'].includes(choice.finish_reason)) throw new ApiError(502, '模型未能完成本次解读，请调整问题后重试。');
    if (choice?.finish_reason === 'length') truncated = true;
    const text = choice?.delta?.content;
    if (text !== undefined && text !== null && typeof text !== 'string') throw new ApiError(502, '模型响应内容格式不兼容。');
    return text || null;
  }
  try {
    while (!completed) {
      const chunk = await reader.read();
      pending += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      total += chunk.value?.byteLength || 0;
      if (total > 1024 * 1024 || pending.length > 256 * 1024) throw new ApiError(502, '模型返回内容超过限制。');
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(pending))) {
        const frame = pending.slice(0, match.index);
        pending = pending.slice(match.index + match[0].length);
        const text = parse(frame);
        if (text) { produced = true; yield text; }
        if (truncated) throw new ApiError(502, OUTPUT_LIMIT_MESSAGE);
        if (completed) break;
      }
      if (chunk.done) {
        if (pending.trim() && !completed) {
          const text = parse(pending);
          if (text) { produced = true; yield text; }
          if (truncated) throw new ApiError(502, OUTPUT_LIMIT_MESSAGE);
        }
        break;
      }
    }
    if (!produced) throw new ApiError(502, '模型未返回解读内容，请检查模型名称或稍后重试。');
    if (!completed) throw new ApiError(502, '模型响应意外中断，请重试。');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export function modelStream(upstream: ModelRequest, release: () => void): Response {
  const encoder = new TextEncoder();
  let cancelled = false;
  const finish = () => { upstream.finish(); release(); };
  return new Response(new ReadableStream({
    async start(controller) {
      const send = (value: unknown) => { if (!cancelled) controller.enqueue(encoder.encode(`data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`)); };
      try {
        for await (const text of modelText(upstream.response)) send({ delta: { text } });
        send('[DONE]');
      } catch (error) {
        send({ error: error instanceof ApiError ? error.message : '模型响应中断或超时，请稍后重试。' });
      } finally {
        upstream.cancel(); finish();
        if (!cancelled) controller.close();
      }
    },
    cancel() { cancelled = true; upstream.cancel(); finish(); },
  }), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' } });
}
