import type { ChatMessage } from '@/types/sona';
import { normalizeMessageContent } from '@/features/workspace/conversationTurns';

function messageKey(message: ChatMessage): string {
  const role = message.role || '';
  const content = normalizeMessageContent(message.content).slice(0, 120);
  const ts = message.timestamp || '';
  const tool = message.tool_name || '';
  const toolId = message.tool_call_id || '';
  return `${role}|${content}|${ts}|${tool}|${toolId}`;
}

function messagesMatch(a: ChatMessage, b: ChatMessage): boolean {
  if (a.role !== b.role) return false;
  const contentA = normalizeMessageContent(a.content);
  const contentB = normalizeMessageContent(b.content);
  if (contentA && contentB) {
    if (contentA === contentB) return true;
    if (contentA.length > 20 && contentB.startsWith(contentA.slice(0, 80))) return true;
    if (contentB.length > 20 && contentA.startsWith(contentB.slice(0, 80))) return true;
  }
  if (a.role === 'tool' && b.role === 'tool') {
    return (
      (a.tool_call_id || '') === (b.tool_call_id || '') &&
      (a.tool_name || '') === (b.tool_name || '')
    );
  }
  return !contentA && !contentB;
}

function dedupeMessages(messages: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  for (const message of messages) {
    const prev = result[result.length - 1];
    if (prev && messagesMatch(prev, message)) continue;
    result.push(message);
  }
  return result;
}

function serverContainsMessage(server: ChatMessage[], candidate: ChatMessage): boolean {
  return server.some((item) => messagesMatch(item, candidate));
}

function appendLocalTail(server: ChatMessage[], local: ChatMessage[]): ChatMessage[] {
  if (!local.length) return server;
  const merged = [...server];
  let index = 0;
  while (index < local.length) {
    const candidate = local[index];
    if (!serverContainsMessage(server, candidate)) {
      const tail = local.slice(index);
      return dedupeMessages([...merged, ...tail]);
    }
    index += 1;
  }
  return dedupeMessages(merged);
}

/**
 * Merge persisted server messages with optimistic local state.
 * Server order is authoritative; unmatched local tail is preserved.
 */
export function mergeSessionMessages(
  local: ChatMessage[],
  server: ChatMessage[],
): ChatMessage[] {
  if (!server.length) return dedupeMessages(local);
  if (!local.length) return server;
  return appendLocalTail(server, local);
}

export { messageKey, messagesMatch, dedupeMessages };
