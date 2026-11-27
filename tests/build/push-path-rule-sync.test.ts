// 推送端点的整串正则、%2e 禁令、点段正则，以及 D1-7 的 p256dh、auth 正则：SQL（private.push_endpoint_ok）和 TS（_shared/push/endpoint.ts）一字不差
// （B2 安全审查 1.5 第 ① 点：“SQL 一侧用 ~，JS 一侧不加任何标志，两边写法一字不差”）。改规则时两边一起改，这里拦漏改的一边
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUTH, DOT_SEGMENT, ENCODED_DOT, P256DH, SHAPE_SOURCE } from '../../supabase/functions/_shared/push/endpoint.ts';

const MIG = join(import.meta.dirname, '..', '..', 'supabase', 'migrations');
const SQL = readFileSync(join(MIG, '20261103110000_core_claim_endpoint.sql'), 'utf8');
const DEVICES = readFileSync(join(MIG, '20261103100000_core_devices_push_constraints.sql'), 'utf8');

describe('推送端点规则：SQL 和 TS 逐字一致', () => {
  it('整串正则：regexp_match(p, \'<SHAPE_SOURCE>\')', () => {
    expect(SQL).toContain(`pg_catalog.regexp_match(p, '${SHAPE_SOURCE}')`);
  });
  it('%2e 禁令和点段正则', () => {
    expect(SQL).toContain(`p !~ '${ENCODED_DOT}'`);
    expect(SQL).toContain(`y.path !~ '${DOT_SEGMENT}'`);
  });
  it('TS 一侧不加标志（没有 /i、/u）', () => {
    expect(new RegExp(SHAPE_SOURCE).flags).toBe('');
    expect(P256DH.flags).toBe('');
    expect(AUTH.flags).toBe('');
  });
  it('D1-7 密钥正则：private.push_keys_ok、devices 的 check 约束、TS 三处一字不差', () => {
    expect(SQL).toContain(`p256dh !~ '${P256DH.source}' or auth !~ '${AUTH.source}'`);
    expect(DEVICES).toContain(`p256dh ~ '${P256DH.source}'`);
    expect(DEVICES).toContain(`auth ~ '${AUTH.source}'`);
  });
});
