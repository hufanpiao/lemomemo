// build/check_backend.py F1 的 GEMINI_API_KEY 守门（B4 任务单硬约束 3；安全审 11-10 建议 3）。
// 样例在 tests/arch-fixtures/check_backend/f1-gemini-key；真仓库由 check-backend.test.ts 的整仓扫描兜着。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../arch/fixture-header.ts';
import { run, sample, where } from './check-backend-harness.ts';

const PY = readFileSync(join(ROOT, 'build', 'check_backend.py'), 'utf8');

describe('F1：GEMINI_API_KEY 只准 wire.ts 和 voice-probe 读，import wire.ts 的函数名单写死', () => {
  it('名单写死、完整内容钉住：正好是 ai-classify、ai-parse、ai-voice、claude-intake（往名单加函数要改这条单测，过代码审查和安全审查）', () => {
    expect(PY.match(/^GEMINI_WIRE_FUNCS = .*$/gm)).toEqual(['GEMINI_WIRE_FUNCS = frozenset({"ai-parse", "ai-voice", "ai-classify", "claude-intake"})']);
    expect(PY.match(/^GEMINI_KEY_FILE = .*$/gm)).toEqual(['GEMINI_KEY_FILE = "_shared/ai/wire.ts"']);
    expect(PY.match(/^GEMINI_KEY_PREVIEW_DIR = .*$/gm)).toEqual(['GEMINI_KEY_PREVIEW_DIR = "_preview/voice-probe/"']);
    // 别处不准再往名单里加、也不准改写这三个名字
    const rest = PY.replace(/^GEMINI_(?:WIRE_FUNCS|KEY_FILE|KEY_PREVIEW_DIR) = .*$/gm, '');
    expect(/GEMINI_(?:WIRE_FUNCS|KEY_FILE|KEY_PREVIEW_DIR)\s*(?:\[|\.update|\.add|\|=|=(?!=))/.test(rest)).toBe(false);
  });

  it('违规样例被拦：名单外的函数、共用模块读密钥或 import wire.ts，预览专用函数 import wire.ts；wire.ts 自己、voice-probe 读密钥、名单里的函数 import、注释里提到都不报', () => {
    const { code, errors } = run(sample('f1-gemini-key'));
    expect(code).toBe(1);
    expect(where(errors)).toEqual([
      'F1 supabase/functions/_preview/voice-probe/index.ts:3',
      'F1 supabase/functions/_shared/helper.ts:2',
      'F1 supabase/functions/_shared/helper.ts:3',
      'F1 supabase/functions/push-dispatch/index.ts:2',
      'F1 supabase/functions/push-dispatch/index.ts:3',
    ]);
    expect(errors.find((e) => e.file.endsWith('push-dispatch/index.ts') && e.line === 2)?.message).toContain('ai-classify、ai-parse、ai-voice、claude-intake');
    expect(errors.find((e) => e.file.endsWith('helper.ts') && e.line === 2)?.message).toContain('共用模块 不准读');
  });
});
