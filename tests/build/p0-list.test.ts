// build/p0_list.py（TC-B7a-17）：从 测试用例-v4.md 的“级别”一列生成 P0 勾选表，条数和第 18 节对不上就失败。
// 拿小样例文档（--doc）看每条规则都拦得住：列数不对、编号写错、级别写错、编号重复、TC-DEL 不是 P0、P0 条数和第 18 节不一致；
// P1 条数不一致只提醒不失败；勾选表只列 P0、--out 写文件。最后查真文档 --check 通过。本文件起 python 子进程。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'build', 'p0_list.py');
const dir = mkdtempSync(join(tmpdir(), 'lemo-p0-list-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const HEAD = '| 编号 | 依据 | 前置 | 步骤 | 期望 | 方式 | 冒烟 | 级别 |\n|---|---|---|---|---|---|---|---|\n';
const DEL_HEAD = '| 编号 | 对象 | 清单 | 怎么找到这个人的数据 | 注销后期望 | 落地批 | 待定 | 级别 |\n|---|---|---|---|---|---|---|---|\n';
const row = (id: string, level: string, basis = '架构 1.1') => `| ${id} | ${basis} | 无 | 做 | 对 | 自动 | ★ | ${level} |\n`;
const stats = (p0: number, p1 = 1, p2 = 0) => `\n## 18. 统计\n\n- **级别**：P0 共 ${p0} 条（含注销），P1 ${p1} 条，P2 ${p2} 条，其余是功能用例。\n\n## 19. 其他\n`;

function doc(body: string): string {
  const f = join(dir, `doc-${Math.random().toString(36).slice(2, 10)}.md`);
  writeFileSync(f, body, 'utf8');
  return f;
}
function run(...args: string[]): { code: number; out: string } {
  const r = spawnSync('python', ['-I', SCRIPT, ...args], { encoding: 'utf8' });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}
const GOOD = `# 测试用例\n\n## 2. B0\n\n${HEAD}${row('TC-B0-01', 'P0', '**R-1** `x`')}${row('TC-B0-02', 'P1')}${row('TC-B0-03', '—')}\n## 3.3 注销\n\n${DEL_HEAD}| TC-DEL-notes | notes | 清单 | user_id | 没了 | B1 | 否 | P0 |\n${stats(2)}`;

describe('build/p0_list.py', () => {
  it('好的样例：--check 通过，勾选表只列 P0，依据去掉加粗和代码标记', () => {
    const f = doc(GOOD);
    const c = run('--check', '--doc', f);
    expect(c.code, c.out).toBe(0);
    expect(c.out).toContain('P0 2 条（和第 18 节一致）、P1 1 条、P2 0 条、功能用例 1 条');
    const p = run('--doc', f);
    expect(p.code, p.out).toBe(0);
    expect(p.out).toContain('共 2 条');
    expect(p.out).toContain('- [ ] TC-B0-01　R-1 x');
    expect(p.out).toContain('- [ ] TC-DEL-notes　notes');
    expect(p.out).not.toContain('TC-B0-02');
    expect(p.out).not.toContain('TC-B0-03');
  });

  it('--out 写文件，内容和打印的一样', () => {
    const f = doc(GOOD);
    const out = join(dir, 'p0.md');
    const r = run('--doc', f, '--out', out);
    expect(r.code, r.out).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe(run('--doc', f).out);
  });

  it.each([
    ['P0 条数和第 18 节对不上', GOOD.replace('P0 共 2 条', 'P0 共 3 条'), 'P0：表里“级别”一列数出来 2 条，第 18 节写的是 3 条'],
    ['级别写错', GOOD.replace(row('TC-B0-02', 'P1'), row('TC-B0-02', 'P3')), 'TC-B0-02 的级别「P3」不是'],
    ['编号写错', GOOD.replace(row('TC-B0-03', '—'), row('TC-B0-3a!', '—')), '编号「TC-B0-3a!」不是'],
    ['编号重复', GOOD.replace(row('TC-B0-03', '—'), row('TC-B0-01', '—')), 'TC-B0-01 和第'],
    ['少一列', GOOD.replace(row('TC-B0-03', '—'), '| TC-B0-03 | 依据 | 无 | 做 | 对 | 自动 | — |\n'), '列数 7，表头是 8 列'],
    ['注销用例不是 P0', GOOD.replace('| 否 | P0 |', '| 否 | P1 |'), 'TC-DEL-notes 是注销用例，级别必须是 P0'],
    ['第 18 节没有那一句', GOOD.replace('- **级别**：', '- 级别：'), '第 18 节里没找到'],
    ['一张用例表都没有', `# 空\n${stats(0)}`, '一张以“编号”开头、“级别”结尾的用例表都没找到'],
  ])('%s：--check 失败', (_n, body, want) => {
    const r = run('--check', '--doc', doc(body));
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain(want);
  });

  it('P1 条数和第 18 节对不上：只提醒，不失败', () => {
    const r = run('--check', '--doc', doc(GOOD.replace('P1 1 条', 'P1 5 条')));
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('提醒：P1：表里“级别”一列数出来 1 条，第 18 节写的是 5 条');
  });

  it('真文档 docs/06-测试/测试用例-v4.md：--check 通过', () => {
    const r = run('--check');
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/P0 \d+ 条（和第 18 节一致）/u);
  });
});
