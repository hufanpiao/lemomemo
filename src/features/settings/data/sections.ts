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
