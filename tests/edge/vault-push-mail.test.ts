// 隐私记的推送负载（payload.ts 的 vault 类型，代定 D19）和重设密码通知信（account-mail.ts 的 vaultResetMail，B5 任务单 S2）。
import { describe, expect, it } from 'vitest';
import { tzLabel } from '../../shared/i18n/tz-label.ts';
import { NO_LINK_NOTE, vaultResetMail } from '../../supabase/functions/_shared/account-mail.ts';
import { buildPayload, PushPayloadError, VAULT_PUSH_EVENTS } from '../../supabase/functions/_shared/push/payload.ts';
import { A } from '../functions/vault-fakes.ts';

const LINKISH = /https?:|www\.|\.com\b|lemomemo|<a\s|href|mailto:/i;

describe('vault 推送负载', () => {
  it('四种 event 各自正好四个键、不带任何内容', () => {
    for (const event of VAULT_PUSH_EVENTS) {
      const o = JSON.parse(new TextDecoder().decode(buildPayload({ type: 'vault', user_id: A, event }))) as Record<string, unknown>;
      expect(o).toEqual({ v: 1, type: 'vault', user_id: A, event });
    }
  });
  it('不认识的 event、坏 user_id 抛 PushPayloadError', () => {
    expect(() => buildPayload({ type: 'vault', user_id: A, event: 'opened' as never })).toThrow(PushPayloadError);
    expect(() => buildPayload({ type: 'vault', user_id: 'x', event: 'reset' })).toThrow(PushPayloadError);
  });
});

describe('vaultResetMail', () => {
  const AT = Date.parse('2026-11-13T03:00:00Z');   // 首尔 12:00
  it('中文、韩文：写时刻和时区说法，提醒 Face ID 要重绑；以防钓鱼说明结尾；不带链接', () => {
    const zh = vaultResetMail('zh-CN', AT, 'Asia/Seoul', tzLabel);
    expect(zh.subject).toBe('你的柠檬记隐私记密码已重设');
    expect(zh.text).toContain('韩国时间');
    expect(zh.text).toContain('Face ID');
    const ko = vaultResetMail('ko-KR', AT, 'Asia/Seoul', tzLabel);
    expect(ko.text).toContain('한국 시간');
    for (const [loc, m] of [['zh-CN', zh], ['ko-KR', ko]] as const) {
      expect(m.text.endsWith(`\n\n${NO_LINK_NOTE[loc]}`), loc).toBe(true);
      expect(`${m.subject}\n${m.text}`, loc).not.toMatch(LINKISH);
    }
  });
});
