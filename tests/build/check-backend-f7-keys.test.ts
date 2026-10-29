// build/check_backend.py：F7 用类型检查器判键类型（断言、枚举、Reflect、number 键）、this、全局事件与简写属性、
// 白名单绑节点位置、本地 import 的编码与越界；F2 用绝对路径、file: 地址引 db.ts
// 从 check-backend.test.ts 按主题拆出（10-30，W1 超行），用例原样不变
// 每个样例是一棵迷你仓库（tests/arch-fixtures/check_backend/<名字>/），用 --root 指过去；共用的 run、sample、where 在 check-backend-harness.ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../arch/fixture-header.ts';
import { run, sample, SLOW_TIMEOUT, where } from './check-backend-harness.ts';

describe('build/check_backend.py（tests/arch-fixtures/check_backend）', () => {
  it('F7（代码审查第五轮，剩余风险①选项乙）：用类型检查器判键类型——方括号、解构计算键的类型是 string（拼出来的、string 变量）→ 错误；number 键、字面量联合键、字面量键不报', () => {
    const { code, errors } = run(sample('f7-key-type'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([4, 6, 9].map((n) => `F7 supabase/functions/push-dispatch/index.ts:${n}`));
    expect(errors.some((e) => e.file.includes('todo-remind'))).toBe(false);
    expect(errors.find((e) => e.line === 4)?.message).toContain('string');
    expect(errors.find((e) => e.line === 9)?.message).toContain('解构的计算键');
  });

  it('F7（代码审查第六轮必改 1）：断言出来的键类型——x as \'length\'、<\'name\'>x、as unknown as number、赋值里藏断言、字面量类型的参数都报；字面量常量、条件表达式、for…of 字面量数组、断言包着的字面量、for 下标和 .length 算术不报', () => {
    const { code, errors } = run(sample('f7-key-assert'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([3, 5, 7, 9, 10].map((n) => `F7 supabase/functions/push-dispatch/index.ts:${n}`).sort());
    const msg = (line: number) => errors.find((e) => e.line === line)?.message ?? '';
    expect(msg(3)).toContain('追不到字面量');
    // 第七轮起 number 键只放行字面量、for 下标、.length 算术，断言出来的数字落在这条
    expect(msg(5)).toContain('键的类型是 number');
    expect(msg(7)).toContain('键的类型是 number');
    expect(msg(10)).toContain('追不到字面量');
  });

  it('F7（代码审查第六轮必改 2）：枚举成员当键（字符串枚举、数字枚举）一律报；const 字面量常量不报', () => {
    const { code, errors } = run(sample('f7-key-enum'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([3, 5].map((n) => `F7 supabase/functions/push-dispatch/index.ts:${n}`));
    expect(errors.every((e) => e.message.includes('枚举'))).toBe(true);
  });

  it('F7（代码审查第六轮必改 3）：Reflect.get / has、Object.getOwnPropertyDescriptor 的键走同一条规则；getOwnPropertyDescriptors 禁用；Reflect 存变量、解构，方法存变量，apply / construct 的动态函数，globalThis.Reflect，…展开都报；字面量键、静态函数、Object.keys、类型位置不报', () => {
    const { code, errors } = run(sample('f7-key-reflect'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14].map((n) => `F7 supabase/functions/push-dispatch/index.ts:${n}`).sort());
    const msg = (line: number) => errors.find((e) => e.line === line)?.message ?? '';
    expect(msg(3)).toContain('Reflect.get 的键参数');
    expect(msg(6)).toContain('getOwnPropertyDescriptors');
    expect(msg(7)).toContain('Reflect 只准直接调用');
    expect(msg(11)).toContain('Reflect.apply');
    expect(msg(13)).toContain('Reflect.get 的键参数');
  });

  it('F7（代码审查第六轮必改 4 → 第七轮必改 3）：白名单不再按声明文本放行——第六轮能放行的同文本、同声明写法，第七轮按节点位置对不上，照报', () => {
    const { code, errors } = run(sample('f7-key-whitelist'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([
      ...[2, 3, 5, 6, 7, 9].map((n) => `F7 supabase/functions/account/core.ts:${n}`),
      'F7 supabase/functions/todo-remind/index.ts:3',
    ].sort());
  });

  it('F7（代码审查第七轮必改 1）：普通函数、对象字面量方法里的 this 报；Object.values / keys / entries / assign 的参数是 any / unknown 报；类里的 this、模块顶层 this、参数类型具体的不报', () => {
    const { code, errors } = run(sample('f7-this-enum'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([2, 3, 4, 7, 8, 9, 10].map((n) => `F7 supabase/functions/push-dispatch/index.ts:${n}`).sort());
    const msg = (line: number) => errors.find((e) => e.line === line)?.message ?? '';
    expect(msg(2)).toContain('this');
    expect(msg(4)).toContain('对象字面量的方法');
    expect(msg(7)).toContain('Object.values');
    expect(msg(10)).toContain('Object.assign');
  });

  it('F7（代码审查第七轮必改 2）：number 键只放行数字字面量、const 数字常量、for 循环下标、.length 的算术；JSON.parse、参数、调用返回值、let 变量都报', () => {
    const { code, errors } = run(sample('f7-key-number'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([4, 5, 7, 9, 10].map((n) => `F7 supabase/functions/push-dispatch/index.ts:${n}`).sort());
    expect(errors.every((e) => e.message.includes('键的类型是 number'))).toBe(true);
  });

  it('F7（代码审查第七轮必改 3）：白名单绑节点位置——和真仓库登记处同文本、同参数声明但位置不同的照报；Object.hasOwn 守卫写对（同一对象、同一个键、对象不是 any、取值在条件成立那一支）才放行', () => {
    const { code, errors } = run(sample('f7-key-hasown'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([2, 3, 4, 5, 6].map((n) => `F7 supabase/functions/account/core.ts:${n}`));
    expect(errors.some((e) => e.file.includes('todo-remind'))).toBe(false);
  });

  it('F7（代码审查第八轮必改 ①）：不带对象前缀的 addEventListener / dispatchEvent / removeEventListener、globalThis / self 上的都报；具体对象上的、类里同名方法声明不报', () => {
    const { code, errors } = run(sample('f7-event-global'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([2, 3, 4, 5, 6, 7].map((n) => `F7 supabase/functions/push-dispatch/index.ts:${n}`));
    expect(errors.find((e) => e.line === 2)?.message).toContain('全局的 addEventListener');
    expect(errors.find((e) => e.line === 6)?.message).toContain('全局的 dispatchEvent');
  });

  it('F7（代码审查第八轮低）：全局事件属性 onunhandledrejection、onerror、onload、onbeforeunload、onunload——不带前缀、globalThis / self 上的赋值和读取都报；具体对象上的、同名局部变量 / 参数 / 对象属性不报', () => {
    const { code, errors } = run(sample('f7-event-props'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([2, 3, 4, 5, 6, 7, 8, 9].map((n) => `F7 supabase/functions/push-dispatch/index.ts:${n}`));
    expect(errors.every((e) => e.message.includes('全局事件属性'))).toBe(true);
  });

  it('F7（审查员第九轮低 1）：简写属性 { onunhandledrejection }、{ addEventListener }、{ Reflect } 把全局的东西当值带走，照报；同名的本地变量、参数不报', () => {
    const { code, errors } = run(sample('f7-shorthand'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([2, 3, 4, 5].map((n) => `F7 supabase/functions/push-dispatch/index.ts:${n}`));
  });

  it('F7（代码审查第十轮）：本地 import 有百分号编码、查询串或锚点报 F7，解码 / 去掉后照样查 F2、F3（第十二轮）；解析后落在 supabase/functions 外面的本地 import 报 F7；没有百分号、落在里面的不报', () => {
    const { code, errors } = run(sample('f7-import-local'));
    expect(code).toBe(1);
    const f = 'supabase/functions/push-dispatch/index.ts';
    expect(where(errors)).toEqual([
      `F2 ${f}:2`, `F7 ${f}:2`, `F2 ${f}:3`, `F7 ${f}:3`, `F3 ${f}:4`, `F7 ${f}:4`, `F7 ${f}:5`, `F7 ${f}:6`,
      `F2 ${f}:7`, `F7 ${f}:7`, `F3 ${f}:8`, `F7 ${f}:8`,
    ].sort());
    const f7 = (line: number) => errors.find((e) => e.rule === 'F7' && e.line === line)?.message ?? '';
    expect(f7(2)).toContain('百分号');
    expect(f7(5)).toContain('supabase/functions 外面');
    expect(f7(6)).toContain('supabase/functions 外面');
    expect(f7(7)).toContain('查询串或锚点');
    expect(f7(8)).toContain('查询串或锚点');
  });

  it('F2（B1 接手清单 C10）：不在名单里的函数用绝对路径、盘符路径、file: 地址、指到绝对路径的 import map 别名引 db.ts → 错误；名单里的函数、引别的共用模块不报', () => {
    const { code, errors } = run(sample('f2-abs-path'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([2, 3, 4, 5].map((n) => `F2 supabase/functions/push-dispatch/index.ts:${n}`));
    expect(errors.every((e) => e.message.includes('_shared/db.ts'))).toBe(true);
  });

  it('F7（代码审查第八轮必改 ②）：Object.values / entries / assign 的参数、对象展开 { ...x } 的类型是 EventTarget、{}、object 报；类型具体的、对象字面量、条件展开字面量不报', () => {
    const { code, errors } = run(sample('f7-spread-vague'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([5, 6, 7, 8, 9].map((n) => `F7 supabase/functions/push-dispatch/index.ts:${n}`));
    expect(errors.find((e) => e.line === 8)?.message).toContain('对象展开');
  });

  it('F7（代码审查第八轮，白名单改稳）：登记处前面加代码不误报；把同样的签名和取值复制进别的函数名，对不上照报', () => {
    // 用真仓库的 _shared/db.ts（URL_ENV[role] 登记在白名单里，绑的是 connect 函数和它的 role 参数）
    const src = readFileSync(join(ROOT, 'supabase', 'functions', '_shared', 'db.ts'), 'utf8');
    const keyErrors = (content: string) => {
      const dir = mkdtempSync(join(tmpdir(), 'check-backend-wl-'));
      try {
        mkdirSync(join(dir, 'supabase', 'functions', '_shared'), { recursive: true });
        writeFileSync(join(dir, 'supabase', 'functions', '_shared', 'db.ts'), content);
        return run(dir).errors.filter((e) => e.file.endsWith('_shared/db.ts') && e.message.includes('方括号里的属性名'));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    expect(src).toContain('function connect(role: FnRole)');
    expect(keyErrors(src)).toEqual([]);
    // 文件开头、connect 函数体开头都加几行代码：位置按“函数链 + 第几处”算，不受影响
    const padded = 'export const padA = 1;\n' + src.replace('function connect(role: FnRole) {', 'function connect(role: FnRole) {\n  const padB = 2; void padB;');
    expect(keyErrors(padded)).toEqual([]);
    // 换个函数名：函数链对不上，两处 URL_ENV[role] 都报
    expect(keyErrors(src.replace(/\bconnect\b/g, 'connect2')).length).toBe(2);
  }, SLOW_TIMEOUT);   // 一条里连跑 3 次 python（每次都建 TypeScript 类型检查器），见 SLOW_TIMEOUT

  it('F7（代码审查第六轮低 5）：类型检查器建不起来时每个 F7 文件报一条；取键类型抛异常时报错，都不放行', () => {
    const p = run(sample('f7-key-assert'), [], { CHECK_BACKEND_FAIL_PROGRAM: '1' });
    expect(p.code).toBe(1);
    expect(where(p.errors)).toEqual(['push-dispatch', 'todo-remind'].map((f) => `F7 supabase/functions/${f}/index.ts:1`));
    expect(p.errors.every((e) => e.message.includes('类型检查器建不起来'))).toBe(true);
    const t = run(sample('f7-key-assert'), [], { CHECK_BACKEND_FAIL_TYPE: '1' });
    expect(t.code).toBe(1);
    // 对照组（todo-remind）平时 0 错误，取类型出错时它的非字面量键也全报
    expect(t.errors.filter((e) => e.file.includes('todo-remind')).length).toBeGreaterThan(0);
    expect(t.errors.every((e) => e.message.includes('取键的类型时出错'))).toBe(true);
  });
});
