// 注销、恢复、导出的通知邮件（架构第 6 节 account / account-purge、0.29 续第 96、131、137 条；TC-B1-98、100、107）。
// account（申请、恢复、导出通知）和 account-purge（到期前提醒、彻底删除）共用这一份，文案只此一处。
// 规矩（0.29 续第 137 条②）：注销相关的四封信正文**一律不放可点的链接**（不写 http、不写域名），只写“请打开柠檬记登录”；
//   时刻按本人时区（profiles.current_tz）写；导出通知只写时间、设备名、地区，不写导出了什么（第 96 条①）。
// 不 import npm 包、不读环境变量、不碰 Deno 全局（只用 Intl），Vitest 直接测；deno check 也查这一份。
// 韩文文案：词典里还没有这几条（shared/i18n 没有注销相关的键），先写在这里。已过 R-106 B1 第一遍审校（10-31）；
//   审校建议 5 封改成 해요체并顺带改“회원 탈퇴”、引号、“열어”（docs/03-评审/B1/B1-韩文审校-第一遍.md K-01a～e），等负责人定口吻（明早清单第 48 条），现文未动。

export type MailLocale = 'zh-CN' | 'ko-KR';
export interface Mail {
  subject: string;
  text: string;
}

const FALLBACK_TZ = 'Asia/Seoul';

/**
 * 测试账号（@lemomemo.test）不真的发信（安全审查“预览实测脚本”D1）：.test 收不到，真发会变成退信、算进 lemomemo.com 的退信率。
 * 真实用户不可能有 .test 邮箱，对正式环境没有影响。跳过时只记 mail_skipped_test（不带邮箱），回 false，
 * 调用方照“没发出去”的现有规则处理（导出通知另写一条 export_mail_failed 等）。account、account-purge 共用。
 */
export function isTestRecipient(to: string): boolean {
  return /@lemomemo\.test$/i.test(to.trim());
}
export function skipTestRecipients(
  send: (to: string, mail: Mail) => Promise<boolean>, log: (code: string) => void,
): (to: string, mail: Mail) => Promise<boolean> {
  return (to, mail) => {
    if (isTestRecipient(to)) { log('mail_skipped_test'); return Promise.resolve(false); }
    return send(to, mail);
  };
}

export function mailLocale(v: unknown): MailLocale {
  return v === 'ko-KR' ? 'ko-KR' : 'zh-CN';
}

/** 时区名能不能用；不能用就按首尔（profiles.current_tz 默认值） */
export function safeTz(tz: unknown): string {
  if (typeof tz !== 'string' || tz === '' || tz.length > 64) return FALLBACK_TZ;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0);
    return tz;
  } catch {
    return FALLBACK_TZ;
  }
}

/**
 * 某个时刻在本人时区的“日期 时刻”：zh 写 2026年11月5日 14:30（Asia/Seoul），ko 写 2026년 11월 5일 14:30 (Asia/Seoul)。
 * 不直接用 toLocaleString（各运行环境的 ICU 版本不同，标点会变），按 formatToParts 自己拼。
 */
export function fmtWhen(ms: number, tz: unknown, loc: MailLocale): string {
  const zone = safeTz(tz);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const hh = get('hour').padStart(2, '0');
  const mm = get('minute').padStart(2, '0');
  return loc === 'ko-KR'
    ? `${get('year')}년 ${get('month')}월 ${get('day')}일 ${hh}:${mm} (${zone})`
    : `${get('year')}年${get('month')}月${get('day')}日 ${hh}:${mm}（${zone}）`;
}

/** ① 申请注销（account delete 成功后发） */
export function deletionRequestedMail(loc: MailLocale, purgeAfterMs: number, tz: unknown): Mail {
  const when = fmtWhen(purgeAfterMs, tz, loc);
  if (loc === 'ko-KR') {
    return {
      subject: '레모 계정 탈퇴가 신청되었습니다',
      text: `레모 계정 탈퇴가 신청되었습니다. ${when}에 계정과 모든 데이터가 완전히 삭제됩니다.\n\n`
        + '본인이 신청하지 않았다면 그 전에 레모 앱을 열고 로그인한 뒤 "계정 복구"를 눌러 주세요.\n'
        + '탈퇴 관련 안내는 이 메일로만 보내 드립니다. 스팸함도 확인해 주세요.',
    };
  }
  return {
    subject: '你的柠檬记账号已申请注销',
    text: `你的柠檬记账号已申请注销，将在 ${when} 彻底删除账号和全部数据。\n\n`
      + '不是你本人操作的话，请在这之前打开柠檬记登录，点“恢复账号”。\n'
      + '注销相关的通知只会用邮件发给你，请留意垃圾邮件。',
  };
}

/** ② 满 7 天前 24～48 小时的提醒（account-purge 发） */
export function deletionReminderMail(loc: MailLocale, purgeAfterMs: number, tz: unknown): Mail {
  const when = fmtWhen(purgeAfterMs, tz, loc);
  if (loc === 'ko-KR') {
    return {
      subject: '레모 계정이 곧 완전히 삭제됩니다',
      text: `레모 계정이 ${when}에 완전히 삭제됩니다.\n\n`
        + '본인이 신청하지 않았다면 레모 앱을 열고 로그인한 뒤 "계정 복구"를 선택해 주세요.',
    };
  }
  return {
    subject: '你的柠檬记账号即将彻底删除',
    text: `你的柠檬记账号将在 ${when} 彻底删除。\n\n`
      + '不是你本人操作的话，请打开柠檬记登录，选“恢复账号”。',
  };
}

/** ③ 彻底删除以后（account-purge 发；邮箱是删之前取出来留在内存里的） */
export function deletionDoneMail(loc: MailLocale): Mail {
  if (loc === 'ko-KR') {
    return {
      subject: '레모 계정이 삭제되었습니다',
      text: '레모 계정이 탈퇴 처리되었고, 계정의 데이터와 서버 백업이 모두 삭제되었습니다.\n\n그동안 레모를 사용해 주셔서 감사합니다.',
    };
  }
  return {
    subject: '你的柠檬记账号已注销',
    text: '你的柠檬记账号已注销，账号里的数据和服务器上的备份都已删除。\n\n感谢你使用柠檬记。',
  };
}

/** ④ 恢复成功（account restore 发） */
export function restoredMail(loc: MailLocale): Mail {
  if (loc === 'ko-KR') {
    return {
      subject: '레모 계정이 복구되었습니다',
      text: '레모 계정 탈퇴 신청이 취소되어 계정이 복구되었습니다.\n\n'
        + '본인이 복구하지 않았다면 레모 앱을 열고 로그인한 뒤 설정에서 "다른 모든 기기에서 로그아웃"을 눌러 주세요.',
    };
  }
  return {
    subject: '你的柠檬记账号已恢复',
    text: '你的柠檬记账号已取消注销、恢复正常。\n\n'
      + '不是你本人操作的话，请打开柠檬记登录，在设置里点“退出其他所有设备”。',
  };
}

/** 导出地区：两样都是 '-' 或没有时写“未知地区”；不写 IP 本身（第 96 条①） */
export function fmtGeo(geo: { country: string; city: string } | null, loc: MailLocale): string {
  const unknown = loc === 'ko-KR' ? '알 수 없는 지역' : '未知地区';
  if (!geo) return unknown;
  const bits = [geo.country, geo.city].filter((s) => s && s !== '-');
  return bits.length ? bits.join(' ') : unknown;
}

/**
 * ⑤ 导出通知（第 92 条 b、第 96 条）：只写导出时间、设备名、地区，外加“不是你本人操作，请立刻退出其他所有设备”。
 * 设备名、城市都来自用户自己或转发层，只当纯文本放进 text 正文（没有 html 正文，不会被当成标签）。
 */
export function exportMail(loc: MailLocale, atMs: number, tz: unknown, device: string | null, geo: { country: string; city: string } | null): Mail {
  const when = fmtWhen(atMs, tz, loc);
  const where = fmtGeo(geo, loc);
  if (loc === 'ko-KR') {
    const dev = device ?? '알 수 없는 기기';
    return {
      subject: '레모 데이터가 내보내졌습니다',
      text: `레모 데이터가 내보내졌습니다.\n\n시간: ${when}\n기기: ${dev}\n지역: ${where}\n\n`
        + '본인이 한 것이 아니라면 지금 바로 레모 앱의 설정에서 "다른 모든 기기에서 로그아웃"을 눌러 주세요.',
    };
  }
  const dev = device ?? '未知设备';
  return {
    subject: '你的柠檬记数据刚刚被导出',
    text: `你的柠檬记数据刚刚被导出。\n\n时间：${when}\n设备：${dev}\n地区：${where}\n\n`
      + '不是你本人操作的话，请立刻打开柠檬记，在设置里点“退出其他所有设备”。',
  };
}
