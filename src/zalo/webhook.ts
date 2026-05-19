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
  sender_type: 'customer' | 'agent';
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
    sender_type: msg.isSelf ? 'agent' : 'customer',
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

export async function sendTelegramToZaloWebhook(input: {
  content: string;
  telegramMessageId: number;
  zaloMessageId?: string | number;
  zaloId: string;
  raw: Record<string, unknown>;
}): Promise<void> {
  const payload: IncomingMessageWebhookPayload = {
    content: input.content,
    external_message_id: String(input.zaloMessageId ?? `tg:${input.telegramMessageId}`),
    external_user_id: input.zaloId,
    platform: 'zalo',
    raw_json: input.raw,
    sender_type: 'agent',
  };

  await postIncomingMessageWebhook(payload, 'Telegram');
}
