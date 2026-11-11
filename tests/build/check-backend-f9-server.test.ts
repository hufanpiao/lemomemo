// build/check_backend.py F9 ③ 的服务器密钥名单（B2 安全审查 D2-1～D2-4、D2-S1）和 F10（1.5 第 ② 点 D1-8：host.docker.internal 只准出现在替身判断模块和 tests/）。
// B3 起另有 F9 ⑥ 按连接码哈希查表的名单（B3 任务单 M2），样例 f9-hashed-token、f9-hashed-token-ok。
// 样例在 tests/arch-fixtures/check_backend/f9-server-secret、f9-server-secret-cfg、f10-fn-tests-dir、f10-fn-tests-dir-ok、f10-fn-test-import、f10-fn-test-import-ok；这份由后端写（测试开发的 F9 用例在 check-backend-migrations.test.ts，不动）
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../arch/fixture-header.ts';
import { run, sample, where } from './check-backend-harness.ts';

const PY = readFileSync(join(ROOT, 'build', 'check_backend.py'), 'utf8');

describe('D2-1：SERVER_SECRET_FUNCTIONS 写死、完整内容钉住', () => {
  it('名单正好是 {usage-report: x-ops-secret}，密钥变量正好是 {usage-report: OPS_SECRET}（往名单加函数要改这条单测，过代码审查和安全审查）', () => {
    expect(PY.match(/^SERVER_SECRET_FUNCTIONS = .*$/gm)).toEqual(['SERVER_SECRET_FUNCTIONS = {"usage-report": "x-ops-secret"}']);
    expect(PY.match(/^SERVER_SECRET_ENVS = .*$/gm)).toEqual(['SERVER_SECRET_ENVS = {"usage-report": "OPS_SECRET"}']);
    // 不从环境变量或配置文件读
    expect(/SERVER_SECRET_FUNCTIONS\s*(?:\[|\.update|\|=|=(?! \{"usage-report))/.test(PY.replace(/^SERVER_SECRET_FUNCTIONS = .*$/m, ''))).toBe(false);
  });
});

describe('D2-3：三个违规样例', () => {
  it('① 名单外、不是 cron 调的函数关了 verify_jwt；② 名单里的函数用 !== 比、没调 safeEqual；③ 用户调的 account 关了 verify_jwt', () => {
    const { code, errors } = run(sample('f9-server-secret'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([
      'F9 supabase/config.toml:13', // ③ account
      'F9 supabase/config.toml:9', // ① ops-extra（自己用 safeEqual 验了 x-ops-secret 也不行，不在名单里）
      'F9 supabase/functions/usage-report/index.ts:3', // ②
    ]);
    const msg = errors.find((e) => e.file.endsWith('usage-report/index.ts'))?.message ?? '';
    expect(msg).toContain('没有对 x-ops-secret 调 safeEqual(');
    expect(msg).toContain('用 !== 比较');
    expect(errors.find((e) => e.line === 9)?.message).toContain('不在 SERVER_SECRET_FUNCTIONS、HASHED_TOKEN_FUNCTIONS 里');   // B3 加了 ⑥ 的名单
    // 判空（got === ''）不算比较密钥
    expect(msg).not.toContain('用 === 比较');
  });

  it('对照：读出的头直接交给 _shared/http.ts 的 cronGate（里面用 safeEqual 定长比较）也算常量时间比对，不报', () => {
    expect(run(sample('f9-server-secret-crongate'))).toEqual({ code: 0, errors: [] });
  });

  it('D2-2：名单里有、config.toml 没关也报；只出现头名字符串（没读头、没调 safeEqual）报；D2-S1：别的函数读 OPS_SECRET 报；F10', () => {
    const { code, errors } = run(sample('f9-server-secret-cfg'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([
      'F1 supabase/functions/other-fn/index.ts:2', // D2-S1
      'F10 supabase/functions/_shared/outbound.ts:2', // 别处的出站白名单（_shared/note.ts 只在注释里写，不报）
      'F10 tools/stub.sql:2', // 非 JS 文件按原文查
      'F9 supabase/config.toml:5', // 名单和配置对不上
      'F9 supabase/functions/usage-report/index.ts:2', // 只有头名字符串
    ].sort());
    expect(errors.find((e) => e.rule === 'F9' && e.file.endsWith('index.ts'))?.message).toContain("没有读这个头");
    expect(errors.find((e) => e.rule === 'F1')?.message).toContain('OPS_SECRET 只准 usage-report 读');
    // _shared/push/stub.ts、tests/ 下、注释里写的都不报
    for (const quiet of ['_shared/push/stub.ts', 'tests/fake.test.ts', '_shared/note.ts']) expect(errors.some((e) => e.file.endsWith(quiet)), quiet).toBe(false);
  });
});

describe('D2-4：真仓库', () => {
  it('config.toml 里 verify_jwt = false 正好是 account-purge、ai-classify、claude-intake、push-dispatch、usage-report 五个（B3 加 claude-intake，M2；B4 加 ai-classify）', () => {
    const toml = readFileSync(join(ROOT, 'supabase', 'config.toml'), 'utf8');
    const off = [...toml.matchAll(/^\[functions\.([\w-]+)\]\r?\nverify_jwt = false\r?$/gm)].map((m) => m[1]).sort();
    expect(off).toEqual(['account-purge', 'ai-classify', 'claude-intake', 'push-dispatch', 'usage-report']);
    expect(toml.match(/^\s*verify_jwt\s*=\s*false/gm)?.length).toBe(5);   // 注释里写的不算
  });
});

describe('F9 ⑥：按连接码哈希查表的名单（B3 任务单 M2、S14；架构 5.7）', () => {
  it('名单写死、完整内容钉住：正好是 {claude-intake: api_tokens}（往名单加函数要改这条单测，过代码审查和安全审查）', () => {
    expect(PY.match(/^HASHED_TOKEN_FUNCTIONS = .*$/gm)).toEqual(['HASHED_TOKEN_FUNCTIONS = {"claude-intake": "api_tokens"}']);
    expect(/HASHED_TOKEN_FUNCTIONS\s*(?:\[|\.update|\|=|=(?! \{"claude-intake))/.test(PY.replace(/^HASHED_TOKEN_FUNCTIONS = .*$/m, ''))).toBe(false);
  });

  it('违规样例被拦：名单里的没关 verify_jwt；名单外的关了；自己定义 tokenHash、按明文查、不查有效期和账号', () => {
    const { code, errors } = run(sample('f9-hashed-token'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([
      'F9 supabase/config.toml:5', // claude-intake 没关
      'F9 supabase/config.toml:9', // token-extra 不在名单里
      'F9 supabase/functions/claude-intake/index.ts:1',
    ]);
    expect(errors.find((e) => e.line === 5)?.message).toContain('HASHED_TOKEN_FUNCTIONS');
    expect(errors.find((e) => e.line === 9)?.message).toContain('不在 SERVER_SECRET_FUNCTIONS、HASHED_TOKEN_FUNCTIONS 里');
    const msg = errors.find((e) => e.file.endsWith('claude-intake/index.ts'))?.message ?? '';
    for (const s of ['自己定义了 tokenHash', '没有按 token_hash 查', '按明文连接码查表', 'tokenLive(', 'isUsable(', "scopes.includes('create')"]) expect(msg, s).toContain(s);
    // 读了 Authorization、查了 api_tokens 的不报这两项
    expect(msg).not.toContain('没有读 Authorization 头');
    expect(msg).not.toContain('没有查 api_tokens 表');
  });

  it('合规样例通过：读 Authorization、import tokenHash、按 token_hash 查 api_tokens、tokenLive、scopes 含 create、isUsable、关了 verify_jwt', () => {
    expect(run(sample('f9-hashed-token-ok'))).toEqual({ code: 0, errors: [] });
  });
});

describe('F10：BE1-S3 和 build/gen_push_endpoints.py 的放行条件（安全审查六之四）', () => {
  it('BE1-S3：supabase/functions/ 下的 tests/、__tests__/ 目录照扫，各报一条', () => {
    const { code, errors } = run(sample('f10-fn-tests-dir'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([
      'F10 supabase/functions/_shared/__tests__/hosts.ts:2',
      'F10 supabase/functions/hello/tests/allow.ts:2',
    ]);
    expect(errors[0]?.message).toContain('supabase/functions/ 下的 tests/、__tests__/ 不算');
  });
  it('BE1-S3 对照：仓库根的 tests/、别处的 __tests__/、函数目录里的 *.test.ts、替身判断模块都不报', () => {
    expect(run(sample('f10-fn-tests-dir-ok'))).toEqual({ code: 0, errors: [] });
  });
  it('放行按精确路径：名单正好是 stub.ts 和 build/gen_push_endpoints.py 两项', () => {
    expect(PY.match(/^DOCKER_HOST_OK = .*$/gm)).toEqual(['DOCKER_HOST_OK = frozenset({"supabase/functions/_shared/push/stub.ts", "build/gen_push_endpoints.py"})']);
  });
  it('build/gen_push_endpoints.py 不联网、不起进程：不 import urllib、http、socket、requests、subprocess（要用就挪进 tests/、从名单删掉）', () => {
    const src = readFileSync(join(ROOT, 'build', 'gen_push_endpoints.py'), 'utf8');
    const mods = [...src.matchAll(/^\s*(?:import\s+([\w., ]+)|from\s+([\w.]+)\s+import\b)/gm)]
      .flatMap((m) => (m[1] ?? m[2] ?? '').split(',').map((x) => x.trim().split(/\s+/)[0]?.split('.')[0] ?? ''));
    expect(mods.length).toBeGreaterThan(0);
    for (const bad of ['urllib', 'http', 'socket', 'requests', 'subprocess']) expect(mods, bad).not.toContain(bad);
    // __import__、importlib 这类动态导入也不准
    expect(/__import__|importlib/.test(src)).toBe(false);
    // 安全审查六之四补：脚本 import 了 os，os 自己就能起进程——os.system、os.popen、os.exec*、os.spawn* 都不准（含 os.execv、os.spawnl 这类）
    for (const bad of [/\bos\s*\.\s*system\b/, /\bos\s*\.\s*popen\b/, /\bos\s*\.\s*exec\w*/, /\bos\s*\.\s*spawn\w*/, /\bos\s*\.\s*(?:fork|posix_spawn)\w*/]) {
      expect(bad.test(src), String(bad)).toBe(false);
    }
    // from os import system 这类绕法也不准
    expect(/^\s*from\s+os\s+import\b/m.test(src)).toBe(false);
  });

  it('六之四补：非测试文件引用测试文件报 F10——import … from、export … from、字面量 import(…) 各一条；不是字面量的动态 import( ) 由 F7 ⑥ 报', () => {
    const { code, errors } = run(sample('f10-fn-test-import'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([
      'F10 supabase/functions/hello/index.ts:2', // import … from
      'F10 supabase/functions/hello/lazy.ts:3', // import('./helper.test.ts')
      'F10 supabase/functions/hello/reexport.ts:2', // export … from
      'F7 supabase/functions/hello/dyn.ts:4', // import(name)
    ]);
    for (const e of errors.filter((x) => x.rule === 'F10')) expect(e.message).toContain('非测试文件不准引用测试文件 supabase/functions/hello/helper.test.ts');
    expect(errors.find((e) => e.rule === 'F7')?.message).toContain('动态 import( ) 的第一个参数必须是字符串字面量');
    // 测试文件本身（里面写了 host.docker.internal）照旧按文件名放过
    expect(errors.some((e) => e.file.endsWith('helper.test.ts'))).toBe(false);
  });
  it('六之四补对照：测试文件引测试文件、引非测试文件；只 import type 测试文件；名字里带 test 的普通文件（contest.ts）——都不报', () => {
    expect(run(sample('f10-fn-test-import-ok'))).toEqual({ code: 0, errors: [] });
  });
});
