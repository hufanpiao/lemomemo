// 版本门的实例（架构 0.27 第 1 点、14.2 第 10、11 点）：/sb 和 /files 共用同一个 needsVersionCheck 和同一份缓存。
// 从 functions/sb/[[path]].ts 挪来（0.32：/files 的 PUT 也要查版本）。
import { createVersionGate, type VersionGate } from '../sb/version-gate.ts';

export interface GateEnv {
  SUPABASE_UPSTREAM: string;
  SUPABASE_ANON_KEY: string;
}

let gateCache: { key: string; gate: VersionGate } | null = null;

/** 只记错误码（14.2 第 8 点：不记 URL） */
export function logCode(code: string): void {
  console.log(JSON.stringify({ evt: code }));
}

export function gateFor(env: GateEnv): VersionGate {
  const key = `${env.SUPABASE_UPSTREAM}\n${env.SUPABASE_ANON_KEY}`;
  if (gateCache?.key === key) return gateCache.gate;
  const gate = createVersionGate({
    loadMin: async (signal) => {
      const url = new URL('/rest/v1/app_config?select=min_client_version&limit=1', env.SUPABASE_UPSTREAM);
      const r = await fetch(url.toString(), {
        headers: { apikey: env.SUPABASE_ANON_KEY, accept: 'application/json' },
        signal,
      });
      if (!r.ok) throw new Error('gate_config_http');
      const rows: unknown = await r.json();
      if (!Array.isArray(rows) || rows.length === 0) return null;
      const row: unknown = rows[0];
      return row && typeof row === 'object' && 'min_client_version' in row ? row.min_client_version : null;
    },
    log: logCode,
  });
  gateCache = { key, gate };
  return gate;
}
