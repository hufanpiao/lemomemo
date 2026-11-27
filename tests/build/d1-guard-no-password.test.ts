// D1 S6（B1 接手清单，安全第四轮 L4；代码审查有条件通过 5、7）：auth.users 上的 users_guard_no_password 在、平时触发、
// before insert or update for each row、不是 update of 列、没有 WHEN 条件（0001 原样的除外）、调 private.guard_no_password() 且函数体置空密码。
// 第三轮：函数体规范化后和 0001 整段比较；auth.users 上不准有白名单以外的 before insert / update 触发器。
// 被删、换时机由 supabase/tests/d1-fixtures/25、26 证明（离线 PGlite 跑过；真库要等 ci.yml 的 db 任务，见 25 号样例的说明）；
// “被 disable”真 Supabase 上做不出来（postgres 不是 auth.users 的属主），WHEN、update of、函数体这几支也在这里逐条证明
import { describe, expect, it } from 'vitest';
import { checkAuthUsersTriggers, checkGuardNoPassword } from '../../build/d1/checks.ts';

const BODY_0001 = "\nbegin\n  new.encrypted_password := '';\n  return new;\nend ";
/** 和真库 db reset 后一样：0001 带 WHEN 条件，pg_get_triggerdef 把条件写成带类型转换的样子 */
const DEF_0001 = "CREATE TRIGGER users_guard_no_password BEFORE INSERT OR UPDATE ON auth.users FOR EACH ROW WHEN ((COALESCE(new.encrypted_password, ''::character varying))::text <> ''::text) EXECUTE FUNCTION private.guard_no_password()";
/** 换行（不在源码里写反斜杠转义） */
const NL = String.fromCharCode(10);
const ok = { en: 'O', ty: 1 | 2 | 4 | 16, fs: 'private', f: 'guard_no_password', def: DEF_0001, na: 0, src: BODY_0001 };
const defWhen = (when: string) => `CREATE TRIGGER users_guard_no_password BEFORE INSERT OR UPDATE ON auth.users FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION private.guard_no_password()`;

describe('D1：guard_no_password 触发器（build/d1/checks.ts checkGuardNoPassword）', () => {
  it('和 0001 一样（启用、before insert or update for each row、0001 原样的 WHEN）→ 通过；tgtype、na 是字符串也认；不带 WHEN 也通过', () => {
    expect(checkGuardNoPassword(ok)).toEqual([]);
    expect(checkGuardNoPassword({ ...ok, ty: '23', na: '0' })).toEqual([]);
    expect(checkGuardNoPassword({ ...ok, def: null })).toEqual([]);
    expect(checkGuardNoPassword({ ...ok, def: defWhen("coalesce(new.encrypted_password, '') <> ''") })).toEqual([]);
  });

  it("tgenabled = 'A'（始终触发，含 replica）也算平时触发 → 通过（代码审查有条件通过 7）", () => {
    expect(checkGuardNoPassword({ ...ok, en: 'A' })).toEqual([]);
  });

  it('没有这个触发器 → 报', () => {
    expect(checkGuardNoPassword(undefined)).toEqual([expect.stringContaining('auth.users 上没有触发器 users_guard_no_password')]);
  });

  it("被 disable（D）、只在 replica 下触发（R）→ 报平时不触发，要 'O' 或 'A'", () => {
    for (const en of ['D', 'R']) expect(checkGuardNoPassword({ ...ok, en })).toEqual([expect.stringContaining(`平时不触发（tgenabled = '${en}'`)]);
  });

  it('时机或事件不对（after、只管 insert、多了 delete、for each statement）→ 报', () => {
    for (const ty of [1 | 4 | 16, 1 | 2 | 4, 1 | 2 | 4 | 8 | 16, 2 | 4 | 16]) {
      expect(checkGuardNoPassword({ ...ok, ty })).toEqual([expect.stringContaining('不是 before insert or update for each row')]);
    }
  });

  it('写成 update of 列（tgattr 非空）→ 报（代码审查有条件通过 5）', () => {
    expect(checkGuardNoPassword({ ...ok, na: 1 })).toEqual([expect.stringContaining('update of 列')]);
  });

  it('带了 0001 以外的 WHEN 条件（false、只管 insert、在原条件上加 or / and）→ 报（代码审查有条件通过 5）', () => {
    for (const when of ['false', "new.email = 'x'", "(coalesce(new.encrypted_password, '') <> '') and false", "coalesce(new.encrypted_password, '')::text and false <> ''"]) {
      expect(checkGuardNoPassword({ ...ok, def: defWhen(when) })).toEqual([expect.stringContaining('带了 WHEN 条件')]);
    }
  });

  it('WHEN 规范化保住字符串字面量：把 0001 条件里的空串换成别的字符串 → 报（第三轮低）', () => {
    for (const when of ["coalesce(new.encrypted_password, 'x') <> ''", "coalesce(new.encrypted_password, '') <> 'x'", "coalesce(new.encrypted_password, '') <> ' '"]) {
      expect(checkGuardNoPassword({ ...ok, def: defWhen(when) })).toEqual([expect.stringContaining('带了 WHEN 条件')]);
    }
  });

  it('函数体规范化后和 0001 整段比较（代码审查第三轮必改 3）：if false 包起来、置空写在注释里、先置空再赋回、只 return new、置成别的值 → 报', () => {
    const body = (...lines: string[]) => ['', 'begin', ...lines, 'end '].join(NL);
    const bodies = [
      body("  if false then new.encrypted_password := ''; end if;", '  return new;'),
      body("  -- new.encrypted_password := '';", '  return new;'),
      body("  /* new.encrypted_password := ''; */", '  return new;'),
      body("  new.encrypted_password := '';", '  new.encrypted_password := old.encrypted_password;', '  return new;'),
      body('  return new;'),
      body("  new.encrypted_password := 'x';", '  return new;'),
      body("  new.encrypted_password := '--';", '  return new;'),
    ];
    for (const src of bodies) expect(checkGuardNoPassword({ ...ok, src })).toEqual([expect.stringContaining('函数体和 0001 不一样')]);
  });

  it('函数体只差大小写、空白、注释 → 通过', () => {
    expect(checkGuardNoPassword({ ...ok, src: ['BEGIN -- 置空', " NEW.encrypted_password:=''; /* 说明 */ RETURN NEW; END"].join(NL) })).toEqual([]);
  });

  it('auth.users 上白名单以外的 before insert / update 触发器 → 报；after 触发器、白名单里的不报（第三轮低）', () => {
    expect(checkAuthUsersTriggers([{ name: 'users_guard_no_password', ty: 23 }, { name: 'audit_after', ty: 1 | 4 | 16 }])).toEqual([]);
    expect(checkAuthUsersTriggers([{ name: 'put_back', ty: 1 | 2 | 16 }, { name: 'ins_only', ty: '7' }])).toEqual([
      expect.stringContaining('put_back'),
      expect.stringContaining('ins_only'),
    ]);
  });

  it('调的不是 private.guard_no_password() → 报', () => {
    expect(checkGuardNoPassword({ ...ok, fs: 'public', f: 'guard_no_password' })).toEqual([expect.stringContaining('调的是 public.guard_no_password()')]);
  });
});
