// T5（B1 接手清单，前端 A 第二次）：/app/auth/ 的 CSP 断言（入口 B1 K4 才建）；TC-B0-59 的分路径断言在构建产物这一层先做一遍
// 按 Cloudflare Pages 的规则算出每个地址最终拿到的响应头：命中的规则都生效，“! 头名”去掉别的规则给的同名头（只留本段自己的）
// 线上 / wrangler 下的同一组断言在 tests/e2e/csp.spec.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseHeaders, renderHeaders } from '../../build/assemble_web.mjs';

const root = join(import.meta.dirname, '..', '..');
const app = readFileSync(join(root, 'src', '_headers'), 'utf8');
const site = readFileSync(join(root, 'site', '_headers'), 'utf8');

function matches(rule: string, path: string): boolean {
  if (rule.endsWith('/*')) return path.startsWith(rule.slice(0, -1));
  return rule === path;
}

/** 某个地址最终的响应头：名字小写 → 值的列表（同名多条时 Cloudflare 用逗号拼，这里保留成多项好断言） */
function effective(text: string, path: string): Map<string, string[]> {
  const hits = parseHeaders(text).filter((b) => matches(b.path, path));
  const detached = new Map<string, Set<number>>(); // 头名 → 哪几段要求去掉别人的
  hits.forEach((b, i) => {
    for (const l of b.lines) {
      const m = /^!\s*(.+)$/.exec(l);
      if (m?.[1]) {
        const name = m[1].trim().toLowerCase();
        detached.set(name, new Set([...(detached.get(name) ?? []), i]));
      }
    }
  });
  const out = new Map<string, string[]>();
  hits.forEach((b, i) => {
    for (const l of b.lines) {
      if (l.startsWith('!')) continue;
      const at = l.indexOf(':');
      const name = l.slice(0, at).trim().toLowerCase();
      const value = l.slice(at + 1).trim();
      const owners = detached.get(name);
      if (owners && !owners.has(i)) continue; // 被别的段“!”掉了
      out.set(name, [...(out.get(name) ?? []), value]);
    }
  });
  return out;
}

const directives = (csp: string) => csp.split(';').map((d) => d.trim()).filter(Boolean);
const directive = (csp: string, name: string) => directives(csp).find((d) => d.startsWith(`${name} `)) ?? '';
/** 所有以 script-src 开头的指令（script-src、script-src-elem、script-src-attr）：只许有期望的那一条 script-src（R-402 安全审建议） */
const scriptFamily = (csp: string) => directives(csp).filter((d) => /^script-src(-[a-z]+)?\s/.test(d));
/** 'unsafe-eval'、'unsafe-inline'、'unsafe-hashes' 一律不许（带引号匹配，不误伤 'wasm-unsafe-eval'） */
const UNSAFE = /'unsafe-(eval|inline|hashes)'/i;

describe.each(['production', 'preview', 'e2e', 'e2e-real'] as const)('T5 / TC-B0-59：分路径的 CSP（%s）', (mode) => {
  const text = renderHeaders(app, site, mode);

  it.each(['/app/auth/', '/app/auth/index.html', '/app/auth/assets/x.js'])('%s：只有一条 CSP，放行 Turnstile', (path) => {
    const csp = effective(text, path).get('content-security-policy') ?? [];
    expect(csp, '同一个地址只能有一条 CSP（叠加时取交集，Turnstile 会被主 App 那条拦掉）').toHaveLength(1);
    const c = csp[0] ?? '';
    expect(scriptFamily(c)).toEqual(["script-src 'self' https://challenges.cloudflare.com"]);
    expect(directive(c, 'worker-src')).toBe("worker-src 'self'");
    expect(c).not.toMatch(UNSAFE);
    expect(directive(c, 'frame-src')).toBe('frame-src https://challenges.cloudflare.com');
    expect(directives(c)).toContain("base-uri 'none'");
    expect(directives(c)).toContain("form-action 'self'");
    expect(directives(c)).toContain("frame-ancestors 'none'");
    expect(directives(c)).toContain("object-src 'none'");
    expect(directive(c, 'style-src')).toBe("style-src 'self'");
    expect(c).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
    // 除了 Turnstile 不放行任何第三方来源
    const hosts = c.match(/https?:\/\/[^\s;]+/g) ?? [];
    expect(new Set(hosts)).toEqual(new Set(['https://challenges.cloudflare.com']));
  });

  // R-402：主 App（/app/* 那条）的 script-src 只多 'wasm-unsafe-eval'（插图的 webp 编码器编译同源 wasm），不许有 'unsafe-eval'；
  // 以 script-src 开头的指令只许这一条（不许另开 -elem、-attr 放宽）；worker-src 只许 'self'；整串没有 'unsafe-eval / inline / hashes'。
  // 预览沙箱自己那条照旧：script-src 只有 'self'，worker-src 'self' blob:，style-src 带 'unsafe-inline'（架构 5.13 的附件渲染要用），
  // 所以它只查不许 'unsafe-eval'、'unsafe-hashes'
  const MAIN = { script: "script-src 'self' 'wasm-unsafe-eval'", worker: "worker-src 'self'", unsafe: UNSAFE };
  const SANDBOX = { script: "script-src 'self'", worker: "worker-src 'self' blob:", unsafe: /'unsafe-(eval|hashes)'/i };
  it.each([
    ['/app/', MAIN],
    ['/app/index.html', MAIN],
    ['/app/assets/x.js', MAIN],
    ['/app/preview', SANDBOX],
    ['/app/preview.html', SANDBOX],
  ])('%s：不放行 Turnstile 和任何第三方脚本', (path, want) => {
    const csp = effective(text, path).get('content-security-policy') ?? [];
    expect(csp).toHaveLength(1);
    const c = csp[0] ?? '';
    expect(c).not.toContain('challenges.cloudflare.com');
    expect(scriptFamily(c)).toEqual([want.script]);
    expect(directive(c, 'worker-src')).toBe(want.worker);
    expect(c).not.toMatch(want.unsafe);
    expect(directives(c).some((d) => d.startsWith('base-uri '))).toBe(true);
    expect(directives(c).some((d) => d.startsWith('form-action '))).toBe(true);
  });

  it('登录页的其他安全头照样从 /app/* 继承，HTML 不缓存', () => {
    const h = effective(text, '/app/auth/');
    expect(h.get('x-content-type-options')).toEqual(['nosniff']);
    expect(h.get('referrer-policy')).toEqual(['strict-origin-when-cross-origin']);
    expect(h.get('permissions-policy')?.[0]).toContain('camera=()');
    expect(h.get('cache-control')).toEqual(['no-cache']);
    expect(effective(text, '/app/auth/index.html').get('cache-control')).toEqual(['no-cache']);
  });

  it('节假日 JSON 不缓存（架构 5.4；安全审查 FA3-1）：只有一条 no-cache，安全头照样从 /app/* 继承', () => {
    for (const path of ['/app/holidays/cn/2026.json', '/app/holidays/kr/2027.json']) {
      const h = effective(text, path);
      expect(h.get('cache-control'), path).toEqual(['no-cache']);
      expect(h.get('x-content-type-options'), path).toEqual(['nosniff']);
      expect(h.get('content-security-policy'), path).toHaveLength(1);
    }
  });

  it('登录页和主 App 的 connect-src 一样：只有 self 和本环境的 Realtime 地址', () => {
    const auth = effective(text, '/app/auth/').get('content-security-policy')?.[0] ?? '';
    const main = effective(text, '/app/').get('content-security-policy')?.[0] ?? '';
    expect(directive(auth, 'connect-src')).toBe(directive(main, 'connect-src'));
  });
});

// TC-B1-54（R-153；架构 0.27 第 5 点、8.1；S-B0b）：技术页 /diag/* 拿到的 Permissions-Policy。
// 原来是给倾斜授权试验页 /diag/tilt.html 放开 accelerometer、gyroscope；R-373（11-10）倾斜高光整功能删除，试验页一起删，
// /diag/* 只剩机型信息页，方向传感器也关掉。这里断言：/diag/ 下的页面只有一条 Permissions-Policy、设备能力全部关着；
// 只有一条 CSP（/app/* 那条命不中这里）；官网 /zh/*、/ko/* 照旧全部关闭；/app/* 也不再放开方向传感器。
describe.each(['production', 'preview', 'e2e', 'e2e-real'] as const)('TC-B1-54：技术页的 Permissions-Policy（%s）', (mode) => {
  const text = renderHeaders(app, site, mode);
  const items = (pp: string) => pp.split(',').map((s) => s.trim()).filter(Boolean);

  it.each(['/diag/startup.html', '/diag/startup', '/diag/startup.js'])('%s：accelerometer、gyroscope 和其余设备能力都关闭（R-373）', (path) => {
    const h = effective(text, path);
    const pp = h.get('permissions-policy') ?? [];
    expect(pp, '同一地址只能有一条 Permissions-Policy（多条时 Cloudflare 用逗号拼，结果不可控）').toHaveLength(1);
    const got = items(pp[0] ?? '');
    for (const want of ['accelerometer=()', 'gyroscope=()', 'magnetometer=()', 'payment=()', 'usb=()', 'camera=()', 'geolocation=()']) {
      expect(got, want).toContain(want);
    }
    // 什么都不放：没有 (self)、不放给任何第三方或 *
    expect(pp[0]).not.toMatch(/self|\*|https?:/);
    // /diag/* 自己的 CSP：脚本、样式只许同源文件，默认全关，不许被嵌入
    const csp = h.get('content-security-policy') ?? [];
    expect(csp).toHaveLength(1);
    expect(directive(csp[0] ?? '', 'default-src')).toBe("default-src 'none'");
    expect(directive(csp[0] ?? '', 'script-src')).toBe("script-src 'self'");
    expect(directive(csp[0] ?? '', 'style-src')).toBe("style-src 'self'");
    expect(directive(csp[0] ?? '', 'connect-src')).toBe("connect-src 'self'");
    expect(directive(csp[0] ?? '', 'frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(csp[0]).not.toMatch(/unsafe-|https?:|\*/);
    expect(h.get('x-content-type-options')).toEqual(['nosniff']);
    expect(h.get('x-robots-tag')).toEqual(['noindex']);
    expect(h.get('cache-control')).toEqual(['no-cache']);
  });

  it.each(['/zh/', '/ko/', '/app/', '/app/index.html'])('%s：accelerometer、gyroscope 关闭（官网一直关；App 自 R-373 起关）', (path) => {
    const pp = effective(text, path).get('permissions-policy') ?? [];
    expect(pp).toHaveLength(1);
    expect(items(pp[0] ?? '')).toEqual(expect.arrayContaining(['accelerometer=()', 'gyroscope=()']));
  });
});
