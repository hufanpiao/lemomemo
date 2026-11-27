// docs/08-发布 下的 .md 不许有控制字符（TAB、回车等，换行 \n 除外）：
// 用脚本往文档里写 Windows 路径时，反斜杠容易被当成转义——10-29 手册第四节 2b 的 `.\tools\deploy\node_modules` 就被写成了
// “.<TAB>ools\deploy<换行>ode_modules”，复制出去的命令跑不了。只读文本。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = join(import.meta.dirname, '..', '..', 'docs', '08-发布');

function listMd(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listMd(p));
    else if (e.name.toLowerCase().endsWith('.md')) out.push(p);
  }
  return out;
}

describe('docs/08-发布 的 .md 没有控制字符', () => {
  const files = listMd(DIR);

  it('找到了发布文档', () => {
    expect(files.some((f) => f.endsWith('上线与回滚手册-v4.md'))).toBe(true);
  });

  it('除换行外没有 U+0000～U+001F 和 U+007F（所在行）', () => {
    for (const f of files) {
      const bad: string[] = [];
      // 回车也算：仓库按 LF（.gitattributes），10-29 顺手把发布记录.md 里 v3 遗留的 \r\r\n 改成了 \n
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        // eslint-disable-next-line no-control-regex
        const m = /[\u0000-\u001f\u007f]/u.exec(line);
        if (m) bad.push(`第 ${i + 1} 行：U+${(m[0].codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`);
      });
      expect(bad, f).toEqual([]);
    }
  });
});
