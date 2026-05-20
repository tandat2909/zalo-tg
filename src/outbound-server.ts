import http from 'http';
import { config } from './config.js';
import { sendOutboundZaloMessage, type OutboundZaloMessageRequest } from './zalo/outbound.js';
import { getZaloApi } from './zalo/client.js';

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) {
        req.destroy(new Error('Request body too large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJSON(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function isAuthorized(req: http.IncomingMessage): boolean {
  if (!config.outbound.internalToken) return true;
  return req.headers.authorization === `Bearer ${config.outbound.internalToken}`;
}

export function startOutboundServer(): http.Server | null {
  if (!config.outbound.enabled) return null;

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

      if (req.method === 'GET' && url.pathname === '/internal/health') {
        sendJSON(res, 200, { ok: true, outbound_enabled: true });
        return;
      }

      if (!isAuthorized(req)) {
        sendJSON(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/internal/outbound/zalo/messages') {
        const body = await readBody(req);
        const input = JSON.parse(body) as OutboundZaloMessageRequest;
        if (!input.request_id) {
          input.request_id = String(req.headers['idempotency-key'] ?? '');
        }

        const result = await sendOutboundZaloMessage(input);
        sendJSON(res, 200, result);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/internal/zalo/search') {
        const body = await readBody(req);
        const input = JSON.parse(body) as { query?: string; limit?: number };
        const result = await searchZalo(input.query ?? '', input.limit ?? 16);
        sendJSON(res, 200, result);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/internal/zalo/resolve') {
        const body = await readBody(req);
        const input = JSON.parse(body) as { thread_id?: string; thread_type?: 0 | 1 };
        const result = await resolveZalo(input.thread_id ?? '', input.thread_type ?? 0);
        sendJSON(res, 200, result);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/internal/zalo/recall') {
        const body = await readBody(req);
        const input = JSON.parse(body) as { thread_id?: string; thread_type?: 0 | 1; msg_id?: string | number; cli_msg_id?: string | number };
        const result = await recallZalo(input.thread_id ?? '', input.thread_type ?? 0, input.msg_id ?? '', input.cli_msg_id ?? 0);
        sendJSON(res, 200, result);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/internal/zalo/react') {
        const body = await readBody(req);
        const input = JSON.parse(body) as { thread_id?: string; thread_type?: 0 | 1; msg_id?: string | number; cli_msg_id?: string | number; icon?: string };
        const result = await reactZalo(input.thread_id ?? '', input.thread_type ?? 0, input.msg_id ?? '', input.cli_msg_id ?? 0, input.icon ?? '');
        sendJSON(res, 200, result);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/internal/zalo/polls') {
        const body = await readBody(req);
        const input = JSON.parse(body) as { group_id?: string; question?: string; options?: string[]; is_anonymous?: boolean; allow_multi_choices?: boolean };
        const result = await createZaloPoll(input);
        sendJSON(res, 200, result);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/internal/zalo/polls/vote') {
        const body = await readBody(req);
        const input = JSON.parse(body) as { poll_id?: number; option_ids?: number[] };
        const result = await voteZaloPoll(input.poll_id ?? 0, input.option_ids ?? []);
        sendJSON(res, 200, result);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/internal/zalo/polls/lock') {
        const body = await readBody(req);
        const input = JSON.parse(body) as { poll_id?: number };
        const result = await lockZaloPoll(input.poll_id ?? 0);
        sendJSON(res, 200, result);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/internal/zalo/polls/detail') {
        const body = await readBody(req);
        const input = JSON.parse(body) as { poll_id?: number };
        const result = await getZaloPollDetail(input.poll_id ?? 0);
        sendJSON(res, 200, result);
        return;
      }
      
      async function searchZalo(query: string, limit: number): Promise<unknown> {
        const api = await getZaloApi();
        const cleanQuery = query.trim();
        const max = Math.min(Math.max(limit || 16, 1), 30);
        const results: Array<{ id: string; type: 0 | 1; name: string; total_member?: number; phone?: string }> = [];
      
        const phoneQuery = cleanQuery.replace(/\D/g, '');
        if (phoneQuery.length >= 8) {
          try {
            const user = await api.findUser(phoneQuery) as { uid?: string; display_name?: string; zalo_name?: string } | undefined;
            if (user?.uid) {
              results.push({ id: user.uid, type: 0, name: user.display_name || user.zalo_name || `Zalo ${user.uid}`, phone: phoneQuery });
            }
          } catch { /* continue with fuzzy search */ }
        }
      
        try {
          const friends = await api.getAllFriends() as Array<{ userId: string; displayName: string }> | undefined;
          for (const friend of friends ?? []) {
            if (results.length >= max) break;
            if (!cleanQuery || friend.displayName.toLowerCase().includes(cleanQuery.toLowerCase())) {
              if (!results.some(r => r.type === 0 && r.id === friend.userId)) {
                results.push({ id: friend.userId, type: 0, name: friend.displayName });
              }
            }
          }
        } catch { /* ignore friends failure */ }
      
        try {
          const rawGroups = await api.getAllGroups() as { gridVerMap?: Record<string, string> } | undefined;
          const groupIds = Object.keys(rawGroups?.gridVerMap ?? {});
          for (let i = 0; i < groupIds.length && results.length < max; i += 50) {
            const batch = groupIds.slice(i, i + 50);
            const info = await api.getGroupInfo(batch) as { gridInfoMap?: Record<string, { name: string; totalMember?: number }> } | undefined;
            for (const [groupId, group] of Object.entries(info?.gridInfoMap ?? {})) {
              if (results.length >= max) break;
              if (!cleanQuery || group.name.toLowerCase().includes(cleanQuery.toLowerCase())) {
                results.push({ id: groupId, type: 1, name: group.name, total_member: group.totalMember });
              }
            }
          }
        } catch { /* ignore groups failure */ }
      
        return { ok: true, query: cleanQuery, results: results.slice(0, max) };
      }
      
      async function resolveZalo(threadId: string, threadType: 0 | 1): Promise<unknown> {
        const api = await getZaloApi();
        const cleanThreadId = threadId.trim();
        let displayName = cleanThreadId;
        if (threadType === 1) {
          try {
            const info = await api.getGroupInfo(cleanThreadId) as { gridInfoMap?: Record<string, { name?: string }> } | undefined;
            displayName = info?.gridInfoMap?.[cleanThreadId]?.name || cleanThreadId;
          } catch { /* fallback */ }
        } else {
          try {
            const resp = await api.getUserInfo(cleanThreadId) as { changed_profiles?: Record<string, { displayName?: string; zaloName?: string }> } | undefined;
            const profile = resp?.changed_profiles?.[cleanThreadId] ?? resp?.changed_profiles?.[`${cleanThreadId}_0`];
            displayName = profile?.displayName || profile?.zaloName || cleanThreadId;
          } catch { /* fallback */ }
        }
        return { ok: true, thread_id: cleanThreadId, thread_type: threadType, display_name: displayName };
      }

      async function recallZalo(threadId: string, threadType: 0 | 1, msgId: string | number, cliMsgId: string | number): Promise<unknown> {
        const cleanThreadId = threadId.trim();
        const cleanMsgId = String(msgId).trim();
        if (!cleanThreadId) throw new Error('Missing thread_id');
        if (!cleanMsgId) throw new Error('Missing msg_id');
        const api = await getZaloApi();
        await api.undo({ msgId: cleanMsgId, cliMsgId: cliMsgId || 0 }, cleanThreadId, threadType);
        return { ok: true, thread_id: cleanThreadId, thread_type: threadType, msg_id: cleanMsgId };
      }

      async function reactZalo(threadId: string, threadType: 0 | 1, msgId: string | number, cliMsgId: string | number, icon: string): Promise<unknown> {
        const cleanThreadId = threadId.trim();
        const cleanMsgId = String(msgId).trim();
        const cleanIcon = icon.trim();
        if (!cleanThreadId) throw new Error('Missing thread_id');
        if (!cleanMsgId) throw new Error('Missing msg_id');
        if (!cleanIcon) throw new Error('Missing icon');
        const api = await getZaloApi();
        await api.addReaction(
          { rType: 0, source: 0, icon: cleanIcon },
          {
            data: { msgId: cleanMsgId, cliMsgId: cliMsgId || 0 },
            threadId: cleanThreadId,
            type: threadType,
          },
        );
        return { ok: true, thread_id: cleanThreadId, thread_type: threadType, msg_id: cleanMsgId, icon: cleanIcon };
      }

      function normalizePollDetail(pollId: number, detail: any): { ok: true; poll_id: number; options: Array<{ option_id: number; content: string; votes: number }>; closed: boolean; question?: string; allow_multi_choices?: boolean } {
        const options = (detail?.options ?? []).map((option: any, index: number) => ({
          option_id: Number(option?.option_id ?? option?.id ?? index),
          content: String(option?.content ?? option?.text ?? ''),
          votes: Number(option?.votes ?? option?.voter_count ?? 0),
        }));
        return {
          ok: true,
          poll_id: Number(detail?.poll_id ?? detail?.pollId ?? pollId),
          question: detail?.question,
          options,
          closed: Boolean(detail?.closed ?? detail?.is_closed ?? false),
          allow_multi_choices: Boolean(detail?.allow_multi_choices ?? detail?.allowMultiChoices ?? false),
        };
      }

      async function createZaloPoll(input: { group_id?: string; question?: string; options?: string[]; is_anonymous?: boolean; allow_multi_choices?: boolean }): Promise<unknown> {
        const groupId = String(input.group_id ?? '').trim();
        const question = String(input.question ?? '').trim();
        const options = (input.options ?? []).map(o => String(o).trim()).filter(Boolean);
        if (!groupId) throw new Error('Missing group_id');
        if (!question) throw new Error('Missing question');
        if (options.length < 2) throw new Error('Missing options');
        const api = await getZaloApi();
        const created = await api.createPoll({
          question,
          options,
          isAnonymous: input.is_anonymous ?? false,
          allowMultiChoices: input.allow_multi_choices ?? false,
        }, groupId) as any;
        const normalized = normalizePollDetail(Number(created?.poll_id ?? created?.pollId ?? 0), created);
        return { ...normalized, group_id: groupId };
      }

      async function voteZaloPoll(pollId: number, optionIds: number[]): Promise<unknown> {
        if (!pollId) throw new Error('Missing poll_id');
        const api = await getZaloApi();
        await api.votePoll(pollId, optionIds.length === 1 ? optionIds[0] : optionIds);
        return getZaloPollDetail(pollId);
      }

      async function lockZaloPoll(pollId: number): Promise<unknown> {
        if (!pollId) throw new Error('Missing poll_id');
        const api = await getZaloApi();
        await api.lockPoll(pollId);
        return getZaloPollDetail(pollId);
      }

      async function getZaloPollDetail(pollId: number): Promise<unknown> {
        if (!pollId) throw new Error('Missing poll_id');
        const api = await getZaloApi();
        const detail = await api.getPollDetail(pollId) as any;
        return normalizePollDetail(pollId, detail);
      }

      sendJSON(res, 404, { ok: false, error: 'not found' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.includes('Missing') || message.includes('Unsupported') ? 400 : 500;
      sendJSON(res, status, { ok: false, error: message });
    }
  });

  server.listen(config.outbound.port, config.outbound.host, () => {
    console.log(`[Outbound] HTTP server listening on ${config.outbound.host}:${config.outbound.port}`);
  });

  return server;
}
