// 网页前端和 exe 的 Rust 各写了一份的规则（评审返工第 9 条）：文件名清理、附件类型、大小上限、路径段、下载签名、快速记录字数，
// 和 Rust 同读 tests/fixtures/desktop-shared-rules.json 对拍（Rust 一侧在 desktop/src-tauri/src/attachment.rs 的 tests）
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOC_TYPES, type DocKind } from '../../../shared/manifests/attachments.ts';
import { FILE_NAME_MAX, sanitizeFileName } from '../../../shared/logic/files/file-name.ts';
import { FILE_MAX_BYTES } from '../../../shared/logic/files/limits.ts';
import { QUICK_ADD_MAX_CHARS } from '../desktop-quick-add.ts';
import { checkSig, isSafePath } from '../files-url.ts';

interface Rules {
  limits: { fileMaxBytes: number; fileNameMax: number; quickAddMaxChars: number };
  kinds: string[];
  fileNames: { raw: string; want: string }[];
  segments: { s: string; ok: boolean }[];
  downloadSigs: { sig: string; front: boolean; rust: boolean; why?: string }[];
}

const t = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'tests', 'fixtures', 'desktop-shared-rules.json'), 'utf8')) as Rules;

describe('和 Rust 同一份规则', () => {
  it('上限：附件大小、文件名长度、快速记录字数', () => {
    expect(t.limits).toEqual({ fileMaxBytes: FILE_MAX_BYTES, fileNameMax: FILE_NAME_MAX, quickAddMaxChars: QUICK_ADD_MAX_CHARS });
  });

  it('附件类型（顺序也一致）', () => {
    expect(Object.keys(DOC_TYPES)).toEqual(t.kinds);
  });

  it.each(t.fileNames)('文件名 $raw → $want', ({ raw, want }) => {
    const ext = raw.slice(raw.lastIndexOf('.') + 1).toLowerCase() as DocKind;
    expect(sanitizeFileName(raw, ext)).toBe(want);
  });

  it.each(t.segments)('路径段 $s → $ok', ({ s, ok }) => {
    expect(isSafePath(`${s}/x`)).toBe(ok);
  });

  it.each(t.downloadSigs)('下载签名 $sig → 前端 $front', ({ sig, front, rust, why }) => {
    expect(checkSig(sig, 'download') !== null).toBe(front);
    // 两边结果不同的行必须写明原因
    if (front !== rust) expect(why).toBeTruthy();
  });
});
