// 账号信的防钓鱼说明和时区说法（接手清单 KO-mail-nolink-tz；依据 docs/03-评审/B2/B2-韩文审校-补发删除提醒信.md 第一节末、第二节，
// 复核 docs/03-评审/B2/B2-韩文审校-账号信防钓鱼与时区.md）：
//   ① 让用户打开 App 的五封（申请注销、删除提醒、补发提醒、恢复成功、导出通知）中、韩两种都以 NO_LINK_NOTE 这一句结尾，且只出现一次；
//      已注销那封不加（账号已删）；
//   ② 六封都不带任何链接（http、www、域名、<a、mailto）；
//   ③ 时刻后面的括号写读者看得懂的时区说法（shared/i18n/tz-label.ts，前后端共用一份）：固定表逐字钉死（含别名归并），
//      表外按 Intl 通称，说法里有拉丁字母（Deno 的“Honolulu 시간”这类、GMT±hh:mm）就退回 IANA 名；任何一封正文里都不再出现 Asia/；
//   ④ 中文“）”后面不留半角空格（复核 W-4）；
//   两个 index.ts 注入同一份 tzLabel 的静态检查在 tests/build/account-mail-tz-wiring.test.ts（这里的 tsconfig 没有 node 类型）。
import { describe, expect, it } from 'vitest';
import { canonicalTz, fixedTzLabel, labelFromIntl, tzLabel } from '../../shared/i18n/tz-label.ts';
import {
  deletionDoneMail, deletionReminderLateMail, deletionReminderMail, deletionRequestedMail, exportMail, fmtWhen,
  NO_LINK_NOTE, restoredMail, safeTz, type Mail, type MailLocale,
} from '../../supabase/functions/_shared/account-mail.ts';

const LOCS: readonly MailLocale[] = ['zh-CN', 'ko-KR'];
const AT = Date.parse('2026-11-07T03:00:00Z');   // 首尔 12:00

function fiveMails(loc: MailLocale, tz: string): Record<string, Mail> {
  return {
    requested: deletionRequestedMail(loc, AT, tz, tzLabel),
    reminder: deletionReminderMail(loc, AT, tz, tzLabel),
    late: deletionReminderLateMail(loc, AT, tz, tzLabel),
    restored: restoredMail(loc),
    export: exportMail(loc, AT, tz, 'iPhone', { country: 'KR', city: 'Seoul' }, tzLabel),
  };
}

const LINKISH = /https?:|www\.|\.com\b|\.co\b|\.kr\b|\.net\b|\.app\b|lemomemo|<a\s|href|mailto:/i;

describe('防钓鱼说明（NO_LINK_NOTE）', () => {
  it('文案按复核定稿（N-2 韩文“앱에서 직접 확인”、N-3 中文只写“柠檬记”），本身不带链接', () => {
    expect(NO_LINK_NOTE['ko-KR']).toBe('이 메일에는 링크가 없어요. 레모 앱에서 직접 확인해 주세요.');
    expect(NO_LINK_NOTE['zh-CN']).toBe('这封邮件里没有任何链接，请直接打开柠檬记查看。');
    for (const loc of LOCS) expect(NO_LINK_NOTE[loc]).not.toMatch(LINKISH);
  });

  it('五封信中、韩两种都以这一句结尾（前面空一行），只出现一次；语言不串', () => {
    for (const loc of LOCS) {
      const other: MailLocale = loc === 'ko-KR' ? 'zh-CN' : 'ko-KR';
      for (const [name, m] of Object.entries(fiveMails(loc, 'Asia/Seoul'))) {
        expect(m.text.endsWith(`\n\n${NO_LINK_NOTE[loc]}`), `${loc} ${name}`).toBe(true);
        expect(m.text.split(NO_LINK_NOTE[loc]).length - 1, `${loc} ${name}`).toBe(1);
        expect(m.text, `${loc} ${name}`).not.toContain(NO_LINK_NOTE[other]);
        expect(m.subject, `${loc} ${name}`).not.toContain(NO_LINK_NOTE[loc]);
      }
    }
  });

  it('已注销那封不加（账号已删，没有可打开查看的东西）', () => {
    for (const loc of LOCS) expect(deletionDoneMail(loc).text).not.toContain(NO_LINK_NOTE[loc]);
  });

  it('六封信标题和正文都不带任何链接（含不同时区、导出信带设备名和地区时）', () => {
    for (const loc of LOCS) {
      for (const tz of ['Asia/Seoul', 'America/New_York', 'Pacific/Honolulu', 'America/Toronto', 'Not/AZone']) {
        const all = { ...fiveMails(loc, tz), done: deletionDoneMail(loc) };
        for (const [name, m] of Object.entries(all)) {
          expect(`${m.subject}\n${m.text}`, `${loc} ${tz} ${name}`).not.toMatch(LINKISH);
        }
      }
    }
  });
});

/** 复核 3.3 的固定表（含 T-9 的别名），逐字 */
const FIXED: ReadonlyArray<[zones: readonly string[], ko: string, zh: string]> = [
  [['Asia/Seoul', 'ROK'], '한국 시간', '韩国时间'],
  [['Asia/Shanghai', 'Asia/Chongqing', 'Asia/Harbin', 'PRC'], '중국 시간', '北京时间'],
  [['Asia/Tokyo', 'Japan'], '일본 시간', '日本时间'],
  [['Asia/Hong_Kong'], '홍콩 시간', '香港时间'],
  [['Asia/Taipei'], '대만 시간', '台北时间'],
  [['Asia/Singapore'], '싱가포르 시간', '新加坡时间'],
  [['Asia/Bangkok'], '태국 시간', '泰国时间'],
  [['Asia/Ho_Chi_Minh'], '베트남 시간', '越南时间'],
  [['America/New_York'], '미국 동부 시간', '美国东部时间'],
  [['America/Chicago'], '미국 중부 시간', '美国中部时间'],
  [['America/Denver'], '미국 산악 시간', '美国山地时间'],
  [['America/Los_Angeles'], '미국 서부 시간', '美国西部时间'],
  [['Pacific/Honolulu'], '하와이 시간', '夏威夷时间'],
  [['Europe/London'], '영국 시간', '英国时间'],
  [['Europe/Paris', 'Europe/Berlin'], '중부 유럽 시간', '欧洲中部时间'],
  [['Australia/Sydney'], '호주 동부 시간', '澳大利亚东部时间'],
];

describe('时区说法（shared/i18n/tz-label.ts）', () => {
  it('固定表 16 行逐字（含别名归并）；都不含拉丁字母；加拿大不进表', () => {
    expect(FIXED).toHaveLength(16);
    for (const [zones, ko, zh] of FIXED) {
      for (const z of zones) {
        expect(fixedTzLabel(z, 'ko-KR'), z).toBe(ko);
        expect(fixedTzLabel(z, 'zh-CN'), z).toBe(zh);
        expect(tzLabel(z, 'ko-KR'), z).toBe(ko);
        expect(tzLabel(z, 'zh-CN'), z).toBe(zh);
      }
      expect(`${ko}${zh}`).not.toMatch(/[A-Za-z]/);
    }
    for (const z of ['America/Toronto', 'America/Vancouver', 'UTC', 'Not/AZone', '']) expect(fixedTzLabel(z, 'ko-KR'), z).toBeNull();
  });

  it('Intl 的说法：有拉丁字母（Deno 的“Honolulu 시간 / Honolulu时间”、GMT 偏移）或空的退回 IANA 名，其余照用', () => {
    expect(labelFromIntl('Pacific/Midway', 'Honolulu 시간')).toBe('Pacific/Midway');
    expect(labelFromIntl('Pacific/Midway', 'Honolulu时间')).toBe('Pacific/Midway');
    expect(labelFromIntl('UTC', 'GMT+00:00')).toBe('UTC');
    expect(labelFromIntl('Etc/GMT-3', 'GMT+03:00')).toBe('Etc/GMT-3');
    expect(labelFromIntl('Asia/Dubai', '')).toBe('Asia/Dubai');
    expect(labelFromIntl('America/Toronto', '북미 동부 시간')).toBe('북미 동부 시간');
    expect(labelFromIntl('America/Toronto', '北美东部时间')).toBe('北美东部时间');
  });

  it('表外时区：说法要么是 IANA 名本身，要么不含拉丁字母（T-7）', () => {
    const outside = ['America/Toronto', 'America/Vancouver', 'Asia/Kolkata', 'Asia/Dubai', 'Asia/Manila', 'Asia/Jakarta', 'Europe/Madrid', 'Europe/Moscow',
      'Australia/Perth', 'Pacific/Auckland', 'Pacific/Midway', 'America/Sao_Paulo', 'Africa/Cairo', 'Atlantic/Reykjavik', 'UTC', 'Etc/GMT-3'];
    for (const loc of LOCS) {
      for (const z of outside) {
        const label = tzLabel(z, loc);
        // 退回 IANA 名时退回的是规范名（Asia/Kolkata 在 V8 是 Asia/Calcutta），不按原名比
        expect(label === z || label === canonicalTz(z) || !/[A-Za-z]/.test(label), `${loc} ${z} → ${label}`).toBe(true);
        expect(label, `${loc} ${z}`).not.toBe('');
      }
    }
    expect(tzLabel('UTC', 'ko-KR')).toBe('UTC');
  });

  it('KO-mail-tz-low L1：safeTz 和 shared 的 canonicalTz(tz) ?? Asia/Seoul 逐个输入一致（account-mail.ts 照抄那三行，这条防两边走样）', () => {
    const inputs: unknown[] = ['Asia/Seoul', 'asia/seoul', 'ASIA/SEOUL', 'ROK', 'Asia/Kolkata', 'Asia/Calcutta', 'US/Pacific', 'America/Los_Angeles', 'UTC', 'utc',
      'Etc/GMT-3', 'GMT', '+09:00', 'Europe/Kiev', 'Europe/Kyiv', 'Not/AZone', '', ' ', 'x'.repeat(65), null, undefined, 9, {},
      // 复审低建议 L5：前后带空白的（Intl 会不会自己去空白、两边是否一样处理）
      'Asia/Seoul ', ' Asia/Seoul', '\tUTC', 'Asia/Seoul\n'];
    for (const z of inputs) expect(safeTz(z), String(z)).toBe(canonicalTz(z) ?? 'Asia/Seoul');
  });

  it('fmtWhen 的完整写法：括号里是通俗说法；时区名不对按首尔；冬夏同一说法', () => {
    expect(fmtWhen(AT, 'Asia/Seoul', 'ko-KR', tzLabel)).toBe('2026년 11월 7일 12:00 (한국 시간)');
    expect(fmtWhen(AT, 'Asia/Seoul', 'zh-CN', tzLabel)).toBe('2026年11月7日 12:00（韩国时间）');
    expect(fmtWhen(AT, 'Asia/Tokyo', 'ko-KR', tzLabel)).toBe('2026년 11월 7일 12:00 (일본 시간)');
    expect(fmtWhen(AT, 'Asia/Shanghai', 'zh-CN', tzLabel)).toBe('2026年11月7日 11:00（北京时间）');
    expect(fmtWhen(AT, 'Pacific/Honolulu', 'ko-KR', tzLabel)).toBe('2026년 11월 6일 17:00 (하와이 시간)');
    expect(fmtWhen(AT, 'Not/AZone', 'ko-KR', tzLabel)).toBe('2026년 11월 7일 12:00 (한국 시간)');
    expect(fmtWhen(AT, null, 'zh-CN', tzLabel)).toBe('2026年11月7日 12:00（韩国时间）');
    const jan = fmtWhen(Date.parse('2026-01-15T03:00:00Z'), 'Europe/Paris', 'ko-KR', tzLabel);
    const jul = fmtWhen(Date.parse('2026-07-15T03:00:00Z'), 'Europe/Paris', 'ko-KR', tzLabel);
    expect(jan.endsWith('(중부 유럽 시간)') && jul.endsWith('(중부 유럽 시간)')).toBe(true);
  });

  it('五封信正文都不再出现 Asia/；带时刻的四封写“한국 시간”“韩国时间”；中文“）”后不留半角空格（W-4）', () => {
    for (const loc of LOCS) {
      const label = loc === 'ko-KR' ? '(한국 시간)' : '（韩国时间）';
      for (const [name, m] of Object.entries(fiveMails(loc, 'Asia/Seoul'))) {
        expect(m.text, `${loc} ${name}`).not.toContain('Asia/');
        if (name !== 'restored') expect(m.text, `${loc} ${name}`).toContain(label);
        if (loc === 'zh-CN') expect(m.text, name).not.toMatch(/） /);
      }
    }
    expect(deletionRequestedMail('zh-CN', AT, 'Asia/Seoul', tzLabel).text).toContain('将在 2026年11月7日 12:00（韩国时间）彻底删除账号和全部数据。');
    expect(deletionReminderMail('zh-CN', AT, 'Asia/Seoul', tzLabel).text).toContain('将在 2026年11月7日 12:00（韩国时间）彻底删除。');
    expect(deletionReminderLateMail('zh-CN', AT, 'Asia/Seoul', tzLabel).text).toContain('将在 2026年11月7日 12:00（韩国时间）彻底删除。');
  });
});

describe('时区说法按信的时刻取（接手清单 TZ-label-at）', () => {
  it('fmtWhen 把信的时刻 ms 原样传给 label 的第三个参数（四封带时刻的信都一样）', () => {
    const seen: (number | undefined)[] = [];
    const fake = (_zone: string, _loc: MailLocale, at?: number) => { seen.push(at); return 'X'; };
    const T = Date.parse('2026-03-15T08:00:00Z');
    expect(fmtWhen(T, 'Europe/Kyiv', 'zh-CN', fake)).toContain('（X）');
    deletionRequestedMail('ko-KR', T + 1, 'Asia/Seoul', fake);
    deletionReminderMail('zh-CN', T + 2, 'Asia/Seoul', fake);
    deletionReminderLateMail('ko-KR', T + 3, 'Asia/Seoul', fake);
    exportMail('zh-CN', T + 4, 'Asia/Seoul', 'iPhone', null, fake);
    expect(seen).toEqual([T, T + 1, T + 2, T + 3, T + 4]);
  });

  it('真 tzLabel、2026 年的时刻：Europe/Kyiv 的信里不出现“莫斯科 / 모스크바”', () => {
    for (const loc of LOCS) {
      for (const [k, m] of Object.entries(fiveMails(loc, 'Europe/Kyiv'))) {
        expect(m.text, `${loc} ${k}`).not.toMatch(/莫斯科|모스크바/);
      }
    }
  });
});
