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
  thread_avatar?: string;
  sender_uid?: string;
  sender_name?: string;
  is_self: boolean;
  /** Tin lịch sử replay — core chỉ lưu DB, không trigger orchestration. */
  replay?: boolean;
  /** Khi replay=true: vẫn đẩy tin vào topic Telegram (vẫn không trigger orchestration). */
  replay_to_telegram?: boolean;
  message: CoreZaloEventMessage;
  raw_json: Record<string, unknown>;
}

export interface ReplayOptions {
  replay?: boolean;
  replayToTelegram?: boolean;
}

/**
 * Thread metadata resolved by the caller (group name from getGroupInfo, or DM
 * peer name from getUserInfo + alias). Lets core create the Telegram topic with
 * the correct name on the very first message of a not-yet-mapped conversation.
 */
export interface ResolvedThreadInfo {
  name?: string;
  avatarUrl?: string;
}

/**
 * Sticker media resolved by the caller via getStickersDetail. Zalo sticker
 * messages carry only a sticker id, not an image URL — the caller resolves the
 * real URL so core can forward it to Telegram as a sticker/photo.
 */
export interface ResolvedStickerMedia {
  url: string;
  /** Telegram media type: 'sticker' for static webp, 'photo' for animated sprite. */
  mediaType: 'sticker' | 'photo';
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

function buildMessagePayload(msg: ZaloMessage, stickerMedia?: ResolvedStickerMedia): CoreZaloEventMessage {
  const quote = msg.data.quote;
  let content = normalizeContent(msg.data.content);
  // Inject the resolved sticker URL + target media type so core can classify
  // the sticker as real media instead of falling back to "[chat.sticker]" text.
  if (stickerMedia) {
    const base = content && typeof content === 'object' ? (content as Record<string, unknown>) : {};
    content = { ...base, url: stickerMedia.url, core_media_type: stickerMedia.mediaType };
  }
  return {
    msg_id: msg.data.msgId,
    real_msg_id: msg.data.realMsgId,
    cli_msg_id: msg.data.cliMsgId,
    global_msg_id: quote?.globalMsgId !== undefined ? String(quote.globalMsgId) : msg.data.realMsgId,
    msg_type: msg.data.msgType,
    content,
    text: textFromContent(msg.data.content),
    timestamp: msg.data.ts,
    ttl: msg.data.ttl,
    quote,
  };
}

function buildMessageEvent(msg: ZaloMessage, threadInfo?: ResolvedThreadInfo, stickerMedia?: ResolvedStickerMedia, replayOpts?: ReplayOptions): CoreZaloEventPayload {
  const threadType = msg.type as 0 | 1;
  const primaryId = msg.data.realMsgId || msg.data.msgId || msg.data.cliMsgId || msg.data.ts;
  // thread_name must be the conversation name (group name or DM peer name) so
  // core names the Telegram topic correctly. msg.data.dName is only the
  // sender's name — wrong for groups and for self-messages — so use it solely
  // as a last-resort fallback when name resolution produced nothing.
  const threadName = threadInfo?.name?.trim() || msg.data.dName;
  return {
    event_id: `zalo:message:${msg.threadId}:${primaryId}`,
    event_type: 'message',
    thread_id: msg.threadId,
    thread_type: threadType,
    sender_uid: msg.data.uidFrom,
    sender_name: msg.data.dName,
    thread_name: threadName,
    thread_avatar: threadInfo?.avatarUrl,
    is_self: msg.isSelf,
    ...(replayOpts?.replay ? { replay: true } : {}),
    ...(replayOpts?.replayToTelegram ? { replay_to_telegram: true } : {}),
    message: buildMessagePayload(msg, stickerMedia),
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

export function forwardZaloMessageEventToCore(
  msg: ZaloMessage,
  threadInfo?: ResolvedThreadInfo,
  stickerMedia?: ResolvedStickerMedia,
  replayOpts?: ReplayOptions,
): Promise<void> {
  return postZaloEvent(buildMessageEvent(msg, threadInfo, stickerMedia, replayOpts));
}

export interface GroupMemberPayload {
  uid: string;
  name: string;
  zalo_name?: string;
  avatar?: string;
}

export async function forwardGroupMembersToCore(
  groupId: string,
  members: GroupMemberPayload[],
): Promise<void> {
  if (!config.core.baseUrl || members.length === 0) return;
  try {
    await axios.post(
      `${config.core.baseUrl}/internal/bridge/zalo/groups/${encodeURIComponent(groupId)}/members`,
      { members },
      {
        headers: {
          'Content-Type': 'application/json',
          ...(config.core.internalToken ? { Authorization: `Bearer ${config.core.internalToken}` } : {}),
        },
        timeout: config.core.timeoutMs,
      },
    );
    console.log(`[Zalo→Core] Synced ${members.length} members for group ${groupId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Zalo→Core] Sync group members failed group_id=${groupId}: ${msg}`);
  }
}

export function forwardZaloRawEventToCore(
  eventType: 'group_event' | 'friend_event' | 'undo' | 'reaction',
  event: Record<string, unknown>,
  senderName?: string,
): void {
  const payload = buildRawEvent(eventType, event);
  if (!payload) return;
  // Special events (reactions, undo) usually arrive without a display name;
  // the caller resolves the actor's real name so core never shows a raw UID.
  if (senderName?.trim()) payload.sender_name = senderName.trim();
  void postZaloEvent(payload);
}
