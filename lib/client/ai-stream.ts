/** Shared SSE decoder. Network chunks are not event boundaries. */
export class AiRequestError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'AiRequestError';
  }
}

export async function consumeAiStream(
  response: Response,
  onText: (text: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  if (!response.ok) {
    let message = `AI 请求失败（${response.status}）`;
    try {
      const body: unknown = await response.json();
      if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
        message = body.error;
      }
    } catch { /* Non-JSON errors retain their HTTP status. */ }
    if (response.status === 401) message = '请先登录后使用 AI 解读。';
    throw new AiRequestError(message, response.status);
  }
  if (!response.body) throw new AiRequestError('模型没有返回响应流。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];
  let text = '';
  let completed = false;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  const emit = () => {
    if (!dataLines.length) return;
    const data = dataLines.join('\n');
    dataLines = [];
    if (data === '[DONE]') { completed = true; return; }
    let event: unknown;
    try { event = JSON.parse(data); }
    catch { throw new AiRequestError('模型响应格式异常，请重试。'); }
    if (!event || typeof event !== 'object') throw new AiRequestError('模型响应格式异常。');
    if ('error' in event) {
      throw new AiRequestError(typeof event.error === 'string' ? event.error : '模型解读中断，请重试。');
    }
    if ('delta' in event && event.delta && typeof event.delta === 'object' && 'text' in event.delta) {
      if (typeof event.delta.text !== 'string') throw new AiRequestError('模型响应内容格式异常。');
      text += event.delta.text;
      onText(text);
    }
  };
  const drain = () => {
    let newline: number;
    while (!completed && (newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (!line) emit();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  };
  try {
    while (!completed) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) {
        buffer += decoder.decode();
        if (buffer) buffer += '\n';
        drain();
        if (!completed) emit();
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 262144) throw new AiRequestError('模型响应事件过大。');
      drain();
    }
    if (!completed) throw new AiRequestError('模型连接提前结束，解读可能不完整，请重试。');
    if (!text.trim()) throw new AiRequestError('模型返回了空内容，请检查模型配置。');
    return text;
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function aiErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'AI 解读失败，请稍后重试。';
}
