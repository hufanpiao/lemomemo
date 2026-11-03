// 整页提醒的地址、hash、通知 tag 只写在 shared/logic/remind-route.ts（架构 0.53 第 1 条）：
// 这里是对这一份的单测，加上 B2 安全审查 FE-3 的地址正则；SW（src/sw/push.ts）和页面（src/platform/native-bridge.ts）都只是转出它
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { reminderHash, reminderTag, reminderUrl, type ReminderKind } from '../../shared/logic/remind-route.ts';
import * as bridge from '../../src/platform/native-bridge.ts';
import * as sw from '../../src/sw/push.ts';

/** FE-3：SW 只打开这种地址 */
const URL_RE = /^\/app\/#\/remind\/(event|todo|anniv)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\?due=[1-9][0-9]*$/;
const KINDS = ['event', 'todo', 'anniv'] as const satisfies readonly ReminderKind[];
const ID = '33333333-3333-4333-8333-333333333333';

describe('shared/logic/remind-route.ts', () => {
  it.each(KINDS)('%s：hash、地址、tag 的拼法', (kind) => {
    expect(reminderHash(kind, ID, 1_800_000_000_000)).toBe(`#/remind/${kind}/${ID}?due=1800000000000`);
    expect(reminderUrl(kind, ID, 1_800_000_000_000)).toBe(`/app/#/remind/${kind}/${ID}?due=1800000000000`);
    expect(reminderTag(kind, ID, 1_800_000_000_000)).toBe(`${kind}:${ID}:1800000000000`);
  });

  it('合法输入拼出的地址都匹配 FE-3 正则', () => {
    for (const kind of KINDS) for (const due of [1, 9, 10, 1_800_000_000_000, Number.MAX_SAFE_INTEGER]) {
      expect(reminderUrl(kind, ID, due)).toMatch(URL_RE);
      expect(`/app/${reminderHash(kind, ID, due)}`).toBe(reminderUrl(kind, ID, due));
    }
  });

  it('正则本身：不合法的地址一律不匹配（调用方没校验时这里兜不住，所以 SW 的 dataOf 要先校验）', () => {
    const bad = [
      reminderUrl('event', '../x', 1),
      reminderUrl('event', ID, 0),
      reminderUrl('event', ID, 1.5),
      reminderUrl('event', ID, -1),
      reminderUrl('memo' as ReminderKind, ID, 1),
      `/app/#/remind/event/AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA?due=1`,
      `https://evil.example/app/#/remind/event/${ID}?due=1`,
      `/app/#/remind/event/${ID}?due=1&x=2`,
      `//evil.example/#/remind/event/${ID}?due=1`,
    ];
    for (const u of bad) expect(u).not.toMatch(URL_RE);
  });

  it('不 import 任何文件（SW 包里不能带进别的代码）', () => {
    const code = readFileSync('shared/logic/remind-route.ts', 'utf8');
    expect(code).not.toMatch(/^\s*import\b/m);
    expect(code).not.toMatch(/\bimport\s*\(/);
    expect(code).not.toMatch(/^\s*export\s+[^;]*\bfrom\b/m);
  });

  it('SW 和 platform 转出的是同一份函数（没有各写一份）', () => {
    expect(sw.reminderUrl).toBe(reminderUrl);
    expect(sw.notificationTag).toBe(reminderTag);
    expect(bridge.reminderPath).toBe(reminderUrl);
    expect(bridge.reminderHash).toBe(reminderHash);
    expect(bridge.reminderTag).toBe(reminderTag);
    for (const f of ['src/sw/push.ts', 'src/platform/native-bridge.ts']) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/#\/remind\//);
    }
  });
});
