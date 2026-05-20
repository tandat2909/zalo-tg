# Project Coding Rules (Non-Obvious Only)

- Keep `.js` suffixes on relative imports inside `src/`; TypeScript compiles ESM with bundler resolution.
- Use `config` from `src/config.ts` for paths/env; it resolves relative data/credential paths from project root.
- In Zalo→TG code, send Telegram messages through the `tg` proxy in `zalo/handler.ts`, not `tgBot.telegram`, so `tgQueue` handles 429 retry/backoff.
- Save message mappings only after successful sends: `msgStore.save()` for Zalo→TG, `sentMsgStore.save()` for TG→Zalo. This powers replies, recalls, reactions, and echo suppression.
- Call `sentMsgStore.markSending(zaloId)` before every TG→Zalo send and `unmarkSending()` in `finally`; otherwise Zalo self-echo may be forwarded back as a new customer message.
- Webhook calls in `zalo/webhook.ts` must remain non-blocking and post-success; do not move them before bridge send completion.
- Always cleanup paths returned by `downloadToTemp()` with `cleanTemp()`; local Bot API `file://` downloads delete the original after copying.
- Media group/album flush callbacks run after timers; capture needed API/topic metadata explicitly rather than relying on mutable outer state.