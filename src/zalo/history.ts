import type { ZaloAPI, ZaloMessage } from './types.js';
import {
  forwardZaloMessageEventToCore,
  forwardGroupMembersToCore,
  type ResolvedThreadInfo,
} from './core-events.js';

export interface ReplayResult {
  messages: number;
  members: number;
}

/**
 * Kéo lịch sử chat của một Zalo group về core: sync member list + replay
 * toàn bộ tin nhắn (sort tăng dần theo thời gian). Tin replay gắn cờ
 * replay=true nên core chỉ lưu DB làm context, KHÔNG đẩy lại Telegram
 * (tránh rate-limit) và KHÔNG kích hoạt orchestration trên tin cũ.
 *
 * Lưu ý: getGroupChatHistory của Zalo chỉ nhận `count` (không có offset/cursor),
 * nên "toàn bộ" thực tế bị giới hạn bởi `count` tin gần nhất.
 *
 * @param count số tin tối đa kéo về (mặc định 200)
 */
export async function replayZaloGroupHistory(
  api: ZaloAPI,
  groupId: string,
  count = 200,
): Promise<ReplayResult> {
  let threadInfo: ResolvedThreadInfo | undefined;
  let members = 0;

  // 1) Lấy group info: tên/avatar (đặt tên topic đúng) + member list
  try {
    const info = await api.getGroupInfo(groupId) as {
      gridInfoMap?: Record<string, {
        name?: string;
        avt?: string;
        currentMems?: Array<{ id?: string; dName?: string; zaloName?: string; avatar?: string }>;
      }>;
    };
    const group = info?.gridInfoMap?.[groupId];
    if (group) {
      threadInfo = { name: group.name, avatarUrl: group.avt };
      const mems = (group.currentMems ?? [])
        .map(m => ({ uid: String(m.id ?? ''), name: String(m.dName ?? ''), zalo_name: m.zaloName, avatar: m.avatar }))
        .filter(m => m.uid && m.name);
      if (mems.length > 0) {
        await forwardGroupMembersToCore(groupId, mems);
        members = mems.length;
      }
    }
  } catch (err) {
    console.warn(`[ZaloHistory] getGroupInfo failed for group ${groupId}:`, err);
  }

  // 2) Replay lịch sử — getGroupChatHistory trả về mới-nhất-trước,
  //    sort tăng dần theo ts để core lưu đúng thứ tự thời gian.
  const history = await api.getGroupChatHistory(groupId, count) as { groupMsgs?: ZaloMessage[] };
  const msgs = (history?.groupMsgs ?? []).slice().sort(
    (a, b) => Number(a?.data?.ts ?? 0) - Number(b?.data?.ts ?? 0),
  );
  for (const msg of msgs) {
    forwardZaloMessageEventToCore(msg, threadInfo, undefined, true);
  }

  return { messages: msgs.length, members };
}
