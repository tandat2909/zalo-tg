import { getZaloApi, resetZaloApi, triggerQRLogin } from './zalo/client.js';
import { CloseReason } from 'zca-js';
import { setupZaloHandler } from './zalo/handler.js';
import { tgBot, syncTelegramCommands } from './telegram/bot.js';
import { config } from './config.js';
import { startOutboundServer } from './outbound-server.js';

// ── Global safety net — prevent unhandled rejections from crashing ────────────
process.on('unhandledRejection', (reason) => {
  console.error('[Boot] Unhandled rejection (ignored):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Boot] Uncaught exception (ignored):', err);
});

// ── Module-level ref to Telegram handler's API setter (used by reconnect) ──────
let _setZaloApi: ((api: Awaited<ReturnType<typeof getZaloApi>>) => void) | null = null;

// ── Boot Zalo (also used when /login swaps in a fresh API) ───────────────────

async function pruneLeftGroupTopics(api: Awaited<ReturnType<typeof getZaloApi>>): Promise<void> {
  // Dev-only legacy cleanup. In normal core-owned mode the adapter must not load
  // topic mappings from local JSON files.
  if (!config.core.legacyStoreFallbackEnabled) return;
  try {
    const { store } = await import('./store.js');
    const groups = await api.getAllGroups() as { gridVerMap?: Record<string, string> } | undefined;
    const activeGroupIds = new Set(Object.keys(groups?.gridVerMap ?? {}));
    const removed: string[] = [];
    for (const entry of store.all()) {
      if (entry.type === 1 && !activeGroupIds.has(entry.zaloId)) {
        store.remove(entry.topicId);
        removed.push(`${entry.name} (${entry.zaloId})`);
      }
    }
    if (removed.length > 0) {
      console.log(`[Boot] Pruned ${removed.length} stale group topic(s): ${removed.join(', ')}`);
    }
  } catch (err) {
    console.warn('[Boot] Could not prune stale group topics:', err);
  }
}

async function startZalo(
  api: Awaited<ReturnType<typeof getZaloApi>>,
  isReconnect = false,
): Promise<void> {
  if (!isReconnect) void pruneLeftGroupTopics(api);
  await setupZaloHandler(api);
  api.listener.start();
  console.log(`[Boot] Zalo listener ${isReconnect ? 're' : ''}started ✓`);

  // Auto-reconnect on unexpected disconnects (skip on intentional stop)
  api.listener.once('disconnected', (code: CloseReason, _reason: string) => {
    if ((code as number) === 1000 /* ManualClosure */) return;
    console.warn(`[Boot] Zalo disconnected (code=${code}), reconnecting in 5 s…`);
    tgBot.telegram.sendMessage(
      config.telegram.groupId,
      '⚠️ Zalo bị ngắt kết nối, đang thử kết nối lại…',
    ).catch(() => undefined);
    setTimeout(() => {
      void (async () => {
        try {
          resetZaloApi();
          const newApi = await getZaloApi();
          _setZaloApi?.(newApi);
          await startZalo(newApi, true);
          tgBot.telegram.sendMessage(config.telegram.groupId, '✅ Zalo đã kết nối lại.').catch(() => undefined);
          console.log('[Boot] Zalo reconnected ✓');
        } catch (err) {
          console.error('[Boot] Zalo reconnect failed:', err);
          tgBot.telegram.sendMessage(
            config.telegram.groupId,
            '⚠️ Kết nối lại Zalo thất bại. Hãy dùng <b>/login</b> để đăng nhập lại.',
            { parse_mode: 'HTML' },
          ).catch(() => undefined);
        }
      })();
    }, 5_000);
  });
}

// ── /login flow ───────────────────────────────────────────────────────────────
// Triggered by core via POST /internal/zalo/login. Runs a fresh QR login and
// sends the QR image straight into the Telegram group via the bot token.
let _loginInProgress = false;

async function handleLoginRequest(): Promise<void> {
  if (_loginInProgress) {
    tgBot.telegram
      .sendMessage(config.telegram.groupId, 'ℹ️ Đang có phiên đăng nhập Zalo chạy rồi — hãy quét mã QR đã gửi.')
      .catch(() => undefined);
    return;
  }
  _loginInProgress = true;
  try {
    await tgBot.telegram
      .sendMessage(config.telegram.groupId, '⏳ Đang tạo mã QR đăng nhập Zalo…')
      .catch(() => undefined);

    const api = await triggerQRLogin({
      onQRReady: async (imagePath: string) => {
        await tgBot.telegram
          .sendPhoto(config.telegram.groupId, { source: imagePath }, {
            caption: '📲 Mở app Zalo trên điện thoại và quét mã QR này để đăng nhập bridge.',
          })
          .catch((err: unknown) => console.error('[Boot] /login send QR failed:', err));
      },
      onExpired: async () => {
        tgBot.telegram
          .sendMessage(config.telegram.groupId, '♻️ Mã QR đã hết hạn, đang tạo mã mới…')
          .catch(() => undefined);
      },
      onScanned: async (name: string) => {
        tgBot.telegram
          .sendMessage(config.telegram.groupId, `✓ Đã quét bởi <b>${name}</b>, đang chờ xác nhận trên điện thoại…`, { parse_mode: 'HTML' })
          .catch(() => undefined);
      },
      onDeclined: async () => {
        tgBot.telegram
          .sendMessage(config.telegram.groupId, '❌ Đăng nhập Zalo bị từ chối trên điện thoại.')
          .catch(() => undefined);
      },
    });

    _setZaloApi?.(api);
    await startZalo(api, true);
    tgBot.telegram
      .sendMessage(config.telegram.groupId, '✅ Đăng nhập Zalo thành công — bridge đã hoạt động.')
      .catch(() => undefined);
    console.log('[Boot] Zalo login via /login completed ✓');
  } catch (err) {
    console.error('[Boot] /login flow failed:', err);
    tgBot.telegram
      .sendMessage(
        config.telegram.groupId,
        '⚠️ Đăng nhập Zalo thất bại: ' + (err instanceof Error ? err.message : String(err)),
      )
      .catch(() => undefined);
  } finally {
    _loginInProgress = false;
  }
}

async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════╗');
  console.log('║   Zalo ↔ Telegram Bridge  v1.0.0    ║');
  console.log('╚══════════════════════════════════════╝');

  // ── Routing info ───────────────────────────────────────────────────────────
  const forwardUrl = config.core.baseUrl
    ? `${config.core.baseUrl}/internal/bridge/zalo/events`
    : '(disabled — CORE_SYSTEM_BASE_URL not set)';
  console.log('[Boot] ── Routing ────────────────────────────────');
  console.log(`[Boot]  Zalo → Core   : POST ${forwardUrl}`);
  console.log(`[Boot]  Core → Zalo   : outbound server http://${config.outbound.host}:${config.outbound.port}/internal/outbound/zalo/messages`);
  console.log(`[Boot]  Core timeout  : ${config.core.timeoutMs}ms`);
  console.log(`[Boot]  Internal token: ${config.core.internalToken ? 'set' : 'none'}`);
  console.log(`[Boot]  Legacy stores : ${config.core.legacyStoreFallbackEnabled ? 'enabled (debug)' : 'disabled (core-owned)'}`);
  console.log('[Boot] ───────────────────────────────────────────');

  const outboundServer = startOutboundServer(() => {
    void handleLoginRequest();
  });

  let setZaloApi: (api: Awaited<ReturnType<typeof getZaloApi>>) => void = () => undefined;
  if (config.telegram.pollingEnabled && !config.core.legacyStoreFallbackEnabled) {
    throw new Error(
      'TELEGRAM_POLLING_ENABLED requires BRIDGE_LEGACY_STORE_FALLBACK_ENABLED=1 because the legacy Telegram handler depends on adapter-local mapping stores. Keep Telegram polling disabled in production core-owned mode.',
    );
  }

  if (config.telegram.pollingEnabled) {
    // ── Auto update checker — must register BEFORE setupTelegramHandler ───────
    // bot.action() is middleware; the catch-all on('callback_query') in handler.ts
    // doesn't call next(), so ua: callbacks must be registered first in the chain.
    const { startUpdateChecker } = await import('./updater.js');
    startUpdateChecker(tgBot);

    // ── Wire up Telegram handler BEFORE launching the bot ───────────────────
    // setupTelegramHandler returns a setter to inject the Zalo API after auto-login.
    const { setupTelegramHandler } = await import('./telegram/handler.js');
    setZaloApi = setupTelegramHandler(null, async (newApi) => {
      await startZalo(newApi, true);
    });
    _setZaloApi = setZaloApi;
  }

  // ── Register bot commands for Telegram menu ───────────────────────────────
  // Nguồn duy nhất: BOT_COMMANDS trong telegram/bot.ts (dùng cho cả webhook
  // lẫn polling). Tránh hardcode trùng lặp khiến menu lệch khi thêm command.
  syncTelegramCommands().catch(() => undefined);

  const startZaloInBackground = () => {
    getZaloApi()
      .then(async (api) => {
        setZaloApi(api);   // ← inject into Telegram handler so TG→Zalo works
        await startZalo(api);
      })
      .catch((err: unknown) => {
        console.warn('[Boot] Zalo auto-login failed:', err);
        if (config.telegram.pollingEnabled) {
          tgBot.telegram
            .sendMessage(
              config.telegram.groupId,
              '⚠️ Chưa đăng nhập Zalo. Gửi <b>/login</b> để đăng nhập.',
              { parse_mode: 'HTML' },
            )
            .catch(() => undefined);
        }
      });
  };

  // ── Start Telegram bot so /login can be received immediately ───────────────
  // NOTE: tgBot.launch() runs the polling loop forever, so we must NOT await it.
  // The second argument callback fires once getMe() + deleteWebhook() succeed.
  if (config.telegram.pollingEnabled) {
    tgBot.launch({ allowedUpdates: ['message', 'callback_query', 'message_reaction', 'poll_answer', 'poll'] }, () => {
      console.log('[Boot] Telegram bot started ✓');

      syncTelegramCommands()
        .then(() => console.log('[Boot] Telegram command menu synced ✓'))
        .catch((err: unknown) => console.warn('[Boot] Failed to sync Telegram commands:', err));

      // ── Attempt Zalo login in background ────────────────────────────────────
      // If credentials.json exists → connects automatically and updates currentApi.
      // If not → notifies the user to run /login.
      startZaloInBackground();
    });
  } else {
    console.log('[Boot] Telegram polling disabled; core-system owns Telegram webhook');
    startZaloInBackground();
  }

  console.log('[Boot] Bridge is running 🚀  (Ctrl+C to stop)');

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  const shutdown = (signal: string) => {
    console.log(`\n[Boot] Received ${signal}, shutting down...`);
    try { getZaloApi().then(api => api.listener.stop()).catch(() => undefined); } catch { /* ignore */ }
    if (config.telegram.pollingEnabled) tgBot.stop(signal);
    outboundServer?.close();
    process.exit(0);
  };

  process.once('SIGINT',  () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error('[Boot] Fatal error:', err);
  process.exit(1);
});

