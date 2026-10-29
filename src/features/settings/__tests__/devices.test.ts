// 设备列表的纯函数（架构 0.29 续第 99、103、108、111、118 条；0.38 第 14 条）
import { describe, expect, it } from 'vitest';
import {
  REMOVE_AFTER_MS,
  STALE_AFTER_MS,
  lastActive,
  sessionIdOfToken,
  sortDevices,
  toDeviceView,
  toSessionInfo,
  type DeviceRow,
} from '../data/devices.ts';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-29T03:00:00Z');

function row(over: Partial<DeviceRow> = {}): DeviceRow {
  return {
    id: 'd1',
    label: null,
    platform: 'ios',
    last_seen_at: new Date(NOW - DAY).toISOString(),
    created_at: new Date(NOW - 10 * DAY).toISOString(),
    session_id: 's-other',
    ...over,
  };
}

function token(payload: object): string {
  const b64 = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `eyJhbGciOiJIUzI1NiJ9.${b64}.sig`;
}

describe('toDeviceView', () => {
  it('session_id 等于当前会话的是本机；为空的是“已退出”（第 99 条⑥、第 103 条①）', () => {
    expect(toDeviceView(row({ session_id: 's-me' }), 's-me', NOW).isCurrent).toBe(true);
    expect(toDeviceView(row({ session_id: 's-other' }), 's-me', NOW).isCurrent).toBe(false);
    const gone = toDeviceView(row({ session_id: null }), 's-me', NOW);
    expect(gone.signedOut).toBe(true);
    expect(gone.isCurrent).toBe(false);
    // 读不出当前会话时谁都不是本机（不会把别的设备当成本机）
    expect(toDeviceView(row({ session_id: null }), null, NOW).isCurrent).toBe(false);
  });

  it('不认识的平台记为 unknown，空白的名字当没起名', () => {
    const v = toDeviceView(row({ platform: 'android', label: '   ' }), null, NOW);
    expect(v.platform).toBe('unknown');
    expect(v.label).toBeNull();
    expect(toDeviceView(row({ label: ' 我的 iPhone ' }), null, NOW).label).toBe('我的 iPhone');
  });

  it('超过 150 天没用写“<日期> 后自动移除”（180 天），没超过不写（第 108 条）', () => {
    const lastMs = NOW - STALE_AFTER_MS - DAY;
    const stale = toDeviceView(row({ last_seen_at: new Date(lastMs).toISOString(), created_at: new Date(lastMs - DAY).toISOString() }), null, NOW);
    expect(stale.autoRemoveAtMs).toBe(lastMs + REMOVE_AFTER_MS);
    expect(toDeviceView(row(), null, NOW).autoRemoveAtMs).toBeNull();
  });
});

describe('lastActive（0.38 第 14 条）', () => {
  it('取 last_seen_at 和 created_at 里较晚的', () => {
    expect(lastActive({ last_seen_at: new Date(NOW - DAY).toISOString(), created_at: new Date(NOW - 2 * DAY).toISOString() }, NOW)).toBe(NOW - DAY);
    expect(lastActive({ last_seen_at: new Date(NOW - 9 * DAY).toISOString(), created_at: new Date(NOW - 2 * DAY).toISOString() }, NOW)).toBe(NOW - 2 * DAY);
  });

  it('last_seen_at 比现在快 1 天以上的不认（免得死设备永远不显示“很久没用”）', () => {
    const created = NOW - 200 * DAY;
    expect(lastActive({ last_seen_at: new Date(NOW + 2 * DAY).toISOString(), created_at: new Date(created).toISOString() }, NOW)).toBe(created);
    expect(lastActive({ last_seen_at: new Date(NOW + DAY / 2).toISOString(), created_at: null }, NOW)).toBe(NOW + DAY / 2);
  });

  it('两个都没有或格式不对时为 null', () => {
    expect(lastActive({ last_seen_at: null, created_at: null }, NOW)).toBeNull();
    expect(lastActive({ last_seen_at: 'x', created_at: null }, NOW)).toBeNull();
  });
});

describe('sortDevices', () => {
  it('本机排第一，其余按最后活动从近到远，没有时间的最后', () => {
    const list = [
      toDeviceView(row({ id: 'old', last_seen_at: new Date(NOW - 5 * DAY).toISOString(), created_at: null }), 's-me', NOW),
      toDeviceView(row({ id: 'none', last_seen_at: null, created_at: null }), 's-me', NOW),
      toDeviceView(row({ id: 'me', session_id: 's-me', last_seen_at: new Date(NOW - 9 * DAY).toISOString(), created_at: null }), 's-me', NOW),
      toDeviceView(row({ id: 'new', last_seen_at: new Date(NOW - DAY).toISOString(), created_at: null }), 's-me', NOW),
    ];
    expect(sortDevices(list).map((d) => d.id)).toEqual(['me', 'new', 'old', 'none']);
  });
});

describe('sessionIdOfToken', () => {
  it('从 access token 的 payload 读 session_id（base64url，含 - 和 _）', () => {
    expect(sessionIdOfToken(token({ sub: 'u', session_id: 'abc-123', pad: '???>>>' }))).toBe('abc-123');
  });

  it('没有、格式不对都回 null', () => {
    expect(sessionIdOfToken(null)).toBeNull();
    expect(sessionIdOfToken('abc')).toBeNull();
    expect(sessionIdOfToken('a.%%%.c')).toBeNull();
    expect(sessionIdOfToken(token({ sub: 'u' }))).toBeNull();
  });
});

describe('toSessionInfo（my_sessions，第 111、118 条；20261029193000）', () => {
  it('读第一行的 orphan_count、orphan_last_at、signed_out_device_ids', () => {
    const info = toSessionInfo([{ orphan_count: 2, orphan_last_at: '2026-10-28T01:00:00Z', signed_out_device_ids: ['a', 'b'] }]);
    expect(info.orphans).toEqual({ count: 2, lastAtMs: Date.parse('2026-10-28T01:00:00Z') });
    expect([...info.signedOutIds]).toEqual(['a', 'b']);
  });

  it('0 个、读失败（null）、格式不对一律当 0 个、没有已退出的设备', () => {
    for (const v of [[{ orphan_count: 0, orphan_last_at: null, signed_out_device_ids: [] }], null, [], [{ orphan_count: '3', signed_out_device_ids: 'x' }]]) {
      const info = toSessionInfo(v);
      expect(info.orphans).toEqual({ count: 0, lastAtMs: null });
      expect(info.signedOutIds.size).toBe(0);
    }
  });
});

describe('已退出（TC-B1-79 ②）', () => {
  it('在 signed_out_device_ids 里的行标“已退出”（会话已不在、已被吊销）；本机永远不算', () => {
    const ids = new Set(['x', 'me']);
    expect(toDeviceView(row({ id: 'x', session_id: 's-x' }), 's-me', NOW, ids).signedOut).toBe(true);
    expect(toDeviceView(row({ id: 'z', session_id: 's-z' }), 's-me', NOW, ids).signedOut).toBe(false);
    expect(toDeviceView(row({ id: 'me', session_id: 's-me' }), 's-me', NOW, ids).signedOut).toBe(false);
  });
});
