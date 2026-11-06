// build/check_contrast.py 的“负责人已接受的例外”名单（清单 accepted；B2 FA-7 第 4 项，负责人 11-05 定深色 --g-tint 保持 0.44）：
//   名单里的不达标、精确值截断到 4 位正好等于 floor 时不算失败；名单外的照样报 1；名单写错（floor 对不上、已达标、皮肤或项不存在、缺字段、重复）报 2。
//   迷你仓库的拼法和 check-contrast.test.ts 一样（那份已经快到 300 行，例外单独放这里）。本文件起 python 子进程。
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'build', 'check_contrast.py');
interface Result {
  theme: string;
  id: string;
  ok: boolean;
  accepted?: boolean;
}
interface Report {
  results?: Result[];
  failed?: number;
  accepted?: number;
  error?: string;
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 一项 ab（--a 对 --b，正文）的迷你仓库，x-light、x-dark 两套变量相同；extra 合进清单 */
function exec(root: string): { code: number; report: Report } {
  try {
    return { code: 0, report: JSON.parse(execFileSync('python', ['-I', SCRIPT, '--json', '--root', root], { encoding: 'utf8' })) as Report };
  } catch (e) {
    const err = e as { status: number; stdout: string };
    return { code: err.status, report: JSON.parse(err.stdout) as Report };
  }
}

function ab(vars: string, _kind: string, extra: Record<string, unknown>): { code: number; report: Report } {
  const root = mkdtempSync(join(tmpdir(), 'lemo-contrast-acc-'));
  dirs.push(root);
  mkdirSync(join(root, 'build'));
  mkdirSync(join(root, 'src', 'styles', 'skins'), { recursive: true });
  const body = `--p1:#808080;--p2:#C0C0C0;${vars}`;
  writeFileSync(
    join(root, 'src', 'styles', 'skins', 'x.css'),
    `:root[data-skin="x"][data-theme="light"]{${body}}\n:root[data-skin="x"][data-theme="dark"]{${body}}`,
  );
  const backdrops = {
    light: { colors: ['#141518'], projectTokens: ['--p1', '--p2'], pick: 'darkest' },
    dark: { colors: ['#FFFFFF', '#F2DF4A'], projectTokens: ['--p1', '--p2'], pick: 'brightest' },
  };
  const pairs = [{ id: 'ab', what: 'ab', source: '测试', fg: '--a', bg: '--b', kind: 'text' }];
  writeFileSync(join(root, 'build', 'contrast-pairs.json'), JSON.stringify({ thresholds: { text: { min: 4.5 } }, backdrops, pairs, ...extra }));
  return exec(root);
}
const one = (r: Report, theme: string, id: string): Result => {
  const hit = r.results?.find((x) => x.theme === theme && x.id === id);
  if (!hit) throw new Error(`报告里没有 ${theme} ${id}`);
  return hit;
};

describe('build/check_contrast.py：负责人已接受的例外（accepted，B2 FA-7 第 4 项，11-05）', () => {
  // #777 对白精确 4.47809：正文不达标；floor 照名单的写法向下截断到 4 位
  const GREY = '--a:#777777;--b:#FFFFFF;';
  const exc = (o: Record<string, unknown> = {}) => ({ theme: 'x-light', id: 'ab', floor: 4.478, decided: '负责人 11-05', reason: '测试', ...o });
  it('名单里的不达标、floor 正好是精确值截断到 4 位：不算失败（退出码看名单外的），报告里标 accepted；名单外（x-dark 那一次）照样报 1', () => {
    const { code, report } = ab(GREY, 'text', { accepted: [exc()] });
    expect(code).toBe(1);
    expect(report.failed).toBe(1);
    expect(one(report, 'x-light', 'ab')).toMatchObject({ ok: false, accepted: true });
    expect(one(report, 'x-dark', 'ab')).toMatchObject({ ok: false, accepted: false });
    const both = ab(GREY, 'text', { accepted: [exc(), exc({ theme: 'x-dark' })] });
    expect(both.code).toBe(0);
    expect(both.report).toMatchObject({ failed: 0, accepted: 2 });
  });

  it.each([
    ['已经达标的例外（名单要删）', '--a:#000000;--b:#FFFFFF;', [exc()]],
    ['皮肤不存在', GREY, [exc({ theme: 'x-lite' })]],
    ['清单里没有这一项', GREY, [exc({ id: 'nope' })]],
    ['缺 reason', GREY, [exc({ reason: ' ' })]],
    ['缺 decided', GREY, [exc({ decided: undefined })]],
    ['缺 floor', GREY, [exc({ floor: undefined })]],
    ['重复', GREY, [exc(), exc()]],
    // floor 必须正好是精确值截断到 4 位（代码复审 M5：审查员把 floor 全改成 1.0 照样全绿）：写宽了、变差了都报 2
    ['floor 写得比实际宽（1.0）', GREY, [exc({ floor: 1 }), exc({ theme: 'x-dark', floor: 1 })]],
    ['floor 比实际高（颜色变差了）', GREY, [exc({ floor: 4.4781 }), exc({ theme: 'x-dark' })]],
    ['floor 没截断（四舍五入成 4.4781 也不行）', GREY, [exc({ floor: 4.47809 }), exc({ theme: 'x-dark' })]],
  ])('名单写错报 2：%s', (_, vars, accepted) => {
    const { code, report } = ab(vars as string, 'text', { accepted });
    expect(code).toBe(2);
    expect(report.error).toBeTruthy();
  });
});

describe('build/check_contrast.py：真仓库的例外名单', () => {
  it('例外名单（11-06 夜负责人要求底栏恢复透明，底栏玻璃两项去掉 over、按最坏底色算；负责人定玻璃按原样，8 项列为例外）：名单外没有不达标', () => {
    type Pair = { id: string; over?: string[] };
    type Exc = { theme: string; id: string; floor: number; decided: string; reason: string };
    const data = JSON.parse(readFileSync(join(ROOT, 'build', 'contrast-pairs.json'), 'utf8')) as { accepted?: Exc[]; pairs: Pair[] };
    // 名单只能缩小：以后要加例外，这里跟着改（代码复审 M5）。11-06 负责人定：底栏玻璃按原样，不为对比度加深（G1、G8）
    const REASON = '负责人 11-06 定：底栏玻璃按原样，不为对比度加深（G1、G8）；上沿外 12pt 渐隐（G12 选 B12），后面的字照样透出来';
    const want: [string, string, number][] = [];
    for (const skin of ['glass', 'simple']) {
      want.push([`${skin}-dark`, 'g-tint-floor', 2.4574], [`${skin}-dark`, 'g-fg-on-floor', 2.7284]);
      want.push([`${skin}-light`, 'g-tint-floor', 1.4053], [`${skin}-light`, 'g-fg-on-floor', 1.4053]);
    }
    expect((data.accepted ?? []).map((e) => [e.theme, e.id, e.floor]).sort()).toEqual(want.sort());
    for (const e of data.accepted ?? []) expect(e).toMatchObject({ decided: '2026-11-06', reason: REASON });
    // 自动深浅 11-06 取消，它的两对颜色也删了
    expect(data.pairs.map((p) => p.id)).not.toEqual(expect.arrayContaining(['g-ad-floor']));
    expect(data.pairs.some((p) => p.id.startsWith('g-ad-'))).toBe(false);
    // 底栏后面又是页面内容（实色带只铺到底栏底边以下）：两项不能再按 over 指定的实色算
    for (const id of ['g-tint-floor', 'g-fg-on-floor']) expect(data.pairs.find((p) => p.id === id)?.over).toBeUndefined();
    const { code, report } = exec(ROOT);
    expect(code).toBe(0);
    expect(report).toMatchObject({ failed: 0, accepted: 8 });
  });
});
