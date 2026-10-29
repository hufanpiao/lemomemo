// publish-run-worktree.test.ts 用的 git 小工具（从那个文件拆出来，免得超过 300 行）：在演练台的假仓库（ctx.repo）里
// 改配置、加替换对象之后按“有就删”复原并核对；能喂 stdin、加环境变量地跑 git；R-268 用 git replace 骗过 git status 的复现。
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { expect } from 'vitest';
import { ctx, git } from './publish-run-harness.ts';

/** R-268 用例把替换引用放到这个目录下，配合 GIT_REPLACE_REF_BASE 用（不在 refs/replace/ 下） */
export const REPLACE_BASE = 'refs/lemo-test-replace/';
const CLEAN_SECTIONS = ['attr', 'extensions'];

// R266-sugg ⑥⑦：改假仓库 .git\config、.git\config.worktree 的用例共用。开始时存一份 .git\config 原文，返回的撤销函数放在 finally 里：
// 按“有就删”删掉 config.worktree、去掉 extensions.worktreeConfig 和 attr.tree（键名大小写都算），再把留下的空节
// （[attr]、[Attr]、[extensions] 之类，只有节头没有项）按原写法用 --remove-section 删掉——git 2.55 实测 --unset 最后一项时已连节头一起删，
// 这里给别的版本兜底（--remove-section 认节名大小写，所以按文件里的原写法删）。最后核对 .git\config 和用例开始前一字不差。
// R-268：再按“有就删”删掉 refs/replace/ 和 REPLACE_BASE 下的替换引用（先删，git 才看得到真对象），把 files 从 HEAD 取回（工作区和索引），
// 最后核对全部引用、git status 也和开始前一样
// R-269：files 的原文开始时就存下，撤销时写回（同样长度、修改时间改回去的文件 git checkout 会当成没改、不重写），最后核对一字不差。
// 开头先断言 ctx.repo 是系统临时目录下的绝对路径：万一是空串，git 会落到本仓库、checkout 掉本仓库的文件
export function guardRepoConfig(files: string[] = []): () => void {
  const tmp = resolve(tmpdir()).toLowerCase() + sep;
  expect(ctx.repo !== '' && isAbsolute(ctx.repo) && resolve(ctx.repo).toLowerCase().startsWith(tmp), `ctx.repo 不是系统临时目录下的绝对路径：${ctx.repo}`).toBe(true);
  const cfg = join(ctx.repo, '.git', 'config');
  const before = readFileSync(cfg, 'utf8');
  const orig = files.map((f) => readFileSync(join(ctx.repo, f)));
  const state = () => [gitTry(['for-each-ref', '--format=%(refname)']).out, gitTry(['status', '--porcelain', '--untracked-files=all']).out];
  const stateBefore = state();
  return () => {
    for (const ref of gitTry(['for-each-ref', '--format=%(refname)', 'refs/replace/', REPLACE_BASE]).out.split('\n')) if (ref) gitTry(['update-ref', '-d', ref]);
    if (files.length > 0) gitTry(['checkout', 'HEAD', '--', ...files]);
    files.forEach((f, i) => {
      if (!readFileSync(join(ctx.repo, f)).equals(orig[i] ?? Buffer.alloc(0))) writeFileSync(join(ctx.repo, f), orig[i] ?? '');
      expect(readFileSync(join(ctx.repo, f)).equals(orig[i] ?? Buffer.alloc(0)), `${f} 没复原`).toBe(true);
    });
    rmSync(join(ctx.repo, '.git', 'config.worktree'), { force: true });
    for (const k of ['extensions.worktreeConfig', 'attr.tree']) gitTry(['config', '--local', '--unset-all', k]);
    for (const m of readFileSync(cfg, 'utf8').matchAll(/^[ \t]*\[([A-Za-z]+)\][ \t]*$/gm)) {
      const name = m[1] ?? '';
      if (!CLEAN_SECTIONS.includes(name.toLowerCase())) continue;
      if (gitTry(['config', '--local', '--get-regexp', `^${name.toLowerCase()}\\.`]).ok) continue;
      gitTry(['config', '--local', '--remove-section', name]);
    }
    expect(readFileSync(cfg, 'utf8'), '清理之后 .git\\config 和用例开始前不一样').toBe(before);
    expect(state(), '清理之后引用或 git status 和用例开始前不一样').toEqual(stateBefore);
  };
}

/** 失败不抛（“有就删”）：ok 是退出码 0 且有输出。故意不设 GIT_NO_REPLACE_OBJECTS（看的是 git 默认的样子） */
export function gitTry(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: ctx.repo, encoding: 'utf8' });
  const out = (r.stdout ?? '').trim();
  return { ok: r.status === 0 && out !== '', out };
}

/** 在假仓库里跑 git，能喂 stdin、加环境变量（publish-run-harness.ts 的 git() 不带这两样） */
export function gitIn(args: string[], o: { input?: string; env?: Record<string, string> } = {}): string {
  const r = spawnSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: ctx.repo, encoding: 'utf8', input: o.input, env: { ...process.env, ...o.env } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}：${r.stderr}`);
  return r.stdout.trim();
}

/** R-268 复现：把 package.json 改成 evil 内容并 git add，用含 evil 的提交顶替 HEAD（tag 的提交）。base 是 refs/replace/ 时用真的 git replace */
export const EVIL_FILE = 'package.json';
export const EVIL_MARK = 'R-268 evil';
export function plantReplace(base = 'refs/replace/'): void {
  const file = join(ctx.repo, EVIL_FILE);
  writeFileSync(file, readFileSync(file, 'utf8') + `\n// ${EVIL_MARK}\n`, 'utf8');
  git(['add', EVIL_FILE]);
  const evil = git(['commit-tree', git(['write-tree']), '-m', 'evil']);
  const head = git(['rev-parse', 'HEAD']);
  if (base === 'refs/replace/') git(['replace', head, evil]);
  else git(['update-ref', `${base}${head}`, evil]);
}

/**
 * R-269 复现：EVIL_FILE 改一个字母（长度不变），再把修改时间改回去。先把修改时间拨回整 1 小时前并刷新索引，
 * 让索引比文件新（不然 git 按 racy-git 规则会自己去比内容）；整秒的时间改回去才一点不差。返回改后的内容
 */
export function plantSameLength(): string {
  const file = join(ctx.repo, EVIL_FILE);
  const t = Math.floor(Date.now() / 1000) - 3600;
  utimesSync(file, t, t);
  gitTry(['update-index', '-q', '--refresh']);
  const s = readFileSync(file, 'utf8');
  const i = s.search(/[a-wyz]/u);
  const evil = s.slice(0, i) + 'x' + s.slice(i + 1);
  writeFileSync(file, evil, 'utf8');
  utimesSync(file, t, t);
  return evil;
}
