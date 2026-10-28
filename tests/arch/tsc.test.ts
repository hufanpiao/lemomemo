// 架构 2.3 A2、A15、2.4：靠编译器拦的几条——shared 用 window、时刻函数少传 tz、词典少键、t() 少传参数
// 用 tsconfig.shared.json 的选项单独编译每个样例，确认报的就是预期的错误码
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { FIXTURES, loadFixtures, ROOT } from './fixture-header.ts';

function sharedOptions(): ts.CompilerOptions {
  const cfgPath = join(ROOT, 'tsconfig.shared.json');
  const cfg = ts.readConfigFile(cfgPath, (p) => ts.sys.readFile(p));
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, ROOT, undefined, cfgPath);
  return { ...parsed.options, noEmit: true };
}

const options = sharedOptions();

function diagnosticsOf(file: string): string[] {
  const program = ts.createProgram([file], options);
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file?.fileName.replaceAll('\\', '/') === file.replaceAll('\\', '/'))
    .map((d) => `TS${d.code}`);
}

describe('tsc 架构规则（tests/arch-fixtures/tsc）', () => {
  for (const f of loadFixtures('tsc')) {
    it(`${f.file} → ${f.expect.join(', ')}`, { timeout: 60_000 }, () => {
      const codes = diagnosticsOf(join(FIXTURES, 'tsc', f.file));
      for (const code of f.expect) expect(codes, `实际：${codes.join(', ')}`).toContain(code);
    });
  }

  it('真的 shared 代码按同样的选项编译 0 错误（证明上面的错误不是选项本身造成的）', { timeout: 60_000 }, () => {
    const file = join(ROOT, 'shared', 'i18n', 'fmt.ts');
    expect(diagnosticsOf(file)).toEqual([]);
  });
});
