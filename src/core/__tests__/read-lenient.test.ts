// 宽容读取的纯函数（架构 0.27 第 1 点）：TC-B1-34、35、38、39 的读取一半；有 vaultRows 的表（TC-B1-36、37、R-229）见 read-vault.test.ts
// 落库一半（本机缓存、待补拉、日志、只读拦截）见 read-ingest.test.ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readColOf, readColsOf, requiredColsOf, RO_IF_PRESENT, UNKNOWN, type ReadCol } from '../../../shared/schema/rows-read.ts';
import { rowsWrite } from '../../../shared/schema/rows.ts';
import { todos as todosManifest } from '../../../shared/manifests/todos.ts';
import { syncTables } from '../manifest.ts';
import {
  createParseRows, LOG_MAX_COLL, LOG_MAX_FIELDS, LOG_MAX_FIELDS_LEN, logFields, parseVaultFlag, readEnum, readRow, readRows,
  tableReader, type RowOutcome, type TableReader,
} from '../read/lenient.ts';
import { serverEvent, serverNote, serverTodo, SECRET } from './read-fixtures.ts';
import { uid } from './outbox-fixtures.ts';

const reader = (t: string): TableReader => {
  const r = tableReader(t);
  if (typeof r === 'string') throw new Error(`${t}:${r}`);
  return r;
};

/** 先断言 kind，再收窄 */
function plainSchema(rc: ReadCol): z.ZodType {
  expect(rc.kind).toBe('plain');
  if (rc.kind !== 'plain') throw new Error('not_plain');
  return rc.schema;
}
/** 先断言读成功，再收窄 */
function okOf(o: RowOutcome): Extract<RowOutcome, { ok: true }> {
  expect(o.ok).toBe(true);
  if (!o.ok) throw new Error(`dropped:${o.code}:${o.cols.join(',')}`);
  return o;
}
describe('rows-read：严格版放宽成读用的列', () => {
  it('uuid、正则、长度、int 去掉，只留基本类型；enum、literal、literal 的 union 认成枚举', () => {
    expect(plainSchema(readColOf(z.uuid())).safeParse('不是 uuid').success).toBe(true);
    expect(readColOf(z.enum(['a', 'b']))).toEqual({ kind: 'enum', values: ['a', 'b'], nullable: false });
    expect(readColOf(z.union([z.literal(0), z.literal(1)]).nullable())).toEqual({ kind: 'enum', values: [0, 1], nullable: true });
    const n = plainSchema(readColOf(z.number().int().min(1).max(5).nullable()));
    expect(n.safeParse(99.5).success).toBe(true);
    expect(n.safeParse(null).success).toBe(true);
    expect(n.safeParse('1').success).toBe(false);
  });

  it('rows.ts 每张表的每一列都能放宽，也都算必须有的列（加了不认识的 zod 类型会在这里失败）', () => {
    for (const [table, s] of Object.entries(rowsWrite)) {
      const cols = readColsOf(table);
      const req = requiredColsOf(table);
      for (const c of Object.keys(s.shape)) {
        if (c === 'id') continue;
        expect(cols.has(c), `${table}.${c}`).toBe(true);
        expect(req, `${table}.${c}`).toContain(c);
      }
    }
    expect(requiredColsOf('notes')).toEqual(['rev', 'user_id', 'deleted_at', 'synced_at', 'undone']);
  });

  it('列名、表名查的是自有属性：constructor、__proto__ 查不到', () => {
    const cols = readColsOf('todos');
    for (const c of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__']) expect(cols.get(c)).toBeUndefined();
    expect(readColsOf('constructor').has('rev')).toBe(true);   // 只有公共列，不会取到原型
    expect(requiredColsOf('toString')).toEqual(['rev', 'user_id', 'deleted_at', 'synced_at', 'undone']);
  });

  it('不支持的类型直接抛错', () => {
    expect(() => readColOf(z.array(z.string()))).toThrow('rows_read_unsupported:array');
  });

  it('每张同步表都建得出读取规则，vaultRows.flag 都解析得了', () => {
    for (const t of syncTables()) {
      const r = reader(t.name);
      if (t.vaultRows) expect(r.vault?.flag.col, t.name).toBeTruthy();
    }
    expect(RO_IF_PRESENT['todos']).toContain('repeat');
  });
});

describe('vaultRows.flag 的两种写法', () => {
  it('布尔列：true 隐私记、false 普通、其他判断不了', () => {
    const f = parseVaultFlag('is_private', new Map());
    expect(f.col).toBe('is_private');
    expect([true, false, null, undefined, 'true', 1].map((v) => f.test(v))).toEqual(['vault', 'plain', 'unsure', 'unsure', 'unsure', 'unsure']);
  });
  it('等式：等于目标是隐私记；是登记过的其他枚举值才算普通；其他（含 unknown）判断不了', () => {
    const f = parseVaultFlag("bucket = 'vault-images'", readColsOf('note_images'));
    expect(f.col).toBe('bucket');
    expect(['vault-images', 'images', 'vault-images-v2', UNKNOWN, null, undefined].map((v) => f.test(v)))
      .toEqual(['vault', 'plain', 'unsure', 'unsure', 'unsure', 'unsure']);
  });
  it('别的写法抛错', () => {
    expect(() => parseVaultFlag('is_private or is_vault', new Map())).toThrow('vault_flag_unsupported');
  });
});

describe('普通行', () => {
  it('TC-B1-34：不认识的枚举值换成 unknown、这一行只读；其他行照常；整批不拒收', () => {
    const b = readRows('todos', [serverTodo(1), serverTodo(2, { source: 'watch' }), serverTodo(3, { remind_before_min: 45 })]);
    expect(b.rows.map((r) => r.row.id)).toEqual([uid(1), uid(2), uid(3)]);
    expect(b.dropped).toEqual([]);
    expect(b.rows[0]?.ro).toBeUndefined();
    expect(b.rows[1]).toMatchObject({ ro: true, row: { source: UNKNOWN } });
    expect(b.rows[2]).toMatchObject({ ro: true, row: { remind_before_min: UNKNOWN } });
    expect(b.readonlyIds).toEqual([uid(2), uid(3)]);
  });

  it('枚举列读到基本类型都不对的值：也换成 unknown、只读，不丢整行（rows-read.ts 头注释：有意如此）', () => {
    const o = okOf(readRow(reader('todos'), serverTodo(1, { remind_days: { v: 1 } })));
    expect(o.input.row['remind_days']).toBe(UNKNOWN);
    expect(o.input.ro).toBe(true);
  });

  it('TC-B1-35（读取一半）：不认识的列原样留着，不只读', () => {
    const o = okOf(readRow(reader('todos'), serverTodo(1, { qa_new: { x: 1 } })));
    expect(o.input.row['qa_new']).toEqual({ x: 1 });
    expect(o.input.ro).toBeUndefined();
    expect(o.unknownCols).toEqual(['qa_new']);
  });

  it('写入约束读的时候不查：标题超长、时刻格式变了照样收', () => {
    const o = okOf(readRow(reader('todos'), serverTodo(1, { title: 'x'.repeat(500), remind_time: '9:00' })));
    expect(o.input.ro).toBeUndefined();
  });

  it('可空的枚举读到 null 是正常值；不可空的枚举读到 null 换成 unknown', () => {
    const o = okOf(readRow(reader('events'), serverEvent(1, { remind_min: null, source: null })));
    expect(o.input.row['remind_min']).toBeNull();
    expect(o.input.row['source']).toBe(UNKNOWN);
    expect(o.input.ro).toBe(true);
  });

  it('4.1.0 的重复事项：repeat 不为空的日程和待办只读；为空不算', () => {
    const b = readRows('events', [serverEvent(1, { repeat: { freq: 'weekly' } }), serverEvent(2, { repeat: null })]);
    expect(b.readonlyIds).toEqual([uid(1)]);
    expect(b.rows[0]?.row['repeat']).toEqual({ freq: 'weekly' });
  });

  it('TC-B1-38（读取一半）：认识的列基本类型不对、没有 id、不是对象的行只丢这一行，日志只有表名、列名', () => {
    const b = readRows('todos', [serverTodo(1), serverTodo(2, { title: 42, done: 'yes' }), { title: SECRET }, 'x', serverTodo(3)]);
    expect(b.rows.map((r) => r.row.id)).toEqual([uid(1), uid(3)]);
    expect(b.dropped).toEqual([
      { id: uid(2), code: 'bad_type', cols: ['title', 'done'] },
      { id: null, code: 'no_id', cols: ['id'] },
      { id: null, code: 'not_object', cols: [] },
    ]);
    expect(b.logs[0]).toEqual({ act: 'row_unknown', coll: 'todos', item_id: uid(2), fields: ['title', 'done'], code: 'bad_type' });
    expect(JSON.stringify(b.logs)).not.toContain(SECRET);
    expect(JSON.stringify(b.logs)).not.toContain('42');
  });

  it('id 必须是 uuid 形状：别的字符串按 no_id，item_id 记 null、不进待补拉', () => {
    const b = readRows('todos', [serverTodo(1, { id: 'abc' }), serverTodo(2, { id: `${uid(2)}' or 1=1` }), serverTodo(3, { id: 7 })]);
    expect(b.rows).toEqual([]);
    expect(b.dropped.map((d) => [d.id, d.code])).toEqual([[null, 'no_id'], [null, 'no_id'], [null, 'no_id']]);
    expect(b.logs.every((l) => l.item_id === null)).toBe(true);
    expect(createParseRows()('todos', [serverTodo(1, { id: 'abc' })]).bad).toEqual([]);
  });

  it('必须有的列缺了（公共列、严格版的列）：整行丢掉，code = missing；可空列给 null 不算缺', () => {
    const noRev = serverTodo(1);
    delete noRev['rev'];
    const noDue = serverTodo(2);
    delete noDue['due'];
    delete noDue['synced_at'];
    const b = readRows('todos', [{ id: uid(3), title: '残缺行' }, noRev, noDue, serverTodo(4, { deleted_at: null })]);
    expect(b.rows.map((r) => r.row.id)).toEqual([uid(4)]);
    expect(b.dropped[0]).toMatchObject({ id: uid(3), code: 'missing' });
    expect(b.dropped[0]?.cols).toEqual(expect.arrayContaining(['rev', 'user_id', 'deleted_at', 'synced_at', 'undone', 'done']));
    expect(b.dropped[1]).toEqual({ id: uid(1), code: 'missing', cols: ['rev'] });
    expect(b.dropped[2]).toEqual({ id: uid(2), code: 'missing', cols: ['synced_at', 'due'] });
  });

  it('列名是 constructor、toString、hasOwnProperty、valueOf、__proto__ 的行：好行照收，这几列丢掉（Object.prototype 上的名字），不改原型', () => {
    const tricky = ['constructor', 'toString', 'hasOwnProperty', 'valueOf'].map((c, i) => serverTodo(10 + i, { [c]: 'x' }));
    const proto = JSON.parse(JSON.stringify(serverTodo(20)).replace('{', '{"__proto__":{"polluted":1},')) as unknown;
    const b = readRows('todos', [serverTodo(1), ...tricky, proto, serverTodo(2)]);
    expect(b.dropped).toEqual([]);
    expect(b.rows.map((r) => r.row.id)).toEqual([uid(1), uid(10), uid(11), uid(12), uid(13), uid(20), uid(2)]);
    for (const [i, c] of ['constructor', 'toString', 'hasOwnProperty', 'valueOf'].entries()) {
      const r = b.rows[1 + i]?.row as Record<string, unknown>;
      expect(Object.hasOwn(r, c), c).toBe(false);
    }
    expect(okOf(readRow(reader('todos'), serverTodo(30, { toString: 'x', isPrototypeOf: 1 }))).unknownCols).toEqual(['toString', 'isPrototypeOf']);
    const p = b.rows[5]?.row as Record<string, unknown>;
    expect(Object.getPrototypeOf(p)).toBe(Object.prototype);
    expect(Object.hasOwn(p, '__proto__')).toBe(false);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(b.rows.every((r) => r.ro === undefined)).toBe(true);
  });

  it('不是本机同步表（更新的版本加的表）：整批跳过、一条 table_unknown 日志，不抛错', () => {
    const b = readRows('habits', [{ id: uid(1) }]);
    expect(b.rows).toEqual([]);
    expect(b.logs).toEqual([{ act: 'row_unknown', coll: 'habits', item_id: null, fields: [], code: 'table_unknown' }]);
    expect(readRows('habits', []).logs).toEqual([]);
  });

  it('本机缓存不是明文缓存的同步表（localCache 不是 plain）：失败就关上，整批不收，一条 cache_not_plain 日志', () => {
    const t = todosManifest.tables[0];
    if (!t) throw new Error('todos');
    const m = [{ ...todosManifest, tables: [{ ...t, localCache: 'cipher-only' as const }] }];
    expect(tableReader('todos', m)).toBe('cache_not_plain');
    const b = readRows('todos', [serverTodo(1)], m);
    expect(b.rows).toEqual([]);
    expect(b.logs.map((l) => l.code)).toEqual(['cache_not_plain']);
  });

  it('日志的长度上限：fields ≤ 20 个、连起来 ≤ 640；coll ≤ 32', () => {
    const many = Array.from({ length: 30 }, (_, i) => `c${i}`);
    expect(logFields(many)).toHaveLength(LOG_MAX_FIELDS);
    const long = Array.from({ length: 10 }, (_, i) => `${'x'.repeat(100)}${i}`);
    const f = logFields(long);
    expect(f.join(',').length).toBeLessThanOrEqual(LOG_MAX_FIELDS_LEN);
    expect(f).toHaveLength(6);
    expect(readRows('x'.repeat(50), [{}]).logs[0]?.coll).toHaveLength(LOG_MAX_COLL);
  });
});

describe('createParseRows：给 K8 的 parseRows', () => {
  it('rows 交给 applyServer，bad 只放有 uuid 的坏行；每丢一行调一次 log，不带内容', () => {
    const logs: unknown[] = [];
    const parse = createParseRows({ log: (e) => logs.push(e) });
    const p = parse('todos', [serverTodo(1), serverTodo(2, { title: SECRET.length }), { title: SECRET }]);
    expect(p.rows.map((r) => r.row.id)).toEqual([uid(1)]);
    expect(p.bad).toEqual([uid(2)]);
    expect(logs).toHaveLength(2);
    expect(JSON.stringify(logs)).not.toContain(SECRET);
    expect(createParseRows()('notes', [serverNote(3, true, { qa_plain: SECRET })]).rows[0]?.row['qa_plain']).toBeUndefined();
  });
});

describe('readEnum：单个枚举值（记录类型等）', () => {
  it('认识的原样返回，不认识的返回 unknown，不抛错', () => {
    const kinds = ['event', 'todo', 'note'] as const;
    expect(readEnum(kinds, 'todo')).toBe('todo');
    expect(readEnum(kinds, 'habit')).toBe(UNKNOWN);
    expect(readEnum(kinds, undefined)).toBe(UNKNOWN);
  });
});
