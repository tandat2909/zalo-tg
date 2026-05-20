# AGENTS.md

This file provides guidance to agents when working with code in this repository.

- Run commands from the project root (`zalo-to-telegram-custom`), not `src/`: `npm run dev`, `npm run build`, `npm start`. There is no lint or test script configured.
- TypeScript is strict ESM; local imports in `src/` include `.js` extensions even when importing `.ts` sources.
- Runtime config is centralized in `src/config.ts`; relative `DATA_DIR` and `ZALO_CREDENTIALS_PATH` resolve from project root, not current shell directory.
- Boot flow: `src/index.ts` starts Telegram first, injects Zalo API into `setupTelegramHandler()`, then starts Zalo listener; reconnect must update both via the returned setter.
- Every Zalo conversation maps to a Telegram forum topic in `store`; topic id `1` is a fallback when bot lacks Manage Topics rights.
- Zalo→TG sends must route Telegram API calls through the `tg` proxy backed by `utils/tgQueue.ts` to survive Telegram 429s.
- Message identity is split: `msgStore` maps Zalo→TG forwarded messages and quote data; `sentMsgStore` marks TG→Zalo sends and suppresses Zalo self-echo race windows.
- Webhooks are fire-and-forget and should be emitted only after the bridge send succeeds (`msgStore.save` for Zalo→TG, Zalo send result for TG→Zalo), otherwise echo/reaction loops reappear.
- Media helpers use `/tmp/zalo-tg`; `downloadToTemp()` deletes local Bot API `file://` sources after copying, so always call `cleanTemp()` for returned temp paths.
- Telegram media limits differ by mode: official API path caps at 20 MB, local Bot API path allows 2 GB; do not remove the official fallback for stale local `file_id`s.
- Zalo albums and Telegram media groups are timer-buffered (`200ms` and `500ms`); callback code may run after the original handler returns.
- Poll bridging depends on `pollStore` secondary TG poll UUID index because Telegraf `poll_answer` lacks message id.