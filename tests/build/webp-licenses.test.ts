// R-402 评审 12：插图的 webp 编码器（@jsquash/webp）随产物分发 wasm 二进制，要附许可原文：
// libwebp 的 BSD-3（分发二进制必须带版权声明）和 jSquash 的 Apache-2.0。文本放在 src/public/licenses/webp-wasm.txt（构建后在 /app/licenses/），
// 这里核对它和 node_modules 里的原文一字不差、版本号对得上；升级 @jsquash/webp 后这条会红，提醒重拷。不加界面入口（入口由负责人定）
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const req = createRequire(import.meta.url);
const text = readFileSync(join(root, 'src', 'public', 'licenses', 'webp-wasm.txt'), 'utf8');
const pkgDir = join(req.resolve('@jsquash/webp/meta.js'), '..');
const original = (p: string) => readFileSync(join(pkgDir, p), 'utf8').trimEnd();

describe('webp 编码器的许可文本随产物发出', () => {
  it('含 libwebp 的 BSD-3 原文（Google 版权声明）和 jSquash 的 Apache-2.0 原文，一字不差', () => {
    const bsd = original('codec/LICENSE.codec.md');
    expect(bsd).toContain('Copyright (c) 2010, Google Inc.');
    expect(text).toContain(bsd);
    const apache = original('LICENSE');
    expect(apache).toContain('Apache License');
    expect(text).toContain(apache);
  });
  it('写明的版本号就是装着的版本', () => {
    const { version } = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { version: string };
    expect(text).toContain(`@jsquash/webp ${version}`);
  });
});
