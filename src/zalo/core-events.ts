import axios from 'axios';
import { config } from '../config.js';
import type { ZaloMessage, ZaloMediaContent } from './types.js';

type ThreadTypePayload = 0 | 1 | 'user' | 'group';

interface CoreZaloEventMessage {
  msg_id?: string;
  real_msg_id?: string;
  cli_msg_id?: string;
  global_msg_id?: string;
  msg_type?: string;
  content?: unknown;
  text?: string;
  timestamp?: string;
  ttl?: number;
  quote?: unknown;
}

interface CoreZaloEventPayload {
  event_id: string;
  event_type: string;
  thread_id: string;
  thread_type: ThreadTypePayload;
  thread_name?: string;
  sender_uid?: string;
  sender_name?: string;
  is_self: boolean;
  message: CoreZaloEventMessage;
  raw_json: Record<string, unknown>;
}

let warnedCoreDisabled = false;

function normalizeContent(content: string | ZaloMediaContent | Record<string, unknown>): unknown {
  if (typeof content !== 'string') return content;
  const trimmed = content.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return content;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return content;
  }
}

function textFromContent(content: string | ZaloMediaContent | Record<string, unknown>): string | undefined {
  if (typeof content === 'string') return content;
  const maybeTitle = (content as { title?: unknown }).title;
  return typeof maybeTitle === 'string' ? maybeTitle : undefined;
}

function buildMessagePayload(msg: ZaloMessage): CoreZaloEventMessage {
  const quote = msg.data.quote;
  return {
    msg_id: msg.data.msgId,
    real_msg_id: msg.data.realMsgId,
    cli_msg_id: msg.data.cliMsgId,
    global_msg_id: quote?.globalMsgId !== undefined ? String(quote.globalMsgId) : msg.data.realMsgId,
    msg_type: msg.data.msgType,
    content: normalizeContent(msg.data.content),
    text: textFromContent(msg.data.content),
    timestamp: msg.data.ts,
    ttl: msg.data.ttl,
    quote,
  };
}

function buildMessageEvent(msg: ZaloMessage): CoreZaloEventPayload {
  const threadType = msg.type as 0 | 1;
  const primaryId = msg.data.realMsgId || msg.data.msgId || msg.data.cliMsgId || msg.data.ts;
  return {
    event_id: `zalo:message:${msg.threadId}:${primaryId}`,
    event_type: 'message',
    thread_id: msg.threadId,
    thread_type: threadType,
    sender_uid: msg.data.uidFrom,
    sender_name: msg.data.dName,
    thread_name: msg.data.dName,
    is_self: msg.isSelf,
    message: buildMessagePayload(msg),
    raw_json: msg as unknown as Record<string, unknown>,
  };
}

function buildRawEvent(eventType: string, event: Record<string, unknown>): CoreZaloEventPayload | null {
  const data = (event.data ?? {}) as Record<string, unknown>;
  const content = (data.content ?? {}) as Record<string, unknown>;
  const threadId = String(event.threadId ?? data.groupId ?? data.threadId ?? data.idTo ?? data.fromUid ?? '');
  if (!threadId) return null;
  const rawType = event.type !== undefined ? String(event.type) : eventType;
  const senderUid = String(data.uidFrom ?? data.creatorId ?? data.sourceId ?? data.fromUid ?? '');
  const senderName = String(data.dName ?? data.senderName ?? '');
  const threadName = String(data.groupName ?? data.name ?? data.dName ?? data.senderName ?? '');
  const rawMsgId = content.globalMsgId !== undefined && String(content.globalMsgId) !== '0'
    ? String(content.globalMsgId)
    : content.cliMsgId !== undefined
      ? String(content.cliMsgId)
      : undefined;
  return {
    event_id: `zalo:${eventType}:${threadId}:${rawType}:${Date.now()}`,
    event_type: eventType,
    thread_id: threadId,
    thread_type: eventType === 'group_event' || Boolean(event.isGroup) ? 1 : 0,
    thread_name: threadName || undefined,
    sender_uid: senderUid || undefined,
    sender_name: senderName || undefined,
    is_self: Boolean(event.isSelf),
    message: {
      msg_id: rawMsgId,
      cli_msg_id: content.cliMsgId !== undefined ? String(content.cliMsgId) : undefined,
      global_msg_id: content.globalMsgId !== undefined ? String(content.globalMsgId) : rawMsgId,
      msg_type: rawType,
      content: data,
      text: typeof data.message === 'string' ? data.message : undefined,
    },
    raw_json: event,
  };
}

async function postZaloEvent(payload: CoreZaloEventPayload): Promise<void> {
  if (!config.core.zaloInboundShadowEnabled) return;
  if (!config.core.baseUrl) {
    if (!warnedCoreDisabled) {
      warnedCoreDisabled = true;
      console.warn('[Zalo→Core] CORE_SYSTEM_BASE_URL is not set, skip inbound shadow forwarding');
    }
    return;
  }

  try {
    await axios.post(`${config.core.baseUrl}/internal/bridge/zalo/events`, payload, {
      headers: {
        'Content-Type': 'application/json',
        ...(config.core.internalToken ? { Authorization: `Bearer ${config.core.internalToken}` } : {}),
      },
      timeout: config.core.timeoutMs,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[Zalo→Core] Shadow forward failed event_id=${payload.event_id}: ${message}`);
  }
}

export function forwardZaloMessageEventToCore(msg: ZaloMessage): void {
  void postZaloEvent(buildMessageEvent(msg));
}

export function forwardZaloRawEventToCore(eventType: 'group_event' | 'friend_event' | 'undo' | 'reaction', event: Record<string, unknown>): void {
  const payload = buildRawEvent(eventType, event);
  if (!payload) return;
  void postZaloEvent(payload);
}
