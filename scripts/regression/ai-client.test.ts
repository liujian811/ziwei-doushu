import assert from 'node:assert/strict';
import { prepareAiMessages } from '../../lib/client/ai-history';
import { AiRequestError, consumeAiStream } from '../../lib/client/ai-stream';

const encoder = new TextEncoder();
function response(parts: Uint8Array[]) {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { for (const part of parts) controller.enqueue(part); controller.close(); },
  }), { headers: { 'content-type': 'text/event-stream' } });
}
async function main() {
  const input = ': keepalive\r\ndata: {"delta":{"text":"紫微"}}\r\n\r\ndata: {"delta":{"text":"命盘"}}\n\ndata: [DONE]\n\ndata: {"error":"must not run"}\n\n';
  const bytes = encoder.encode(input);
  const updates: string[] = [];
  assert.equal(await consumeAiStream(response([...bytes].map(byte => new Uint8Array([byte]))), text => updates.push(text)), '紫微命盘');
  assert.deepEqual(updates, ['紫微', '紫微命盘']);
  const multiline = 'data: {"delta":\ndata: {"text":"你好"}}\n\ndata: [DONE]';
  assert.equal(await consumeAiStream(response([encoder.encode(multiline)]), () => {}), '你好');
  await assert.rejects(consumeAiStream(response([encoder.encode('data: {bad}\n\n')]), () => {}), /响应格式异常/);
  await assert.rejects(consumeAiStream(response([encoder.encode('data: {"error":"额度不足"}\n\n')]), () => {}), /额度不足/);
  await assert.rejects(consumeAiStream(response([encoder.encode('data: {"delta":{"text":"半段"}}\n\n')]), () => {}), /提前结束/);
  await assert.rejects(consumeAiStream(response([encoder.encode('data: [DONE]\n\n')]), () => {}), /空内容/);
  await assert.rejects(consumeAiStream(new Response('{"error":"denied"}', {status:401}), () => {}), error => error instanceof AiRequestError && error.status === 401 && /登录/.test(error.message));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(consumeAiStream(response([bytes]), () => {}, controller.signal), error => error instanceof Error && error.name === 'AbortError');
  const longHistory = Array.from({ length: 24 }, (_, index) => ({
    role: index % 2 ? 'assistant' as const : 'user' as const,
    content: (index % 2 ? '长回答' : '旧问题').repeat(6000),
  }));
  const finalQuestion = { role: 'user' as const, content: '保留最新的问题' };
  const compacted = prepareAiMessages([...longHistory, finalQuestion]);
  assert.deepEqual(compacted[compacted.length - 1], finalQuestion);
  assert.ok(compacted.length <= 20 && compacted.every(message => message.content.length <= 12000));
  assert.ok(compacted.reduce((total, message) => total + message.content.length, 0) <= 48000);
  assert.ok(compacted.some(message => message.content.includes('已节选')));
  assert.throws(() => prepareAiMessages([{role:'user', content:'x'.repeat(12001)}]), /不超过/);
  console.log('AI history: individual, cumulative and count budgets, latest question preservation passed.');
  console.log('AI client SSE: UTF-8 byte splits, CRLF, multiline, DONE, errors, truncation, empty, authentication and cancellation passed.');
}
void main();
