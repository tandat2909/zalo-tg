import axios from 'axios';

import { config } from '../config.js';
import type { ZaloMessage, ZaloMediaContent } from './types.js';
import { ZALO_MSG_TYPES } from './types.js';

export interface IncomingMessageWebhookPayload {
  content: string;
  external_message_id: string;
  external_user_id: string;
  platform: 'zalo';
  raw_json: Record<string, unknown>;
  external_group_id?: string;
  external_group_name?: string;
  thread_id?: string;
  thread_type?: 0 | 1;
}

function parseWebhookContent(raw: string | ZaloMediaContent | Record<string, unknown>, msgType: string): string {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as ZaloMediaContent;
      return parsed.title?.trim()
        || parsed.description?.trim()
        || parsed.href?.trim()
        || `[${msgType}]`;
    } catch {
      return raw;
    }
  }

  const media = raw as ZaloMediaContent;
  return media.title?.trim()
    || media.description?.trim()
    || media.href?.trim()
    || `[${msgType}]`;
}

function buildWebhookPayload(msg: ZaloMessage): IncomingMessageWebhookPayload {
  const msgType = msg.data.msgType ?? ZALO_MSG_TYPES.TEXT;
  const messageId = msg.data.msgId || msg.data.realMsgId || msg.data.cliMsgId || `${msg.threadId}:${msg.data.ts}`;

  return {
    content: parseWebhookContent(msg.data.content, msgType),
    external_message_id: String(messageId),
    external_user_id: String(msg.data.uidFrom || msg.threadId),
    platform: 'zalo',
    raw_json: msg as unknown as Record<string, unknown>,
  };
}

let _warnedWebhookDisabled = false;

async function postIncomingMessageWebhook(payload: IncomingMessageWebhookPayload, source: 'Zalo' | 'Telegram'): Promise<void> {
  if (!config.webhook.incomingMessageUrl) {
    if (!_warnedWebhookDisabled) {
      _warnedWebhookDisabled = true;
      console.warn('[Webhook] INCOMING_MESSAGE_WEBHOOK_URL is not set, skip sending webhook');
    }
    return;
  }

  console.log(`[${source}→Webhook] Sending incoming message webhook:`, {
    url: config.webhook.incomingMessageUrl,
    payload,
  });

  try {
    await axios.post(config.webhook.incomingMessageUrl, payload, {
      headers: {
        accept: 'application/json',
        'Content-Type': 'application/json',
      },
      timeout: config.webhook.timeoutMs,
    });
    console.log(`[${source}→Webhook] Sent incoming message ${payload.external_message_id} successfully`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[${source}→Webhook] Failed to send incoming message ${payload.external_message_id}: ${message}`);
  }
}

export async function sendIncomingMessageWebhook(msg: ZaloMessage): Promise<void> {
  const payload = buildWebhookPayload(msg);
  await postIncomingMessageWebhook(payload, 'Zalo');
}

export async function sendZaloToTelegramWebhook(input: {
  msg: ZaloMessage;
  content: string;
  telegramMessageId: number;
  telegramGroupId: number;
  telegramTopicId: number;
  telegramTopicName: string;
  telegramTopicUrl?: string;
  bridgeTopicEntry?: Record<string, unknown>;
  externalGroupId?: string;
  externalGroupName?: string;
  threadId: string;
  threadType: 0 | 1;
  raw?: Record<string, unknown>;
}): Promise<void> {
  const basePayload = buildWebhookPayload(input.msg);
  const mapping = {
    zalo_message_id: basePayload.external_message_id,
    zalo_user_id: String(input.msg.data.uidFrom || ''),
    zalo_sender_name: String(input.msg.data.dName || ''),
    zalo_id: input.threadId,
    zalo_thread_id: input.threadId,
    zalo_thread_type: input.threadType,
    zalo_thread_type_name: input.threadType === 1 ? 'group' : 'user',
    zalo_group_id: input.threadType === 1 ? input.threadId : undefined,
    zalo_group_name: input.threadType === 1 ? input.externalGroupName : undefined,
    zalo_display_name: input.externalGroupName,
    telegram_message_id: input.telegramMessageId,
    telegram_chat_id: input.telegramGroupId,
    telegram_group_id: input.telegramGroupId,
    telegram_topic_id: input.telegramTopicId,
    telegram_topic_name: input.telegramTopicName,
    telegram_topic_url: input.telegramTopicUrl,
    bridge_topic_entry: input.bridgeTopicEntry,
  };

  const payload: IncomingMessageWebhookPayload = {
    ...basePayload,
    content: input.content,
    raw_json: {
      zalo_message: input.msg as unknown as Record<string, unknown>,
      telegram_message_id: input.telegramMessageId,
      telegram_chat_id: input.telegramGroupId,
      telegram_topic_id: input.telegramTopicId,
      telegram_topic_name: input.telegramTopicName,
      telegram_topic_url: input.telegramTopicUrl,
      mapping,
      ...(input.raw ?? {}),
    },
    external_group_id: input.externalGroupId,
    external_group_name: input.externalGroupName,
    thread_id: input.threadId,
    thread_type: input.threadType,
  };

  await postIncomingMessageWebhook(payload, 'Zalo');
}

export async function sendTelegramToZaloWebhook(input: {
  content: string;
  telegramMessageId: number;
  zaloMessageId?: string | number;
  zaloId: string;
  raw: Record<string, unknown>;
  externalGroupId?: string;
  externalGroupName?: string;
  threadId?: string;
  threadType?: 0 | 1;
}): Promise<void> {
  const payload: IncomingMessageWebhookPayload = {
    content: input.content,
    external_message_id: String(input.zaloMessageId ?? `tg:${input.telegramMessageId}`),
    external_user_id: input.zaloId,
    platform: 'zalo',
    raw_json: input.raw,
  };

  if (input.externalGroupId) payload.external_group_id = input.externalGroupId;
  if (input.externalGroupName) payload.external_group_name = input.externalGroupName;
  if (input.threadId) payload.thread_id = input.threadId;
  if (input.threadType !== undefined) payload.thread_type = input.threadType;

  await postIncomingMessageWebhook(payload, 'Telegram');
}
