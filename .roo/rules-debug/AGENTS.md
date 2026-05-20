# Project Debug Rules (Non-Obvious Only)

- If no webhook logs appear, first check `INCOMING_MESSAGE_WEBHOOK_URL`; `zalo/webhook.ts` returns early and logs a one-time disabled warning.
- `credentials.json` is project-root relative by default; QR login writes through `config.zalo.credentialsPath`, not necessarily the current shell directory.
- Zalo self-echo is expected after TG→Zalo sends; logs like `[Zalo→TG] Skip bot echo (...)` indicate suppression is working.
- Telegram 429 issues should surface as `[TGQueue] 429` from `utils/tgQueue.ts`; bypassing the Zalo handler `tg` proxy removes this protection.
- Local Bot API diagnostics use `<DATA_DIR>/bot-api/bot-api.log` as computed in `telegram/handler.ts`, not stdout only.
- Topic deletion errors remove stale mappings so the next message can recreate topics; inspect `data/topics.json` if messages route to wrong topics.
- `msg-map.json` may be gzip-compressed even with `.json` extension; inspect via gzip-aware tooling or the loader in `store.ts`.