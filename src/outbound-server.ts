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

export function startOutboundServer(onLoginRequest?: () => void): http.Server | null {
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

      if (req.method === 'POST' && url.pathname === '/internal/zalo/login') {
        await readBody(req).catch(() => '');
        if (!onLoginRequest) {
          sendJSON(res, 503, { ok: false, error: 'login handler not wired' });
          return;
        }
        onLoginRequest();
        sendJSON(res, 202, { ok: true, status: 'login_triggered' });
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


      if (req.method === 'POST' && url.pathname === '/internal/zalo/groups/list') {
        const body = await readBody(req);
        const input = JSON.parse(body) as { limit?: number };
        const result = await listZaloGroups(input.limit ?? 80);
        sendJSON(res, 200, result);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/internal/zalo/friends/find') {
        const body = await readBody(req);
        const input = JSON.parse(body) as { phone?: string };
        const result = await findZaloUser(input.phone ?? '');
        sendJSON(res, 200, result);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/internal/zalo/friends/status') {
        const body = await readBody(req);
        const input = JSON.parse(body) as { user_id?: string };
        const result = await getFriendStatus(input.user_id ?? '');
        sendJSON(res, 200, result);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/internal/zalo/friends/send') {
        const body = await readBody(req);
        const input = JSON.parse(body) as { user_id?: string; message?: string };
        const result = await sendFriendRequest(input.user_id ?? '', input.message ?? 'Xin chào! Mình muốn kết bạn với bạn');
        sendJSON(res, 200, result);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/internal/zalo/friends/respond') {
        const body = await readBody(req);
        const input = JSON.parse(body) as { user_id?: string; action?: string };
        const result = await respondFriendRequest(input.user_id ?? '', input.action ?? 'accept');
        sendJSON(res, 200, result);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/internal/zalo/friends/requests') {
        await readBody(req).catch(() => '');
        const result = await listFriendRequests();
        sendJSON(res, 200, result);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/internal/zalo/groups/join-link') {
        const body = await readBody(req);
        const input = JSON.parse(body) as { link?: string };
        const result = await joinGroupLink(input.link ?? '');
        sendJSON(res, 200, result);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/internal/zalo/groups/join-invite') {
        const body = await readBody(req);
        const input = JSON.parse(body) as { group_id?: string };
        const result = await joinGroupInvite(input.group_id ?? '');
        sendJSON(res, 200, result);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/internal/zalo/groups/leave') {
        const body = await readBody(req);
        const input = JSON.parse(body) as { group_id?: string };
        const result = await leaveGroup(input.group_id ?? '');
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


      async function listZaloGroups(limit: number): Promise<unknown> {
        const api = await getZaloApi();
        const max = Math.min(Math.max(limit || 80, 1), 200);
        const rawGroups = await api.getAllGroups() as { gridVerMap?: Record<string, string> } | undefined;
        const groupIds = Object.keys(rawGroups?.gridVerMap ?? {});
        const groups: Array<{ group_id: string; name: string; total_member: number; raw_json?: unknown }> = [];
        for (let i = 0; i < groupIds.length && groups.length < max; i += 50) {
          const batch = groupIds.slice(i, i + 50);
          const info = await api.getGroupInfo(batch) as { gridInfoMap?: Record<string, { name?: string; totalMember?: number }> } | undefined;
          for (const [groupId, group] of Object.entries(info?.gridInfoMap ?? {})) {
            if (groups.length >= max) break;
            groups.push({ group_id: groupId, name: group.name || groupId, total_member: Number(group.totalMember ?? 0), raw_json: group });
          }
        }
        return { ok: true, groups };
      }

      function normalizeZaloUser(user: any, phone?: string): { uid: string; display_name: string; zalo_name: string; avatar: string; global_id: string; phone?: string; raw_json: unknown } {
        return {
          uid: String(user?.uid ?? user?.userId ?? ''),
          display_name: String(user?.display_name ?? user?.displayName ?? ''),
          zalo_name: String(user?.zalo_name ?? user?.zaloName ?? ''),
          avatar: String(user?.avatar ?? ''),
          global_id: String(user?.globalId ?? user?.global_id ?? ''),
          ...(phone ? { phone } : {}),
          raw_json: user,
        };
      }

      async function findZaloUser(phone: string): Promise<unknown> {
        const cleanPhone = phone.replace(/[^0-9+]/g, '');
        if (!cleanPhone) throw new Error('Missing phone');
        const api = await getZaloApi();
        const user = await api.findUser(cleanPhone) as any;
        return { ok: true, user: normalizeZaloUser(user, cleanPhone) };
      }

      async function getFriendStatus(userId: string): Promise<unknown> {
        const cleanUserId = userId.trim();
        if (!cleanUserId) throw new Error('Missing user_id');
        const api = await getZaloApi();
        const status = await api.getFriendRequestStatus(cleanUserId) as { is_friend?: number | boolean; is_requested?: number | boolean; is_requesting?: number | boolean } | undefined;
        return { ok: true, is_friend: Boolean(status?.is_friend), is_requested: Boolean(status?.is_requested), is_requesting: Boolean(status?.is_requesting) };
      }

      async function sendFriendRequest(userId: string, message: string): Promise<unknown> {
        const cleanUserId = userId.trim();
        if (!cleanUserId) throw new Error('Missing user_id');
        const api = await getZaloApi();
        const raw = await api.sendFriendRequest(message || 'Xin chào! Mình muốn kết bạn với bạn', cleanUserId);
        return { ok: true, action: 'send', user_id: cleanUserId, raw_json: raw };
      }

      async function respondFriendRequest(userId: string, action: string): Promise<unknown> {
        const cleanUserId = userId.trim();
        if (!cleanUserId) throw new Error('Missing user_id');
        const api = await getZaloApi();
        let raw: unknown;
        if (action === 'reject') {
          raw = await api.rejectFriendRequest(cleanUserId);
        } else {
          raw = await api.acceptFriendRequest(cleanUserId);
          action = 'accept';
        }
        return { ok: true, action, user_id: cleanUserId, raw_json: raw };
      }

      async function listFriendRequests(): Promise<unknown> {
        const api = await getZaloApi();
        const [sentReqs, recvRecommends, groupInvites] = await Promise.all([
          api.getSentFriendRequest() as Promise<Record<string, { userId?: string; zaloName?: string; displayName?: string; fReqInfo?: { message?: string } }>>,
          api.getFriendRecommendations() as Promise<{ recommItems?: Array<{ dataInfo?: { userId?: string; zaloName?: string; displayName?: string; recommType?: number; recommInfo?: { message?: string | null } } }> }>,
          api.getGroupInviteBoxList({ invPerPage: 20 }) as Promise<{ invitations?: Array<{ groupInfo?: { groupId?: string; name?: string; totalMember?: number } }> }>,
        ]);
        const sent_requests = Object.entries(sentReqs ?? {}).map(([key, value]) => ({
          user_id: String(value.userId ?? key),
          display_name: String(value.displayName ?? value.zaloName ?? value.userId ?? key),
          message: String(value.fReqInfo?.message ?? ''),
          raw_json: value,
        }));
        const received_requests = (recvRecommends?.recommItems ?? [])
          .map(item => item.dataInfo)
          .filter(info => info?.recommType === 2)
          .map(info => ({
            user_id: String(info?.userId ?? ''),
            display_name: String(info?.displayName ?? info?.zaloName ?? info?.userId ?? ''),
            message: String(info?.recommInfo?.message ?? ''),
            raw_json: info,
          }))
          .filter(item => item.user_id);
        const group_invites = (groupInvites?.invitations ?? [])
          .map(inv => inv.groupInfo)
          .filter(Boolean)
          .map(group => ({
            group_id: String(group?.groupId ?? ''),
            name: String(group?.name ?? group?.groupId ?? ''),
            total_member: Number(group?.totalMember ?? 0),
            raw_json: group,
          }))
          .filter(item => item.group_id);
        return { ok: true, sent_requests, received_requests, group_invites };
      }

      async function joinGroupLink(link: string): Promise<unknown> {
        const cleanLink = link.trim();
        if (!cleanLink) throw new Error('Missing link');
        const api = await getZaloApi();
        let name = '';
        let totalMember = 0;
        try {
          const info = await api.getGroupLinkInfo({ link: cleanLink }) as { groupId?: string; name?: string; totalMember?: number } | undefined;
          name = info?.name ?? '';
          totalMember = Number(info?.totalMember ?? 0);
        } catch { /* info is optional */ }
        const raw = await api.joinGroupLink(cleanLink);
        return { ok: true, name, total_member: totalMember, status: 'joined', raw_json: raw };
      }

      async function joinGroupInvite(groupId: string): Promise<unknown> {
        const cleanGroupId = groupId.trim();
        if (!cleanGroupId) throw new Error('Missing group_id');
        const api = await getZaloApi();
        const raw = await api.joinGroupInviteBox(cleanGroupId);
        let name = '';
        let totalMember = 0;
        try {
          const info = await api.getGroupInfo(cleanGroupId) as { gridInfoMap?: Record<string, { name?: string; totalMember?: number }> } | undefined;
          const group = info?.gridInfoMap?.[cleanGroupId];
          name = group?.name ?? '';
          totalMember = Number(group?.totalMember ?? 0);
        } catch { /* optional */ }
        return { ok: true, group_id: cleanGroupId, name, total_member: totalMember, status: 'joined', raw_json: raw };
      }

      async function leaveGroup(groupId: string): Promise<unknown> {
        const cleanGroupId = groupId.trim();
        if (!cleanGroupId) throw new Error('Missing group_id');
        const api = await getZaloApi();
        const raw = await api.leaveGroup(cleanGroupId);
        return { ok: true, action: 'leave', group_id: cleanGroupId, raw_json: raw };
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
