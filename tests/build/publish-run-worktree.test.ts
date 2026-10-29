// tools/release/publish.ps1 第 1 步对 git 各级配置和属性来源的检查（从 publish-run-deploy.test.ts 拆出来，演练台见 publish-run-harness.ts）：
// ⑧ git 全局配置里的 filter.*、core.attributesfile、全局属性文件（演练用私有的 HOME、XDG_CONFIG_HOME，不碰本机的全局配置）；
// R-264 system 一级：只放行 Git for Windows 自带的四项 filter.lfs.*（值也核对，演练用私有的 GIT_CONFIG_SYSTEM，不碰本机的系统配置）；
// R-266 worktree 一级（.git\config.worktree）：有 filter.*、core.attributesfile 就停；.git\config 开 extensions.worktreeConfig 也停；
// R-265 脚本设 GIT_ATTR_NOSYSTEM=1、git 不读系统属性文件，没生效就停（演练台的 git 包装模拟没生效）；
// OPS-deploy-sugg ① git var 失败就停；
// R266-sugg ② 属性来源：窗口里有 GIT_ATTR_SOURCE 就停（不回显值）；local、worktree、global、system 任一级有 attr.tree 就停（大小写都拦）。
// 不连 Cloudflare、Supabase、GitHub，不真的部署。只在 Windows 上跑。
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ctx, git, LFS_SYSTEM_CONFIG, PS, runScript, setup, teardown } from './publish-run-harness.ts';
import { realSystemIsLfsOnly } from './publish-run-manual.ts';

describe.skipIf(!PS)('publish.ps1 git 各级配置与属性来源（假仓库、私有的 HOME、GIT_CONFIG_SYSTEM）', () => {
  beforeAll(setup, 300_000);
  afterAll(teardown);

  // ⑧ 全局配置：私有的 HOME（~\.gitconfig）和 XDG_CONFIG_HOME（默认的全局属性文件 <XDG>\git\attributes）
  const globalCases: { name: string; gitconfig?: string; attributes?: string; ok: boolean; want: string }[] = [
    { name: '干净的全局配置', ok: true, want: 'git 的全局配置里没有 filter.*、core.attributesfile' },
    { name: '全局 ~\\.gitconfig 里有 filter.x', gitconfig: '[filter "x"]\n\tclean = cat\n', ok: false, want: 'git 的全局配置里有发布时不许有的设置：filter.x.clean' },
    { name: '全局 ~\\.gitconfig 里有 core.attributesfile', gitconfig: '[core]\n\tattributesfile = C:/nowhere/attrs\n', ok: false, want: '不许有的设置：core.attributesfile' },
    { name: '全局 include 进来的文件里有 filter.y', gitconfig: '[include]\n\tpath = more.gitconfig\n', ok: false, want: '不许有的设置：filter.y.smudge' },
    { name: '默认的全局属性文件不为空', attributes: '*.ts filter=x\n', ok: false, want: 'git 的全局属性文件' },
  ];
  for (const c of globalCases) {
    it(`⑧ ${c.name}：${c.ok ? '不拦' : '第 1 步就停'}`, async () => {
      const home = join(ctx.dir, `home-${Math.random().toString(36).slice(2, 10)}`);
      const xdg = join(home, 'xdg');
      mkdirSync(join(xdg, 'git'), { recursive: true });
      if (c.gitconfig) writeFileSync(join(home, '.gitconfig'), c.gitconfig, 'utf8');
      writeFileSync(join(home, 'more.gitconfig'), '[filter "y"]\n\tsmudge = cat\n', 'utf8');
      if (c.attributes) writeFileSync(join(xdg, 'git', 'attributes'), c.attributes, 'utf8');
      const r = await runScript('-CheckOnly -Ops', [], { env: { HOME: home, XDG_CONFIG_HOME: xdg } });
      expect(r.code, r.out).toBe(c.ok ? 0 : 1);
      expect(r.out).toContain(c.want);
      expect(r.calls).toEqual([]);
    }, 180_000);
  }

  // R-266 worktree 一级：.git\config 开 extensions.worktreeConfig 后 git 还读 .git\config.worktree（--local 读不到）。
  // 双保险：按级查时 worktree 一级有 filter.*、core.attributesfile 就停（报出是 worktree 一级、哪个文件）；只开 extensions.worktreeConfig 也停
  const WT_OK = 'git 的 worktree 一级配置里没有 filter.*、core.attributesfile';
  const WT_BAD = 'git 的 worktree 一级配置（.git\\config.worktree 之类）里有发布时不许有的设置：';
  const wtCases: { name: string; ext: boolean; worktree: [string, string][]; ok: boolean; want: string[]; not?: string[] }[] = [
    { name: '写了 filter.x.clean', ext: true, worktree: [['filter.x.clean', 'cat']], ok: false, want: [WT_BAD + 'filter.x.clean（', 'config.worktree）'], not: [WT_OK] },
    { name: '写了 core.attributesfile', ext: true, worktree: [['core.attributesFile', 'C:/nowhere/attrs']], ok: false, want: [WT_BAD + 'core.attributesfile（', 'config.worktree）'], not: [WT_OK] },
    { name: '只开 extensions.worktreeConfig（config.worktree 里没有危险项）', ext: true, worktree: [], ok: false, want: [WT_OK, '不许有的设置：extensions.worktreeconfig'], not: [WT_BAD] },
    { name: '正常仓库（没开 extensions.worktreeConfig）', ext: false, worktree: [], ok: true, want: [WT_OK, '.git\\config 里没有过滤程序、include、hooksPath、fsmonitor、extensions.worktreeConfig 之类的设置'] },
  ];
  for (const c of wtCases) {
    it(`R-266 worktree 一级${c.name}：${c.ok ? '不拦' : '第 1 步就停'}`, async () => {
      const wtFile = join(ctx.repo, '.git', 'config.worktree');
      try {
        if (c.ext) git(['config', '--local', 'extensions.worktreeConfig', 'true']);
        for (const [k, v] of c.worktree) git(['config', '--worktree', k, v]);
        // 前提成立：git 确实把这些项按 worktree 一级读到了
        const first = c.worktree[0];
        if (first) expect(git(['config', '--show-scope', '--list'])).toContain(`worktree\t${first[0].toLowerCase()}=`);
        const r = await runScript('-CheckOnly -Ops', []);
        expect(r.code, r.out).toBe(c.ok ? 0 : 1);
        for (const w of c.want) expect(r.out).toContain(w);
        for (const w of c.not ?? []) expect(r.out).not.toContain(w);
        expect(r.calls).toEqual([]);
        expect(r.envLeft).toBe('');
      } finally {
        rmSync(wtFile, { force: true });
        if (c.ext) git(['config', '--local', '--unset', 'extensions.worktreeConfig']);
      }
    }, 180_000);
  }

  // R-264 system 一级配置：私有的 GIT_CONFIG_SYSTEM（{dir} 换成这个用例自己的目录，include 用）
  const SYS_OK = 'git 的 system 一级配置里只有 Git for Windows 自带的 git-lfs 设置（4 项，值都对），没有 core.attributesfile';
  const SYS_BAD = 'git 的 system 一级配置里有发布时不许有的设置：';
  const sysCases: { name: string; config: string; ok: boolean; want: string[] }[] = [
    { name: '只有 Git for Windows 自带的四项 filter.lfs.*', config: LFS_SYSTEM_CONFIG, ok: true, want: [SYS_OK] },
    { name: '多一项 filter.x.clean', config: LFS_SYSTEM_CONFIG + '[filter "x"]\n\tclean = cat\n', ok: false, want: [SYS_BAD + 'filter.x.clean（', 'system.gitconfig）'] },
    { name: 'filter.lfs.clean 的值被改', config: LFS_SYSTEM_CONFIG.replace('git-lfs clean -- %f', 'git-lfs clean -- %f & calc'), ok: false, want: [SYS_BAD + 'filter.lfs.clean 的值不是 Git for Windows 默认的「git-lfs clean -- %f」（'] },
    { name: 'filter.lfs.required 改成 false', config: LFS_SYSTEM_CONFIG.replace('required = true', 'required = false'), ok: false, want: ['filter.lfs.required 的值不是 Git for Windows 默认的「true」'] },
    { name: '有 core.attributesfile', config: LFS_SYSTEM_CONFIG + '[core]\n\tattributesfile = C:/nowhere/attrs\n', ok: false, want: [SYS_BAD + 'core.attributesfile（'] },
    { name: 'include 进来的文件里有 filter.y', config: LFS_SYSTEM_CONFIG + '[include]\n\tpath = more.gitconfig\n', ok: false, want: [SYS_BAD + 'filter.y.smudge（', 'more.gitconfig）'] },
    { name: '子节大小写不同的 filter.LFS.clean', config: '[filter "LFS"]\n\tclean = git-lfs clean -- %f\n', ok: false, want: [SYS_BAD + 'filter.LFS.clean（'] },
  ];
  for (const c of sysCases) {
    it(`R-264 system 一级${c.name}：${c.ok ? '不拦' : '第 1 步就停'}`, async () => {
      const d = join(ctx.dir, `sys-${Math.random().toString(36).slice(2, 10)}`);
      mkdirSync(d);
      writeFileSync(join(d, 'system.gitconfig'), c.config, 'utf8');
      writeFileSync(join(d, 'more.gitconfig'), '[filter "y"]\n\tsmudge = cat\n', 'utf8');
      const r = await runScript('-CheckOnly -Ops', [], { env: { GIT_CONFIG_SYSTEM: join(d, 'system.gitconfig') } });
      expect(r.code, r.out).toBe(c.ok ? 0 : 1);
      for (const w of c.want) expect(r.out).toContain(w);
      if (!c.ok) expect(r.out).not.toContain(SYS_OK);
      expect(r.calls).toEqual([]);
    }, 180_000);
  }

  // R-265 系统属性文件：脚本第一次调 git 之前设 GIT_ATTR_NOSYSTEM=1，git 不读它；真的 git var GIT_ATTR_SYSTEM 应退出码 1、没有输出
  const NOSYS_OK = 'git 不读系统属性文件（GIT_ATTR_NOSYSTEM=1 已生效）';
  it('R-265 本机真的系统属性文件（Git for Windows 自带的 etc\\gitattributes，不为空也一样）：脚本设了 GIT_ATTR_NOSYSTEM，能过', async () => {
    // 10-30 本机：git var GIT_ATTR_SYSTEM 是 C:/Program Files/Git/etc/gitattributes，515 字节（diff=astextplain 22 行）
    const r = await runScript('-CheckOnly -Ops', [], {});
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(NOSYS_OK);
    expect(r.envLeft).toBe('');
  }, 180_000);

  // 窗口里预先有 GIT_ATTR_NOSYSTEM：一律按脚本设的 1 办
  for (const v of ['0', 'false', 'not-a-bool']) {
    it(`R-265 窗口里预先有 GIT_ATTR_NOSYSTEM=${v}：脚本设成 1，照常能过，结束时清掉`, async () => {
      const r = await runScript('-CheckOnly -Ops', [], { env: { GIT_ATTR_NOSYSTEM: v } });
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain(NOSYS_OK);
      expect(r.envLeft).toBe('');
    }, 180_000);
  }

  it('R-265 GIT_ATTR_NOSYSTEM 没生效（git var GIT_ATTR_SYSTEM 仍答出路径）：第 1 步就停', async () => {
    const f = join(ctx.dir, `sysattr-${Math.random().toString(36).slice(2, 10)}`);
    writeFileSync(f, '*.ts filter=x\n', 'utf8');
    const r = await runScript('-CheckOnly -Ops', [], { env: { LEMO_FAKE_ATTR_SYSTEM: f } });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain(`本脚本设了 GIT_ATTR_NOSYSTEM=1，git 却仍答出系统属性文件 ${f}`);
    expect(r.out).not.toContain(NOSYS_OK);
    expect(r.calls).toEqual([]);
  }, 180_000);

  // 本机真的 system 一级配置（GIT_CONFIG_SYSTEM 不设）：这台电脑只有 Git for Windows 自带的四项时应放行（不是这样的电脑跳过）
  it.skipIf(!realSystemIsLfsOnly())('R-264 本机真的 system 一级配置（Git for Windows 默认）：不拦', async () => {
    const r = await runScript('-CheckOnly -Ops', [], { env: { GIT_CONFIG_SYSTEM: '' } });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(SYS_OK);
  }, 180_000);

  // OPS-deploy-sugg ①：git var 失败（2.42 以前的 git 不认识这两个变量）不再跳过
  for (const v of ['GIT_ATTR_GLOBAL', 'GIT_ATTR_SYSTEM']) {
    it(`① git var ${v} 失败：第 1 步就停，提示要 git 2.42 以上`, async () => {
      const r = await runScript('-CheckOnly -Ops', [], { gitVarFail: v });
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain(`git var ${v} 失败（退出码 129，本机是 git version `);
      expect(r.out).toContain('要 2.42 以上');
      expect(r.log).toContain(`gitvar-fail\t${v}`);
      expect(r.calls).toEqual([]);
    }, 180_000);
  }

  // R266-sugg ②：GIT_ATTR_SOURCE 环境变量、attr.tree 配置能让 git 从任意一个 tree 读 .gitattributes（给文件挂 filter，检出、status 时跑过滤程序）
  it('R266-sugg ② 前提：attr.tree、GIT_ATTR_SOURCE 真能换掉 git 读属性的来源（git check-attr 看得出来）', () => {
    const blob = gitIn(['hash-object', '-w', '--stdin'], { input: 'zz-attr-probe.txt filter=evil\n' });
    const tree = gitIn(['mktree'], { input: `100644 blob ${blob}\t.gitattributes\n` });
    const probe = ['check-attr', 'filter', '--', 'zz-attr-probe.txt'];
    expect(gitIn(probe)).toBe('zz-attr-probe.txt: filter: unspecified');
    expect(gitIn(['-c', `attr.tree=${tree}`, ...probe])).toBe('zz-attr-probe.txt: filter: evil');
    expect(gitIn(['-c', `Attr.Tree=${tree}`, ...probe])).toBe('zz-attr-probe.txt: filter: evil');
    expect(gitIn(probe, { env: { GIT_ATTR_SOURCE: tree } })).toBe('zz-attr-probe.txt: filter: evil');
  });

  it('R266-sugg ② 窗口里有 GIT_ATTR_SOURCE：一开始就停，报出变量名、不回显值', async () => {
    const value = 'TEST_ONLY_attr_source_value_9f3c';
    const r = await runScript('-CheckOnly -Ops', [], { env: { GIT_ATTR_SOURCE: value } });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain('这个窗口里有会改 git 行为的环境变量：GIT_ATTR_SOURCE。');
    expect(r.out).not.toContain(value);
    expect(r.log.join('\n')).not.toContain(value);
    expect(r.calls).toEqual([]);
    expect(r.envLeft).toBe('');
  }, 180_000);

  // 各级配了 attr.tree（值用 HEAD：真能用的 tree-ish）。键名大小写不同的写法 git 列出来都是 attr.tree
  const AT_BAD = { worktree: 'git 的 worktree 一级配置（.git\\config.worktree 之类）里有发布时不许有的设置：attr.tree（', global: 'git 的全局配置里有发布时不许有的设置：attr.tree（', system: 'git 的 system 一级配置里有发布时不许有的设置：attr.tree（', local: '仓库的 .git\\config 里有发布时不许有的设置：attr.tree（' };
  const atCases: { name: string; want: string; prep: (home: string, sys: string) => () => void }[] = [
    { name: 'local 一级 attr.tree', want: AT_BAD.local, prep: () => { git(['config', '--local', 'attr.tree', 'HEAD']); return () => git(['config', '--local', '--unset', 'attr.tree']); } },
    { name: 'local 一级 Attr.Tree（大小写不同）', want: AT_BAD.local, prep: () => { git(['config', '--local', 'Attr.Tree', 'HEAD']); return () => git(['config', '--local', '--unset', 'attr.tree']); } },
    {
      name: 'worktree 一级 attr.tree',
      want: AT_BAD.worktree,
      prep: () => {
        git(['config', '--local', 'extensions.worktreeConfig', 'true']);
        git(['config', '--worktree', 'attr.tree', 'HEAD']);
        return () => {
          rmSync(join(ctx.repo, '.git', 'config.worktree'), { force: true });
          git(['config', '--local', '--unset', 'extensions.worktreeConfig']);
        };
      },
    },
    { name: 'global 一级 [ATTR] TREE（大小写不同）', want: AT_BAD.global, prep: (home) => { writeFileSync(join(home, '.gitconfig'), '[ATTR]\n\tTREE = HEAD\n', 'utf8'); return () => undefined; } },
    { name: 'system 一级 [Attr] Tree（四项 filter.lfs.* 之外）', want: AT_BAD.system, prep: (_h, sys) => { writeFileSync(sys, LFS_SYSTEM_CONFIG + '[Attr]\n\tTree = HEAD\n', 'utf8'); return () => undefined; } },
  ];
  for (const c of atCases) {
    it(`R266-sugg ② ${c.name}：第 1 步就停`, async () => {
      const { home, xdg, sys } = privateGitHome();
      const undo = c.prep(home, sys);
      try {
        // 前提成立：git 确实读到了这一项（键名统一成小写 attr.tree）
        const env = { HOME: home, XDG_CONFIG_HOME: xdg, GIT_CONFIG_SYSTEM: sys };
        expect(gitIn(['config', '--list', '--name-only'], { env }).split('\n'), '没读到 attr.tree').toContain('attr.tree');
        const r = await runScript('-CheckOnly -Ops', [], { env });
        expect(r.code, r.out).toBe(1);
        expect(r.out).toContain(c.want);
        expect(r.calls).toEqual([]);
        expect(r.envLeft).toBe('');
      } finally {
        undo();
      }
    }, 180_000);
  }

  it('R266-sugg ② 正常仓库（没有 GIT_ATTR_SOURCE，各级都没有 attr.tree）：照常通过', async () => {
    const { home, xdg, sys } = privateGitHome();
    const r = await runScript('-CheckOnly -Ops', [], { env: { HOME: home, XDG_CONFIG_HOME: xdg, GIT_CONFIG_SYSTEM: sys } });
    expect(r.code, r.out).toBe(0);
    for (const w of [
      'git 的 worktree 一级配置里没有 filter.*、core.attributesfile、attr.tree',
      'git 的全局配置里没有 filter.*、core.attributesfile、attr.tree',
      '没有 core.attributesfile、attr.tree；git 不读系统属性文件',
      '.git\\config 里没有过滤程序、include、hooksPath、fsmonitor、extensions.worktreeConfig 之类的设置（也没有 attr.tree）',
    ]) expect(r.out).toContain(w);
    expect(r.out).not.toContain('会改 git 行为的环境变量');
    expect(r.envLeft).toBe('');
  }, 180_000);
});

// 每个用例自己的 HOME、XDG_CONFIG_HOME、system 一级配置（只有 Git for Windows 自带的四项），不碰本机的全局、系统配置
function privateGitHome() {
  const home = join(ctx.dir, `home-${Math.random().toString(36).slice(2, 10)}`);
  const xdg = join(home, 'xdg');
  mkdirSync(join(xdg, 'git'), { recursive: true });
  const sys = join(home, 'system.gitconfig');
  writeFileSync(sys, LFS_SYSTEM_CONFIG, 'utf8');
  return { home, xdg, sys };
}

// 在假仓库里跑 git，能喂 stdin、加环境变量（publish-run-harness.ts 的 git() 不带这两样）
function gitIn(args: string[], o: { input?: string; env?: Record<string, string> } = {}): string {
  const r = spawnSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: ctx.repo, encoding: 'utf8', input: o.input, env: { ...process.env, ...o.env } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}：${r.stderr}`);
  return r.stdout.trim();
}
