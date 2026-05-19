import { ThreadType } from 'zca-js';
import { config } from '../config.js';
import { getZaloApi } from '../zalo/client.js';
import { tgBot } from '../telegram/bot.js';
import { msgStore, sentMsgStore } from '../store.js';
import type { ZaloAPI } from '../zalo/types.js';
import { downloadToTemp, cleanTemp } from '../utils/media.js';

interface OutboundTelegramInfo {
  chat_id: number;
  message_thread_id?: number;
  message_id: number;
  from_id?: number;
  from_name?: string;
}

interface OutboundContent {
  type: string;
  text?: string;
  caption?: string;
  telegram_file_id?: string;
  telegram_file_unique_id?: string;
  mime_type?: string;
  file_name?: string;
  file_size?: number;
}

interface OutboundReplyTo {
  telegram_message_id?: number;
  zalo_message_id?: string;
}

export interface OutboundZaloMessageRequest {
  request_id: string;
  conversation_id: number;
  platform: string;
  external_user_id: string;
  telegram: OutboundTelegramInfo;
  content: OutboundContent;
  reply_to?: OutboundReplyTo;
  raw_json?: Record<string, unknown>;
}

export interface OutboundZaloMessageResponse {
  ok: boolean;
  zalo_message_id?: string;
  external_user_id: string;
  thread_type: 'user' | 'group';
  raw_json?: Record<string, unknown>;
}

const processedRequests = new Map<string, OutboundZaloMessageResponse>();
const PROCESSED_MAX = 1000;

function remember(requestId: string, response: OutboundZaloMessageResponse): void {
  if (!requestId) return;
  processedRequests.set(requestId, response);
  while (processedRequests.size > PROCESSED_MAX) {
    const first = processedRequests.keys().next().value as string | undefined;
    if (!first) break;
    processedRequests.delete(first);
  }
}

function resolveThreadType(input: OutboundZaloMessageRequest): ThreadType {
  const rawType = input.raw_json?.thread_type;
  if (rawType === 1 || rawType === 'group') return ThreadType.Group;
  return ThreadType.User;
}

function filenameFor(content: OutboundContent): string {
  if (content.file_name?.trim()) return content.file_name.trim();
  switch (content.type) {
    case 'photo': return 'photo.jpg';
    case 'video': return `video_${Date.now()}.mp4`;
    case 'voice': return `voice_${Date.now()}.ogg`;
    case 'audio': return `audio_${Date.now()}.bin`;
    case 'animation': return `animation_${Date.now()}.gif`;
    case 'sticker': return `sticker_${Date.now()}.webp`;
    default: return `file_${Date.now()}.bin`;
  }
}

async function resolveTelegramFilePath(content: OutboundContent): Promise<string> {
  if (!content.telegram_file_id) throw new Error('Missing telegram_file_id');
  const link = await tgBot.telegram.getFileLink(content.telegram_file_id);
  return downloadToTemp(link.toString(), filenameFor(content));
}

function buildText(input: OutboundZaloMessageRequest): string {
  const text = input.content.text?.trim() || input.content.caption?.trim();
  if (text) return text;
  return `[${input.content.type || 'message'}]`;
}

export async function sendOutboundZaloMessage(input: OutboundZaloMessageRequest): Promise<OutboundZaloMessageResponse> {
  const cached = input.request_id ? processedRequests.get(input.request_id) : undefined;
  if (cached) return cached;

  if (input.platform !== 'zalo') {
    throw new Error(`Unsupported platform: ${input.platform}`);
  }
  if (!input.external_user_id) {
    throw new Error('Missing external_user_id');
  }

  const api: ZaloAPI = await getZaloApi();
  const zaloId = input.external_user_id;
  const threadType = resolveThreadType(input);
  const quote = input.reply_to?.telegram_message_id !== undefined
    ? msgStore.getQuote(input.reply_to.telegram_message_id)
    : undefined;

  let sendResult: any;
  let zaloMessageId: string | undefined;

  sentMsgStore.markSending(zaloId);
  try {
    if (input.content.telegram_file_id) {
      const localPath = await resolveTelegramFilePath(input.content);
      try {
        sendResult = await api.sendMessage(
          {
            msg: input.content.caption ?? '',
            attachments: [localPath],
            ...(input.content.caption && quote ? { quote } : {}),
          },
          zaloId,
          threadType,
        ).catch(async (err: unknown) => {
          if ((err as { code?: number }).code === 114 && quote) {
            return api.sendMessage(
              { msg: input.content.caption ?? '', attachments: [localPath] },
              zaloId,
              threadType,
            );
          }
          throw err;
        });
      } finally {
        await cleanTemp(localPath);
      }
    } else {
      sendResult = await api.sendMessage(
        {
          msg: buildText(input),
          ...(quote ? { quote } : {}),
        },
        zaloId,
        threadType,
      ).catch(async (err: unknown) => {
        if ((err as { code?: number }).code === 114 && quote) {
          return api.sendMessage({ msg: buildText(input) }, zaloId, threadType);
        }
        throw err;
      });
    }

    const rawID = sendResult?.message?.msgId ?? sendResult?.attachment?.[0]?.msgId ?? sendResult?.msgId;
    if (rawID !== undefined && rawID !== null) {
      zaloMessageId = String(rawID);
      sentMsgStore.save(input.telegram.message_id, { msgId: rawID, zaloId, threadType: threadType === ThreadType.Group ? 1 : 0 });
    }
  } finally {
    sentMsgStore.unmarkSending(zaloId);
  }

  const response: OutboundZaloMessageResponse = {
    ok: true,
    zalo_message_id: zaloMessageId,
    external_user_id: zaloId,
    thread_type: threadType === ThreadType.Group ? 'group' : 'user',
    raw_json: sendResult as Record<string, unknown>,
  };
  remember(input.request_id, response);
  return response;
}
