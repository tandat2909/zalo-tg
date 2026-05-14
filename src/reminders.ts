import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import type { Telegraf } from 'telegraf';
import { ThreadType } from 'zca-js';

import { config } from './config.js';
import { tgBot } from './telegram/bot.js';
import { tgQueue } from './utils/tgQueue.js';
import { sentMsgStore, msgStore, userCache } from './store.js';
import { escapeHtml } from './utils/format.js';
import type { ZaloAPI } from './zalo/types.js';

// ── Persisted config ─────────────────────────────────────────────────────────
//
// File: <dataDir>/reminders.json
// {
//   "defaultMinutes": null | number,        // global fallback (null = tắt)
//   "topics": {
//     "<topicId>": {
//       "minutes":   null | number,         // null = dùng default, 0 = tắt riêng
//       "autoReply": null | string,         // tin nhắn tự động gửi sang Zalo
//       "accounts":  string[]               // whitelist Zalo uid; rỗng = nhắc tất cả
//     }
//   }
// }

interface TopicReminderConfig {
  minutes?:   number | null;
  autoReply?: string | null;
  accounts?:  string[];
}

interface ReminderState {
  defaultMinutes: number | null;
  topics: Record<string, TopicReminderConfig>;
}

const _file = path.resolve(config.dataDir, 'reminders.json');

function _load(): ReminderState {
  if (!existsSync(_file)) return { defaultMinutes: null, topics: {} };
  try {
    const raw = JSON.parse(readFileSync(_file, 'utf8')) as Partial<ReminderState>;
    return {
      defaultMinutes: raw.defaultMinutes ?? null,
      topics: raw.topics ?? {},
    };
  } catch {
    return { defaultMinutes: null, topics: {} };
  }
}

function _persist(s: ReminderState): void {
  mkdirSync(path.dirname(_file), { recursive: true });
  writeFileSync(_file, JSON.stringify(s, null, 2), 'utf8');
}

let _state: ReminderState = _load();

export const reminderConfig = {
  /** Resolve the effective reminder window for a topic (null = disabled). */
  effectiveMinutes(topicId: number): number | null {
    const t = _state.topics[String(topicId)];
    // explicit 0 → disabled regardless of default
    if (t?.minutes === 0) return null;
    const mins = t?.minutes ?? _state.defaultMinutes;
    return mins && mins > 0 ? mins : null;
  },

  setTopicMinutes(topicId: number, mins: number | null): void {
    const key = String(topicId);
    _state.topics[key] = { ...(_state.topics[key] ?? {}), minutes: mins };
    _persist(_state);
  },

  setDefaultMinutes(mins: number | null): void {
    _state.defaultMinutes = mins;
    _persist(_state);
  },

  getDefaultMinutes(): number | null { return _state.defaultMinutes; },

  getTopicConfig(topicId: number): TopicReminderConfig | undefined {
    return _state.topics[String(topicId)];
  },

  setAutoReply(topicId: number, text: string | null): void {
    const key = String(topicId);
    _state.topics[key] = { ...(_state.topics[key] ?? {}), autoReply: text };
    _persist(_state);
  },

  getAutoReply(topicId: number): string | null {
    return _state.topics[String(topicId)]?.autoReply ?? null;
  },

  /** Returns the (deduped) whitelist of Zalo uids for which this topic should remind. */
  getAccounts(topicId: number): string[] {
    return _state.topics[String(topicId)]?.accounts ?? [];
  },

  /** Add a Zalo uid to the whitelist. Returns true if it was newly added. */
  addAccount(topicId: number, uid: string): boolean {
    const key = String(topicId);
    const t = _state.topics[key] ?? {};
    const cur = t.accounts ?? [];
    if (cur.includes(uid)) return false;
    _state.topics[key] = { ...t, accounts: [...cur, uid] };
    _persist(_state);
    return true;
  },

  /** Remove a uid from the whitelist. Returns true if it was actually present. */
  removeAccount(topicId: number, uid: string): boolean {
    const key = String(topicId);
    const t = _state.topics[key];
    const cur = t?.accounts ?? [];
    if (!cur.includes(uid)) return false;
    _state.topics[key] = { ...(t ?? {}), accounts: cur.filter(u => u !== uid) };
    _persist(_state);
    return true;
  },

  /** Reset the whitelist to empty (= remind for any sender). */
  clearAccounts(topicId: number): void {
    const key = String(topicId);
    const t = _state.topics[key];
    if (!t) return;
    _state.topics[key] = { ...t, accounts: [] };
    _persist(_state);
  },

  /** True if the topic has no whitelist (allow all) OR `uid` is in the whitelist. */
  shouldRemindForUid(topicId: number, uid: string | undefined): boolean {
    const list = _state.topics[String(topicId)]?.accounts;
    if (!list || list.length === 0) return true;
    return !!uid && list.includes(uid);
  },
};

// ── Tracker ──────────────────────────────────────────────────────────────────

const tg = new Proxy(tgBot.telegram, {
  get(target, prop: string) {
    const orig = (target as unknown as Record<string, unknown>)[prop];
    if (typeof orig !== 'function') return orig;
    return (...args: unknown[]) =>
      tgQueue(() => (orig as (...a: unknown[]) => Promise<unknown>).apply(target, args));
  },
}) as typeof tgBot.telegram;

interface PendingReminder {
  timer:      ReturnType<typeof setTimeout>;
  topicId:    number;
  zaloId:     string;
  threadType: 0 | 1;
  senderName: string;
  minutes:    number;
  scheduledAt: number;
}

const _pending = new Map<string, PendingReminder>();

function _key(zaloId: string, type: 0 | 1): string { return `${type}:${zaloId}`; }

let _api: ZaloAPI | null = null;

export const reminderTracker = {
  /** Inject the current Zalo API so the auto-reply can be sent. */
  setApi(api: ZaloAPI | null): void { _api = api; },

  /**
   * Schedule a reminder for an incoming customer message.
   * Called once per Zalo message after it has been forwarded to TG.
   * Any previous pending reminder for the same conversation is replaced.
   * If the topic has an account whitelist, only senders on it trigger a timer.
   */
  trackIncoming(
    zaloId: string,
    type: 0 | 1,
    topicId: number,
    senderName: string,
    senderUid: string | undefined,
  ): void {
    const minutes = reminderConfig.effectiveMinutes(topicId);
    if (!minutes || minutes <= 0) return;
    if (!reminderConfig.shouldRemindForUid(topicId, senderUid)) return;

    const k = _key(zaloId, type);
    const existing = _pending.get(k);
    if (existing) clearTimeout(existing.timer);

    const timer = setTimeout(() => { void _fire(k); }, minutes * 60_000);
    _pending.set(k, {
      timer, topicId, zaloId, threadType: type, senderName, minutes,
      scheduledAt: Date.now(),
    });
  },

  /** The owner (via TG→Zalo or directly on Zalo app) has replied. */
  markAnswered(zaloId: string, type: 0 | 1): void {
    const k = _key(zaloId, type);
    const p = _pending.get(k);
    if (!p) return;
    clearTimeout(p.timer);
    _pending.delete(k);
  },
};

async function _fire(k: string): Promise<void> {
  const p = _pending.get(k);
  if (!p) return;
  _pending.delete(k);

  try {
    await tg.sendMessage(
      config.telegram.groupId,
      `⏰ <b>Khách hàng chưa được trả lời</b>\n` +
      `<b>${escapeHtml(p.senderName)}</b> đã chờ ${p.minutes} phút mà chưa có phản hồi.`,
      { message_thread_id: p.topicId, parse_mode: 'HTML' },
    );
  } catch (e) {
    console.warn('[Reminder] TG notify failed:', e);
  }

  const autoReply = reminderConfig.getAutoReply(p.topicId);
  if (autoReply && _api) {
    const api = _api;
    const threadType = p.threadType === 1 ? ThreadType.Group : ThreadType.User;
    sentMsgStore.markSending(p.zaloId);
    try {
      const result = await api.sendMessage({ msg: autoReply }, p.zaloId, threadType);
      const zaloMsgId = (result as { message?: { msgId?: string | number } })?.message?.msgId;
      if (zaloMsgId !== undefined) {
        // Use a synthetic tgMsgId derived from time so we don't collide with real TG ids.
        // (We don't strictly need to map back, but recording prevents the listener
        // from treating the bot's own echo as a fresh customer message.)
        sentMsgStore.save(-Date.now(), { msgId: zaloMsgId, zaloId: p.zaloId, threadType });
      }
      console.log(`[Reminder] Auto-reply sent → zaloId=${p.zaloId} (${p.minutes} phút)`);
    } catch (e) {
      console.warn('[Reminder] Auto-reply failed:', e);
      try {
        await tg.sendMessage(
          config.telegram.groupId,
          `⚠️ Gửi auto-reply thất bại: <code>${escapeHtml((e as Error)?.message ?? String(e))}</code>`,
          { message_thread_id: p.topicId, parse_mode: 'HTML' },
        );
      } catch { /* ignore */ }
    } finally {
      sentMsgStore.unmarkSending(p.zaloId);
    }
  }
}

// ── Telegram commands ────────────────────────────────────────────────────────

function _replyOpts(topicId?: number) {
  return topicId
    ? { message_thread_id: topicId, parse_mode: 'HTML' as const }
    : { parse_mode: 'HTML' as const };
}

const REMIND_HELP =
`📖 <b>Lệnh nhắc nhở</b>
<code>/remind on &lt;phút&gt;</code>      — bật cho topic này
<code>/remind off</code>                — tắt cho topic này
<code>/remind clear</code>              — bỏ override, dùng mặc định
<code>/remind default &lt;phút&gt;</code> — đặt mặc định cho mọi topic (0=tắt)
<code>/remind who …</code>              — chọn account Zalo cần nhắc (xem <code>/remind who</code>)
<code>/remind status</code>             — xem cấu hình hiện tại`;

const REMIND_WHO_HELP =
`📖 <b>Lọc account Zalo cần nhắc</b>
<code>/remind who add</code> (reply tin của khách) — chỉ nhắc khi tin đến từ account này
<code>/remind who add &lt;uid&gt;</code>
<code>/remind who remove</code> (reply hoặc <code>&lt;uid&gt;</code>)
<code>/remind who list</code>
<code>/remind who clear</code> — bỏ lọc, nhắc cho mọi tin nhắn`;

const AUTOREPLY_HELP =
`📖 <b>Lệnh auto-reply</b>
<code>/autoreply set &lt;nội dung&gt;</code> — đặt câu trả lời tự động cho topic
<code>/autoreply show</code>               — xem nội dung hiện tại
<code>/autoreply off</code>                — tắt auto-reply cho topic này`;

export function registerReminderCommands(bot: Telegraf): void {
  bot.command('remind', async (ctx) => {
    if (ctx.chat.id !== config.telegram.groupId) return;
    const topicId = 'message_thread_id' in ctx.message
      ? (ctx.message.message_thread_id as number | undefined)
      : undefined;
    const args = (ctx.message.text ?? '').trim().split(/\s+/).slice(1);
    const sub  = args[0]?.toLowerCase() ?? '';
    const opts = _replyOpts(topicId);

    if (sub === 'default') {
      const mins = parseInt(args[1] ?? '', 10);
      if (!Number.isFinite(mins) || mins < 0) {
        await ctx.telegram.sendMessage(ctx.chat.id,
          '❓ Dùng: <code>/remind default &lt;phút&gt;</code> (0 = tắt)', opts);
        return;
      }
      reminderConfig.setDefaultMinutes(mins === 0 ? null : mins);
      await ctx.telegram.sendMessage(ctx.chat.id,
        mins === 0
          ? '✅ Đã tắt nhắc nhở mặc định.'
          : `✅ Mặc định: nhắc sau <b>${mins} phút</b> nếu chưa trả lời khách.`,
        opts);
      return;
    }

    if (sub === 'status') {
      const def   = reminderConfig.getDefaultMinutes();
      const lines = [`Mặc định: <b>${def ? def + ' phút' : 'tắt'}</b>`];
      if (topicId) {
        const eff = reminderConfig.effectiveMinutes(topicId);
        const cfg = reminderConfig.getTopicConfig(topicId);
        const hasOverride = cfg?.minutes !== undefined && cfg.minutes !== null;
        lines.push(`Topic này: <b>${eff ? eff + ' phút' : 'tắt'}</b>${hasOverride ? ' <i>(override)</i>' : ''}`);
        const ar = reminderConfig.getAutoReply(topicId);
        lines.push(`Auto-reply: ${ar ? `<i>${escapeHtml(ar)}</i>` : '<b>tắt</b>'}`);
        const accs = reminderConfig.getAccounts(topicId);
        if (accs.length === 0) {
          lines.push(`Lọc account: <b>tất cả tin nhắn</b>`);
        } else {
          const names = accs.map(uid => userCache.getName(uid) || uid).map(escapeHtml).join(', ');
          lines.push(`Lọc account (${accs.length}): ${names}`);
        }
      }
      await ctx.telegram.sendMessage(ctx.chat.id, lines.join('\n'), opts);
      return;
    }

    if (!topicId) {
      await ctx.telegram.sendMessage(ctx.chat.id,
        '⚠️ Lệnh này phải gửi trong một topic. Dùng <code>/remind default &lt;phút&gt;</code> để đặt mặc định chung.',
        opts);
      return;
    }

    if (sub === 'who') {
      const action = (args[1] ?? 'list').toLowerCase();

      if (action === 'list') {
        const list = reminderConfig.getAccounts(topicId);
        if (list.length === 0) {
          await ctx.telegram.sendMessage(ctx.chat.id,
            'Topic này đang nhắc cho <b>mọi tin nhắn</b> (chưa lọc account).\n' +
            'Reply vào tin của khách rồi gõ <code>/remind who add</code> để chỉ nhắc cho account đó.',
            opts);
          return;
        }
        const lines = list.map(uid => {
          const name = userCache.getName(uid);
          return name
            ? `• <b>${escapeHtml(name)}</b> — <code>${uid}</code>`
            : `• <code>${uid}</code>`;
        });
        await ctx.telegram.sendMessage(ctx.chat.id,
          `Đang nhắc cho <b>${list.length}</b> account:\n${lines.join('\n')}`, opts);
        return;
      }

      if (action === 'clear') {
        reminderConfig.clearAccounts(topicId);
        await ctx.telegram.sendMessage(ctx.chat.id,
          '✅ Đã xoá danh sách lọc — topic sẽ nhắc cho mọi tin nhắn.', opts);
        return;
      }

      if (action === 'add' || action === 'remove' || action === 'rm' || action === 'del') {
        // Resolve uid: explicit arg OR sender of the replied-to message
        let uid = args[2]?.trim();
        if (!uid) {
          const reply = 'reply_to_message' in ctx.message
            ? (ctx.message as { reply_to_message?: { message_id: number } }).reply_to_message
            : undefined;
          if (reply) {
            const quote = msgStore.getQuote(reply.message_id);
            if (quote?.uidFrom) uid = quote.uidFrom;
          }
        }
        if (!uid) {
          await ctx.telegram.sendMessage(ctx.chat.id,
            `❓ Reply vào một tin của khách rồi gõ <code>/remind who ${action}</code>, hoặc dùng <code>/remind who ${action} &lt;uid&gt;</code>.`,
            opts);
          return;
        }

        const name = userCache.getName(uid);
        const label = name ? `<b>${escapeHtml(name)}</b> (<code>${uid}</code>)` : `<code>${uid}</code>`;

        if (action === 'add') {
          const added = reminderConfig.addAccount(topicId, uid);
          await ctx.telegram.sendMessage(ctx.chat.id,
            added
              ? `✅ Đã thêm ${label} vào danh sách remind của topic này.`
              : `ℹ️ ${label} đã có sẵn trong danh sách.`,
            opts);
        } else {
          const removed = reminderConfig.removeAccount(topicId, uid);
          await ctx.telegram.sendMessage(ctx.chat.id,
            removed
              ? `✅ Đã bỏ ${label} khỏi danh sách remind.`
              : `ℹ️ ${label} không có trong danh sách.`,
            opts);
        }
        return;
      }

      await ctx.telegram.sendMessage(ctx.chat.id, REMIND_WHO_HELP, opts);
      return;
    }

    if (sub === 'off') {
      reminderConfig.setTopicMinutes(topicId, 0);
      await ctx.telegram.sendMessage(ctx.chat.id, '✅ Đã tắt nhắc nhở cho topic này.', opts);
      return;
    }

    if (sub === 'clear') {
      reminderConfig.setTopicMinutes(topicId, null);
      await ctx.telegram.sendMessage(ctx.chat.id,
        '✅ Đã xoá override; topic dùng giá trị mặc định.', opts);
      return;
    }

    // /remind on <phút>  or  /remind <phút>
    const minsArg = sub === 'on' ? args[1] : sub;
    const mins    = parseInt(minsArg ?? '', 10);
    if (Number.isFinite(mins) && mins > 0) {
      reminderConfig.setTopicMinutes(topicId, mins);
      await ctx.telegram.sendMessage(ctx.chat.id,
        `✅ Sẽ nhắc nếu khách chưa được trả lời sau <b>${mins} phút</b> trong topic này.`, opts);
      return;
    }

    await ctx.telegram.sendMessage(ctx.chat.id, REMIND_HELP, opts);
  });

  bot.command('autoreply', async (ctx) => {
    if (ctx.chat.id !== config.telegram.groupId) return;
    const topicId = 'message_thread_id' in ctx.message
      ? (ctx.message.message_thread_id as number | undefined)
      : undefined;
    const opts = _replyOpts(topicId);

    if (!topicId) {
      await ctx.telegram.sendMessage(ctx.chat.id,
        '⚠️ Lệnh này phải gửi trong một topic (mỗi topic = một nhóm Zalo).', opts);
      return;
    }

    const raw    = ctx.message.text ?? '';
    const space  = raw.indexOf(' ');
    const rest   = space === -1 ? '' : raw.slice(space + 1).trim();
    const sub    = rest.split(/\s+/)[0]?.toLowerCase() ?? '';

    if (sub === 'off' || sub === 'clear') {
      reminderConfig.setAutoReply(topicId, null);
      await ctx.telegram.sendMessage(ctx.chat.id, '✅ Đã tắt auto-reply cho topic này.', opts);
      return;
    }

    if (sub === '' || sub === 'show') {
      const ar = reminderConfig.getAutoReply(topicId);
      await ctx.telegram.sendMessage(ctx.chat.id,
        ar
          ? `Auto-reply hiện tại:\n<i>${escapeHtml(ar)}</i>`
          : `Topic này chưa cấu hình auto-reply.\nDùng <code>/autoreply set &lt;nội dung&gt;</code>`,
        opts);
      return;
    }

    if (sub === 'set') {
      // strip the leading "set" word from rest (preserve internal whitespace)
      const text = rest.slice(3).trim();
      if (!text) {
        await ctx.telegram.sendMessage(ctx.chat.id,
          '❓ Dùng: <code>/autoreply set &lt;nội dung&gt;</code>', opts);
        return;
      }
      reminderConfig.setAutoReply(topicId, text);
      await ctx.telegram.sendMessage(ctx.chat.id,
        `✅ Đã đặt auto-reply cho topic này:\n<i>${escapeHtml(text)}</i>`, opts);
      return;
    }

    await ctx.telegram.sendMessage(ctx.chat.id, AUTOREPLY_HELP, opts);
  });
}
