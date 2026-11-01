export type AiMessage = { role: 'user' | 'assistant'; content: string };

// Keep the latest question intact, within the server's 20-message / 48k budget.
// Long historical answers are excerpts; the full conversation stays visible.
export function prepareAiMessages(history: readonly AiMessage[]): AiMessage[] {
  const candidates = history.filter(message => message.content.trim());
  const latest = candidates[candidates.length - 1];
  if (!latest || latest.role !== 'user' || latest.content.length > 12000) {
    throw new Error('请输入不超过 12000 字符的问题。');
  }
  const result: AiMessage[] = [];
  let total = 0;
  for (let index = candidates.length - 1; index >= 0 && result.length < 20; index--) {
    const message = candidates[index];
    const content = message.content.length <= 12000 ? message.content
      : `${message.content.slice(0, 5900)}\n[较长历史回答已节选]\n${message.content.slice(-5900)}`;
    if (total + content.length > 48000) break;
    result.unshift({ role: message.role, content });
    total += content.length;
  }
  return result;
}
