// 后端安全审查第 8 条：小工具只留一份。
// ① 计数键的 UTC 日期、小时：_shared/rate-key.ts 的 utcDate、utcHour、utcDayKey、utcHourKey；函数目录里不再各写 toISOString().slice(0, 10 / 13)；
// ② 版本门“读配置失败放行、太旧回 426”：_shared/version-gate-core.ts 的 versionBlock（core.ts 能引，不碰 _shared/gen）；
// ③ 读 app_config.min_client_version：_shared/version-gate.ts 的 appConfigMinLoader（只给 index.ts）。
// ai-*、note-search 另一条线在改，这次不收、不查。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { utcDate, utcDayKey, utcHour, utcHourKey, utcMinuteKey } from '../../supabase/functions/_shared/rate-key.ts';
import { versionBlock } from '../../supabase/functions/_shared/version-gate-core.ts';

const FN = join(import.meta.dirname, '..', '..', 'supabase', 'functions');
const UID = 'aaaaaaaa-0000-4000-8000-000000000001';
const MS = Date.parse('2026-10-28T03:04:05Z');

/** 函数目录里（_shared 的 rate-key.ts、version-gate.ts 自己除外；ai-*、note-search、gen 不查）匹配 re 的文件 */
function filesMatching(re: RegExp, allow: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      const r = rel ? `${rel}/${f}` : f;
      if (statSync(p).isDirectory()) {
        if (f === 'gen' || f === 'ai' || f.startsWith('ai-') || f === 'note-search' || f === '_preview') continue;
        walk(p, r);
      } else if (f.endsWith('.ts') && !allow.includes(r) && re.test(readFileSync(p, 'utf8'))) out.push(r);
    }
  };
  walk(FN, '');
  return out;
}

describe('_shared/rate-key.ts', () => {
  it('utcDate、utcHour、utcDayKey、utcHourKey、utcMinuteKey 的写法', () => {
    expect([utcDate(MS), utcHour(MS)]).toEqual(['20261028', '2026102803']);
    expect(utcDayKey('token-admin', UID, MS)).toBe(`token-admin:${UID}:20261028`);
    expect(utcHourKey('push-test', UID, MS)).toBe(`push-test:${UID}:2026102803`);
    expect(utcMinuteKey('vault-min', UID, MS)).toBe(`vault-min:${UID}:202610280304`);
  });
  it('函数目录里不再各写一份 UTC 日期、小时的截取', () => {
    expect(filesMatching(/toISOString\(\)\.slice\(0, 1[03]\)/, ['_shared/rate-key.ts'])).toEqual([]);
  });
});

describe('版本门的小工具', () => {
  const req = (v: string | null) => new Request('https://x/f', { method: 'POST', headers: v ? { 'x-app-version': v } : {} });
  it('versionBlock：太旧回 426，够新放行，读配置出错放行', async () => {
    const r = await versionBlock(req('1.0.0'), async () => '2.0.0');
    expect([r?.status, await r?.json()]).toEqual([426, { code: 'upgrade_required', min: '2.0.0' }]);
    expect(await versionBlock(req('2.0.0'), async () => '2.0.0')).toBeNull();
    expect(await versionBlock(req('1.0.0'), async () => { throw new Error('db'); })).toBeNull();
  });
  it('只有 version-gate-core.ts 定义 versionBlock；只有 version-gate.ts 读 app_config.min_client_version', () => {
    expect(filesMatching(/function versionBlock\b/, ['_shared/version-gate-core.ts'])).toEqual([]);
    expect(filesMatching(/select\('min_client_version'\)/, ['_shared/version-gate.ts'])).toEqual([]);
  });
});
