# Project Architecture Rules (Non-Obvious Only)

- Startup intentionally launches Telegram before Zalo so `/login` works when credentials are missing; reconnect must call the Telegram handler API setter before restarting Zalo listeners.
- Zalo `selfListen: true` is required to detect direct owner replies and TG→Zalo echoes; echo suppression depends on both reverse message ids and a short pending-send window.
- Topic creation is guarded by `_pendingTopics` to prevent duplicate forum topics during concurrent album bursts.
- `msgStore` persists compact/gzipped quote data for reply chains; `sentMsgStore` is in-memory and only protects current-process TG→Zalo echoes/replies.
- Polls use dual representation: native Zalo poll plus bot-owned Telegram clone and editable score message; TG poll UUID is the stable lookup key for `poll_answer`.
- Reminder auto-reply sends synthetic negative Telegram ids into `sentMsgStore` purely to suppress the resulting Zalo echo.
- Webhook integration treats Zalo-origin customer messages as `customer` and Telegram-origin replies as `agent`; both use platform `zalo` because the external system models the Zalo conversation.