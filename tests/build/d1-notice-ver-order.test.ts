// D1 R-273（build/d1/whitelist.ts REQUIRED_CONSTRAINTS 的 public.app_config 那一条；迁移 20261030130000_core_notice_ver_order.sql）：
// app_config_notice_ver_order 的表达式被删或被改宽时 D1 要报“缺约束”。真库一侧的“只比日期不比后缀”由
// supabase/tests/d1-fixtures/29_notice_ver_order_loose.psql 证明；其余改宽写法在这里逐条证明。
// REAL 是离线 PGlite 上 pg_get_constraintdef 的真实输出（含换行和缩进），改宽的写法都从它改出来。
// 10-30 在 PG 17.11（本机镜像 supabase/postgres:17.11.0.006 起的一次性容器，CI 和预览库同为 17）上核过：输出和 REAL（PGlite 0.5.8 = PG 18.3）逐字节相同
import { describe, expect, it } from 'vitest';
import { NOTICE_VER_ORDER_DEF, REQUIRED_CONSTRAINTS } from '../../build/d1/whitelist.ts';

const REAL = `CHECK (
CASE
    WHEN (((notice ->> 'min_consent_ver'::text) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(-[1-9][0-9]?)?$'::text) AND ((notice ->> 'policy_ver'::text) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(-[1-9][0-9]?)?$'::text)) THEN ((("left"((notice ->> 'min_consent_ver'::text), 10) || lpad(substr((notice ->> 'min_consent_ver'::text), 12), 2, '0'::text)) COLLATE "C") <= (("left"((notice ->> 'policy_ver'::text), 10) || lpad(substr((notice ->> 'policy_ver'::text), 12), 2, '0'::text)) COLLATE "C"))
    ELSE NULL::boolean
END)`;

const rules = REQUIRED_CONSTRAINTS.filter(([t]) => t === 'public.app_config');
const passes = (def: string) => rules.every(([, re]) => re.test(def));

describe('D1：app_config_notice_ver_order 必须原样存在（REQUIRED_CONSTRAINTS，R-273）', () => {
  it('登记了正好一条；真实输出、压成一行、白名单里的原文都通过', () => {
    expect(rules).toHaveLength(1);
    expect(passes(REAL)).toBe(true);
    expect(passes(REAL.replace(/\s+/g, ' '))).toBe(true);
    expect(passes(NOTICE_VER_ORDER_DEF)).toBe(true);
  });

  it('改宽或删掉 → 对不上（D1 报“public.app_config 缺约束”）', () => {
    const loose: [string, string][] = [
      ['<= 改成 >=', REAL.replace(' <= ', ' >= ')],
      ['只比日期、不比后缀', REAL.replace(/\|\| lpad\(substr\(\(notice ->> '(min_consent_ver|policy_ver)'::text\), 12\), 2, '0'::text\)/g, '')],
      ['不补两位（变成字符串比，-10 早于 -9）', REAL.replace(/lpad\((substr\([^)]*\)[^)]*\)), 2, '0'::text\)/g, '$1')],
      ['后缀放宽到三位数', REAL.replaceAll('(-[1-9][0-9]?)?', '(-[0-9]{1,3})?')],
      ['ELSE NULL 改成 ELSE true 也不算（结构变了就报）', REAL.replace('ELSE NULL::boolean', 'ELSE true')],
      ['WHEN 里 AND 改 OR', REAL.replace(') AND (', ') OR (')],
      ['整条换成 CHECK (true)', 'CHECK (true)'],
    ];
    for (const [name, def] of loose) {
      expect(def, `${name}：改写没生效`).not.toBe(REAL);
      expect(passes(def), name).toBe(false);
    }
  });
});
