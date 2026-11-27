// 设置页分组的固定顺序
// 顺序只看这张表，不看各分组登记或渲染的先后：后面各批加分组时只往表里对应位置填 id，不在页面里调换位置。
// “退出登录”不是分组，不在表里：页面最底下单独一行，永远在所有分组之后
export const SETTINGS_SECTION_ORDER = [
  /** 账号：已登录设备、退出其他所有设备、最近的导出、注销入口 */
  'account',
  'language',
  /** 皮肤（减少透明、减少动态不设开关，只跟系统设置） */
  'skin',
  /** 吉祥物：今天页黄卡上的那一个（features/mascot） */
  'mascot',
  'font',
  /** 随手记显示方式 */
  'notesView',
  /** 声音和触感：操作音效和震动的开关（默认开） */
  'fx',
  /** 待办：完成 7 天后自动删除 */
  'todos',
  'calendar',
  /** 提醒与通知 */
  'reminders',
  /** 语音与 AI */
  'voiceAi',
  /** 我的 AI（人人都有）：用柠檬记提供的 AI 还是自己的密钥；值和二级页正文由 ai-provider 功能懒加载 */
  'myAi',
  'vault',
  'timezone',
  /** 天气：今天页天气胶囊看哪儿（自动定位 / 手动城市 / 不看天气）；值和二级页正文由 weather 功能懒加载 */
  'weather',
  /** 最近删除：待办、随手记两行，各带条数，点进 #/trash/todos、#/trash/notes */
  'trash',
  /** 数据：“导出全部” */
  'data',
  /** 在 Claude 聊天里记事 */
  'claude',
  /** AI 服务商（只在管理员账号出现：ai-provider 函数 mine 回 admin: true）：整行由 ai-provider 功能懒加载 */
  'aiProvider',
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
 * 设置首页的卡：每个分组只在一张卡里，卡里照 SETTINGS_SECTION_ORDER 的先后排。
 * 账号单独一张；main 是界面语言到时区；more 是数据到关于。“退出登录”不在卡里，在所有卡之后。
 * main、more 中间是“最近删除”（卡名看得见：两行只写“待办”“随手记”，要有组名才看得懂）
 */
export const SETTINGS_CARDS = [
  { id: 'account', ids: ['account'] },
  { id: 'main', ids: ['language', 'skin', 'mascot', 'font', 'notesView', 'fx', 'todos', 'calendar', 'reminders', 'voiceAi', 'myAi', 'vault', 'timezone', 'weather'] },
  { id: 'trash', ids: ['trash'] },
  { id: 'more', ids: ['data', 'claude', 'aiProvider', 'invite', 'desktop', 'glossary', 'about'] },
] as const satisfies ReadonlyArray<{ id: string; ids: readonly SettingsSectionId[] }>;

export type SettingsCardId = (typeof SETTINGS_CARDS)[number]['id'];

/**
 * 网页版宽屏的左目录（左目录右详情）：七组，点哪组右边只出这一组的行。
 * 只把手机版首页现有的分组归进来，不加新设置项；组里的先后仍照 SETTINGS_SECTION_ORDER。“电脑”组只有 exe 里才有 desktop 一行，没有就不出这一组
 */
export const SETTINGS_DESK_GROUPS = [
  { id: 'account', ids: ['account'] },
  { id: 'look', ids: ['language', 'skin', 'mascot', 'font', 'notesView'] },
  { id: 'cal', ids: ['fx', 'todos', 'calendar', 'reminders', 'timezone', 'weather'] },
  { id: 'ai', ids: ['voiceAi', 'myAi', 'claude', 'aiProvider'] },
  { id: 'data', ids: ['vault', 'trash', 'data', 'invite'] },
  { id: 'desktop', ids: ['desktop'] },
  { id: 'about', ids: ['glossary', 'about'] },
] as const satisfies ReadonlyArray<{ id: string; ids: readonly SettingsSectionId[] }>;

export type SettingsDeskGroupId = (typeof SETTINGS_DESK_GROUPS)[number]['id'];

/** 这个分组在宽屏左目录的哪一组 */
export function deskGroupOf(id: SettingsSectionId): SettingsDeskGroupId {
  return SETTINGS_DESK_GROUPS.find((g) => (g.ids as readonly SettingsSectionId[]).includes(id))?.id ?? 'about';
}

/** 一组里已有的分组（照固定顺序） */
export function deskRowsOf<T>(present: Partial<Record<SettingsSectionId, T>>, group: SettingsDeskGroupId): Array<[SettingsSectionId, T]> {
  return orderSections(present).filter(([id]) => deskGroupOf(id) === group);
}

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
