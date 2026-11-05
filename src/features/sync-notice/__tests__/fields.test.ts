// 字段描述（data/fields.ts；K8 冲突提示方案 3.3，H3、L8）：五张表的 clientWritable 列全覆盖、未知列、各格式、格式化抛错
import { describe, expect, it } from 'vitest';
import { allManifests } from '../../../../shared/manifests/index.ts';
import { describeConflict, FIELDS } from '../data/fields.ts';
import { NOTICE_TABLES } from '../data/notice-tables.ts';
import { tSn, type SnKey } from '../hooks/useSnT.ts';
import { syncNoticeZh } from '../i18n/zh.ts';

const zh = (k: string, p: Readonly<Record<string, string | number>>) => tSn(k as SnKey, p as never, 'zh-CN');
const ko = (k: string, p: Readonly<Record<string, string | number>>) => tSn(k as SnKey, p as never, 'ko-KR');
const cols = (table: string): readonly string[] => {
  for (const m of allManifests) for (const t of m.tables) if (t.name === table) return t.clientWritable;
  throw new Error(`no table ${table}`);
};

describe('字段描述', () => {
  it('白名单五张表的每个 clientWritable 列：要么有字段名和格式，要么标 hidden（以后加列漏写会红）', () => {
    for (const table of NOTICE_TABLES) {
      const missing = cols(table).filter((c) => !Object.hasOwn(FIELDS[table], c));
      expect(missing, table).toEqual([]);
      const extra = Object.keys(FIELDS[table]).filter((c) => !cols(table).includes(c));
      expect(extra, `${table} 里多写了清单没有的列`).toEqual([]);
    }
  });

  it('字段名词条都在词典里', () => {
    for (const table of NOTICE_TABLES) {
      for (const s of Object.values(FIELDS[table])) if (s !== 'hidden') expect(Object.hasOwn(syncNoticeZh, s.label), s.label).toBe(true);
    }
  });

  it('各格式：文本、日期、时刻、开关、提醒选项、列表、纪念日的提前天数', () => {
    const lines = describeConflict(
      'todos',
      ['title', 'due', 'due_time', 'important', 'remind_before_min', 'remind_days'],
      { title: '另一台', due: '2026-11-08', due_time: '09:30', important: true, remind_before_min: 120, remind_days: 1 },
      'zh-CN', zh,
    );
    expect(lines).toEqual([
      { field: '标题', value: '另一台' },
      { field: '截止', value: '11月8日 周日' },
      { field: '截止时刻', value: '09:30' },
      { field: '重要', value: '是' },
      { field: '提前提醒', value: '提前 2 小时' },
      { field: '提醒的日子', value: '前一天' },
    ]);
    expect(describeConflict('events', ['remind_min'], { remind_min: null }, 'zh-CN', zh)).toEqual([{ field: '提醒', value: '不提醒' }]);
    expect(describeConflict('notes', ['tags'], { tags: ['工作', '家'] }, 'zh-CN', zh)).toEqual([{ field: '标签', value: '工作、家' }]);
    expect(describeConflict('anniversaries', ['remind_offsets'], { remind_offsets: [0, 7] }, 'zh-CN', zh)).toEqual([
      { field: '提前几天提醒', value: '当天、提前 7 天' },
    ]);
    expect(describeConflict('todos', ['note'], { note: '' }, 'ko-KR', ko)).toEqual([{ field: '메모', value: '(비어 있음)' }]);
  });

  it('长文本原样给（两行加“…”由样式截）；hidden 的列不写', () => {
    const long = '很长'.repeat(200);
    expect(describeConflict('notes', ['body', 'updated_at', 'category_seen'], { body: long }, 'zh-CN', zh)).toEqual([{ field: '正文', value: long }]);
  });

  it('不认识的列合成一行“（已改过）”放最后；只存 id、枚举的列写“（已改过）”；old 里没有这一列也写“（已改过）”', () => {
    expect(describeConflict('todos', ['zzz_new', 'title', 'yyy'], { title: 'a', zzz_new: { x: 1 } }, 'zh-CN', zh)).toEqual([
      { field: '标题', value: 'a' },
      { field: null, value: '（已改过）' },
    ]);
    expect(describeConflict('categories', ['color'], { color: 3 }, 'zh-CN', zh)).toEqual([{ field: '颜色', value: '（已改过）' }]);
    expect(describeConflict('todos', ['note'], {}, 'zh-CN', zh)).toEqual([{ field: '备注', value: '（已改过）' }]);
    expect(describeConflict('todos', ['note'], null, 'zh-CN', zh)).toEqual([{ field: '备注', value: '（已改过）' }]);
  });

  it('格式化抛错（值的类型不对）写“（已改过）”，不露原始 JSON', () => {
    const bad = describeConflict('todos', ['due', 'important', 'remind_days'], { due: { y: 1 }, important: 'yes', remind_days: 5 }, 'zh-CN', zh);
    expect(bad.map((l) => l.value)).toEqual(['（已改过）', '（已改过）', '（已改过）']);
    for (const l of bad) expect(l.value).not.toMatch(/[{}[\]"]/);
  });
});
