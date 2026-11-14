// 快读组用例在浏览器这一层答 /sb/rest/v1 的共用写法（第三方审查 CI-14：原来 b4b1-attachments、b4b2-find、b4b2-image-ai、b4b3-assist、
// b5-vault、r402-webp-wasm 各写一份）。只答 REST，/sb/functions、/files 各用例自己拦。
// • GET：tables 里有的表回全部行；profiles 回告知已同意（consent_policy_ver = POLICY_VER，再加 profile 里的列）；
//   app_config?select=notice 回同一个告知版本；别的表回空
// • 写（POST、PATCH 等）两种：
//   – store（b4b1、b5-vault、r402）：POST 到 tables 里的表就把行存进去（rev 1、synced_at 现在，store.defaults 垫在行前面），回 201 [{ rev: 1 }]，
//     之后 GET 回出来（首次同步是整表重拉，回空会把刚确认的行当成“服务器上已删”丢掉，见 core/sync/pull.ts）；store.patch 时 PATCH 按 id 改、rev 加一；
//     其余写请求 route.fallback()
//   – 不给 store（b4b2、b4b3）：一律记进 writes、回 201 [{ rev: writeRev }]，不改 tables
// • fixed：表名 → 不分方法直接回的 JSON（b4b3 的 my_ai_usage）
import type { Page } from '@playwright/test';

/** 假告知版本（profiles.consent_policy_ver、app_config.notice 的 policy_ver / min_consent_ver） */
export const POLICY_VER = '2026-10-29';

type Row = Record<string, unknown>;

export interface FakeRestOptions {
  /** profiles 行的 user_id */
  user: string;
  /** 表名 → 初始行 */
  tables?: Record<string, readonly Row[]>;
  /** profiles 行额外的列（例如 consent_ai_at） */
  profile?: Row;
  /** 存行模式（见文件头）；不给就是“只记写请求” */
  store?: { defaults?: Row; patch?: boolean };
  /** 只记写请求时回的 rev，默认 1 */
  writeRev?: number;
  fixed?: Record<string, unknown>;
}

export interface FakeRest {
  /** 表名 → (id → 行)：GET 回出的就是这里；存行模式下 POST、PATCH 改这里 */
  tables: Map<string, Map<string, Row>>;
  /** 只记写请求模式下收到的写：表名和请求体 */
  writes: { table: string; body: unknown }[];
  /** GET 过的表名 */
  pulled: Set<string>;
}

export async function fakeRest(page: Page, o: FakeRestOptions): Promise<FakeRest> {
  const tables = new Map(Object.entries(o.tables ?? {}).map(([name, rows]) => [name, new Map(rows.map((r) => [String(r['id']), r]))]));
  const fake: FakeRest = { tables, writes: [], pulled: new Set() };
  await page.route(/\/sb\/rest\/v1\//, (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const name = u.pathname.split('/').pop() ?? '';
    if (o.fixed && name in o.fixed) return route.fulfill({ json: o.fixed[name] });
    const table = tables.get(name);
    if (req.method() !== 'GET') {
      if (!o.store) {
        fake.writes.push({ table: name, body: req.postDataJSON() });
        return route.fulfill({ status: 201, json: [{ rev: o.writeRev ?? 1 }] });
      }
      if (req.method() === 'POST' && table) {
        const body: unknown = req.postDataJSON();
        for (const r of Array.isArray(body) ? body : [body]) {
          const row = r as Row;
          if (typeof row['id'] === 'string') table.set(row['id'], { ...o.store.defaults, ...row, rev: 1, synced_at: new Date().toISOString() });
        }
        return route.fulfill({ status: 201, json: [{ rev: 1 }] });
      }
      if (req.method() === 'PATCH' && table && o.store.patch) {
        const id = (u.searchParams.get('id') ?? '').replace(/^eq\./, '');
        const old = table.get(id);
        if (!old) return route.fulfill({ json: [] });
        const rev = Number(old['rev']) + 1;
        table.set(id, { ...old, ...(req.postDataJSON() as Row), rev });
        return route.fulfill({ json: [{ rev }] });
      }
      return route.fallback();
    }
    fake.pulled.add(name);
    if (table) return route.fulfill({ json: [...table.values()] });
    if (name === 'profiles') return route.fulfill({ json: [{ user_id: o.user, consent_policy_ver: POLICY_VER, ...o.profile }] });
    if (name === 'app_config' && u.searchParams.get('select') === 'notice') return route.fulfill({ json: [{ notice: { policy_ver: POLICY_VER, min_consent_ver: POLICY_VER } }] });
    return route.fulfill({ json: [] });
  });
  return fake;
}
