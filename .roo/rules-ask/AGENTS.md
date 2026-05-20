# Project Documentation Rules (Non-Obvious Only)

- `src/store.ts` is not a single store: it contains topic persistence, quote/message maps, user/alias caches, poll indexes, reaction echo tracking, and media album buffers.
- Telegram forum topics are the conversation model; a topic maps to either a Zalo DM UID or groupId with `type` 0/1.
- The Telegram handler owns TG→Zalo user messages, commands, poll answers, reactions, and QR-login UI; the Zalo handler owns Zalo listener events and Zalo→TG formatting.
- `LOCAL_BOT_API_SETUP*.md` matters for large Telegram files; code switches file limits and `file://` behavior when `LOCAL_BOT_API=1`.
- README command descriptions do not fully describe bridge internals; code comments around `sentMsgStore`, `msgStore`, and media buffers are the canonical reference.