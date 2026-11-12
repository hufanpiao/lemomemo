// build/check_arch.py 的 EMAIL 规则：仓库是公开的，跟踪的文字文件里出现真实邮箱服务商域名（gmail、naver、qq 等）的地址要报错，
// 只放行白名单里明显是假的夹具地址（11-11 清掉负责人验收账号别名、设计稿里的示例邮箱以后加的，防止再带进来）。
// 违规样例不能放进仓库（放了自己会被扫到），所以每条用例在临时目录现拼一棵迷你仓库（和 BIDI、BINIMPORT 的测试同一写法）；
// 本文件里的违规地址一律用 at(名字, 域名) 拼，源码里不出现“名字 + @ + 服务商域名”的原样写法
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkArch, cleanupDirs, lines, repo, ROOT, where, type Item } from './check-arch-binimport-harness.ts';

const at = (local: string, domain: string) => `${local}@${domain}`;
const email = (root: string) => checkArch(root, 'EMAIL');
/** 报错里写出来的地址（@ 前面应该只剩第一个字符） */
const shown = (errors: Item[]) => errors.map((e) => /地址 (\S+?)：/.exec(e.message)?.[1]);
/** 白名单：和 check_arch.py 的 EMAIL_FAKE_OK 各写一份，改白名单要两边一起改 */
const FAKE_OK = [
  'someone@gmail.com',
  'boss@gmail.com',
  'owner@gmail.com',
  'owner.sample@gmail.com',
  'owner.real@gmail.com',
  'jimin.kim@naver.com',
  'lemomemo.test@gmail.com',
];

/** 只跑 check_email（不跑别的规则）。pending 给了就换掉待清理名单，并把 root 当成真仓库（名单过期要报警告） */
function emailOnly(root: string, pending?: string[]): { errors: string[]; warnings: string[]; fakeOk: string[] } {
  const script = [
    'import importlib.util, json, pathlib, sys',
    'spec = importlib.util.spec_from_file_location("check_arch", sys.argv[1])',
    'mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)',
    'root = pathlib.Path(sys.argv[2]).resolve()',
    'if len(sys.argv) > 3: mod.REPO_ROOT = root; mod.EMAIL_PENDING = dict.fromkeys(json.loads(sys.argv[3]), "test")',
    'errors, warnings = [], []; mod.check_email(root, errors, warnings)',
    'print(json.dumps({"errors": [f"{e[1]}:{e[2]}" for e in errors], "warnings": [w[1] for w in warnings], "fakeOk": sorted(mod.EMAIL_FAKE_OK)}))',
  ].join('\n');
  const args = ['-I', '-c', script, join(ROOT, 'build', 'check_arch.py'), root, ...(pending ? [JSON.stringify(pending)] : [])];
  return JSON.parse(execFileSync('python', args, { encoding: 'utf8' })) as { errors: string[]; warnings: string[]; fakeOk: string[] };
}

describe('build/check_arch.py EMAIL（公开仓库里不进真实邮箱）', () => {
  afterEach(cleanupDirs);

  it('各家服务商域名的地址 → 各报一条，行号对，退出码 1；报错里 @ 前面只露第一个字符', () => {
    const domains = ['gmail.com', 'naver.com', 'qq.com', '163.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'kakao.com', 'daum.net'];
    const { code, errors } = email(repo({ 'docs/a.md': lines('# 账号', ...domains.map((d) => `验收账号是 ${at('real.person+lemotest', d)}，10-28 建`), '') }));
    expect(code).toBe(1);
    expect(where(errors)).toEqual(domains.map((_, i) => `docs/a.md:${i + 2}`));
    expect(shown(errors)).toEqual(domains.map((d) => at('r***', d)));
    for (const e of errors) expect(e.message).not.toContain('real.person');
  });

  it('除二进制外所有文件都扫：文档、设计稿、源码、脚本、配置、没有扩展名的文件都报', () => {
    const names = ['docs/a.md', 'docs/b.html', 'src/c.ts', 'tools/d.ps1', 'supabase/e.sql', 'data/f.json', '.github/g.yml', 'notes.txt', 'build/h.py', 'Dockerfile'];
    const { errors } = email(repo(Object.fromEntries(names.map((n) => [n, `x = "${at('real.person', 'gmail.com')}"\n`]))));
    expect(errors.map((e) => e.file).sort()).toEqual([...names].sort());
  });

  it('换写法绕不过去：大写、子域名、URL 里的 %40、加号别名、尖括号、mailto、紧贴汉字、句末句号、域名后面再接一段', () => {
    const body = lines(
      at('Real.Person', 'GMAIL.COM'),
      at('real.person', 'vip.qq.com'),
      `https://example.com/login?email=${at('real.person', 'gmail.com').replace('@', '%40')}&next=1`,
      at('real+lemotest', 'gmail.com'),
      `<${at('real.person', 'naver.com')}>`,
      `<a href="mailto:${at('real.person', 'kakao.com')}">写信</a>`,
      `发到${at('real.person', '163.com')}就行`,
      `Mail ${at('real.person', 'outlook.com')}.`,
      at('real.person', 'qq.com.cn'),
      '',
    );
    const { errors } = email(repo({ 'docs/a.md': body }));
    expect(where(errors)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `docs/a.md:${n}`));
  });

  it('UTF-16 的脚本先解码再扫；同一行同一个地址只报一次', () => {
    const text = `${String.fromCodePoint(0xfeff)}# test\n$a = '${at('real.person', 'gmail.com')}'; $b = '${at('real.person', 'gmail.com')}'\n`;
    const { errors } = email(repo({ 'tools/le.ps1': Buffer.from(text, 'utf16le') }));
    expect(where(errors)).toEqual(['tools/le.ps1:2']);
  });

  it('对照（不报）：白名单里的假地址（大小写不分）、保留域名的占位地址、长得像的别的域名、只写域名后缀、SQL 的 like、含 NUL 的图片', () => {
    const { code, errors } = email(
      repo({
        'tests/ok.test.ts': lines(...FAKE_OK.map((a) => `expect(guard('${a}')).toBe('not_test_email');`), `const upper = '${FAKE_OK[0]?.toUpperCase()}';`, ''),
        'docs/ok.md': lines(
          '验收账号写成 owner+lemotest@example.com，种子账号 e2e-1@lemomemo.test、a@example.test',
          `${at('x', 'notgmail.com')} ${at('x', 'gmail.community')} ${at('x', 'gmail.co')} ${at('x', 'qq.computer')}`,
          '只收 @gmail.com、@naver.com 结尾的地址',
          '',
        ),
        'supabase/ok.sql': "select 1 from auth.users where email like '%@gmail.com';\n",
        'assets/logo.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, ...new TextEncoder().encode(at('real.person', 'gmail.com'))]),
      }),
    );
    expect(errors).toEqual([]);
    expect(code).toBe(0);
  });

  it('白名单要整个地址完全相同才放行：前面多一个字、加了别名、换了服务商、换了名字都照报；白名单就是测试里这七个', () => {
    const body = lines(at('xsomeone', 'gmail.com'), at('someone+tag', 'gmail.com'), at('someone', 'naver.com'), at('jimin.kim', 'gmail.com'), at('owner.real2', 'gmail.com'), '');
    const root = repo({ 'tests/bad.test.ts': body });
    expect(where(email(root).errors)).toEqual([1, 2, 3, 4, 5].map((n) => `tests/bad.test.ts:${n}`));
    expect(emailOnly(root).fakeOk).toEqual([...FAKE_OK].sort());
  });

  it('待清理名单：名单里的文件先不拦，别的文件照拦；名单里的文件清干净了或已删 → 真仓库报警告提醒删名单', () => {
    const bad = `owner = '${at('real.person', 'gmail.com')}'\n`;
    const root = repo({ 'docs/pending.md': bad, 'docs/cleaned.md': 'owner = owner+lemotest@example.com\n', 'docs/other.md': bad });
    const r = emailOnly(root, ['docs/pending.md', 'docs/cleaned.md', 'docs/deleted.md']);
    expect(r.errors).toEqual(['docs/other.md:1']);
    expect(r.warnings).toEqual(['docs/cleaned.md', 'docs/deleted.md']);
    // 不是真仓库（--root 指到样例目录）时不提醒：样例目录里本来就没有名单上的文件
    expect(email(root).errors.map((e) => e.file).sort()).toEqual(['docs/other.md', 'docs/pending.md']);
  });

  it('真仓库：EMAIL 0 个错误（check_arch.py 自己也在被扫的文件里：规则本身不含任何真实地址）', () => {
    expect(emailOnly(ROOT).errors).toEqual([]);
  });
});
