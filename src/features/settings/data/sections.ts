// 设置页分组的固定顺序（R-256 ①；TC-B1-71；定稿线框 s13 第 996～998 行）
// 顺序只看这张表，不看各分组登记或渲染的先后：后面各批加分组时只往表里对应位置填 id，不在页面里调换位置。
// “退出登录”不是分组，不在表里：页面最底下单独一行，永远在所有分组之后
export const SETTINGS_SECTION_ORDER = [
  /** 账号：已登录设备、退出其他所有设备、最近的导出（下一批）、注销入口 */
  'account',
  'language',
  /** 皮肤（含减少透明效果、减少动态效果） */
  'skin',
  'font',
  /** 随手记显示方式 */
  'notesView',
  'calendar',
  /** 提醒与通知 */
  'reminders',
  /** 语音与 AI */
  'voiceAi',
  'vault',
  'timezone',
  /** 数据（B1 只有“导出全部”一行） */
  'data',
  /** 在 Claude 聊天里记事 */
  'claude',
  /** 邀请朋友（只在管理员账号出现） */
  'invite',
  /** 电脑（只在电脑和 exe 显示） */
  'desktop',
  /** 符号说明 */
  'glossary',
  'about',
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTION_ORDER)[number];

/** 按固定顺序排出已有的分组（没给的跳过） */
export function orderSections<T>(present: Partial<Record<SettingsSectionId, T>>): Array<[SettingsSectionId, T]> {
  const out: Array<[SettingsSectionId, T]> = [];
  for (const id of SETTINGS_SECTION_ORDER) {
    const v = present[id];
    if (v !== undefined) out.push([id, v]);
  }
  return out;
}

/**
 * 设置首页的三张卡（R-325 按定稿线框 s13 合卡；SETTINGS-merge-cards 方案第 2 节）：每个分组只在一张卡里，卡里照 SETTINGS_SECTION_ORDER 的先后排。
 * 卡 1 账号单独一张；卡 2 是界面语言到时区；卡 3 是数据到关于。“退出登录”不在卡里，在所有卡之后
 */
export const SETTINGS_CARDS = [
  { id: 'account', ids: ['account'] },
  { id: 'main', ids: ['language', 'skin', 'font', 'notesView', 'calendar', 'reminders', 'voiceAi', 'vault', 'timezone'] },
  { id: 'more', ids: ['data', 'claude', 'invite', 'desktop', 'glossary', 'about'] },
] as const satisfies ReadonlyArray<{ id: string; ids: readonly SettingsSectionId[] }>;

export type SettingsCardId = (typeof SETTINGS_CARDS)[number]['id'];

/** 按卡分好、卡里按固定顺序排的分组；一张卡里一个都没有就不出这张卡 */
export function cardsOf<T>(present: Partial<Record<SettingsSectionId, T>>): Array<[SettingsCardId, Array<[SettingsSectionId, T]>]> {
  const ordered = orderSections(present);
  const out: Array<[SettingsCardId, Array<[SettingsSectionId, T]>]> = [];
  for (const card of SETTINGS_CARDS) {
    const ids: readonly SettingsSectionId[] = card.ids;
    const rows = ordered.filter(([id]) => ids.includes(id));
    if (rows.length > 0) out.push([card.id, rows]);
  }
  return out;
}
