// R-270（K15-ver 方案 A）：每 15 分钟核对线上网页版本和 lemo-ops 自己这一版的 tag。
// lemo-ops 由 tools/release/publish.ps1 -Ops 用 `wrangler deploy --tag <tag>` 部署，Cloudflare 通过 version_metadata 绑定
// （wrangler.toml 的 CF_VERSION_METADATA）把这次部署的 tag 交给 Worker；网页的版本号在 /app/version.json。
// 两者本该来自同一个 tag：对不上说明网页和服务器端不是同一次发布（误发了别的版本，或发布停在半途）。
// 防护边界：只抓误发和半途停下；有人故意改 tag 或伪造 version.json 挡不住（这两样都在有部署权限的人手里）。
// 不用任何令牌、不读写 Cloudflare 接口，只读公开的 version.json。

import { fetchText, Timeout, type FetchFn } from './http.ts';
import type { Evaluation } from './rules.ts';

/** 正式站地址只写这一处（发布脚本的 -SiteOrigin 默认值是同一个；tests/build/lemo-ops-config.test.ts 核对 src 里只此一处） */
export const SITE_ORIGIN = 'https://lemomemo.com';
export const VERSION_JSON_PATH = '/app/version.json';
export const VERSION_ISSUE_KEY = 'site-version';
/** 连续几轮（每轮 15 分钟）对不上才发：约 30 分钟 */
export const VERSION_MIN_ROUNDS = 2;
export const VERSION_TIMEOUT_MS = 10_000;

/** version_metadata 绑定的形状（@cloudflare/workers-types 的 WorkerVersionMetadata）；没声明绑定时 env 里没有 */
export interface VersionMetadata {
  id?: string;
  tag?: string;
  timestamp?: string;
}

/** version.json 的版本号：X.Y.Z；预览产物是 X.Y.Z-preview.N（vite.config.ts） */
const SITE_VERSION_RE = /^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}(-preview\.[0-9]{1,6})?$/;
/** 发布 tag：vX.Y.Z（和 publish.ps1 的 tag 校验一致，区分大小写、不含别的字符） */
const TAG_RE = /^v[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$/;

export type SiteVersion = { ok: true; version: string } | { ok: false; reason: string };

/** 取线上 version.json：加 ?t= 和 cache: 'no-store'，不吃任何缓存。只认 200 且 version 是字符串；其他一律给原因码 */
export async function fetchSiteVersion(fetchFn: FetchFn, now: number, ms = VERSION_TIMEOUT_MS): Promise<SiteVersion> {
  let r: { status: number; text: string };
  try {
    r = await fetchText(fetchFn, `${SITE_ORIGIN}${VERSION_JSON_PATH}?t=${now}`, { method: 'GET', cache: 'no-store' }, ms);
  } catch (e) {
    return { ok: false, reason: e instanceof Timeout ? 'timeout' : 'network' };
  }
  if (r.status !== 200) return { ok: false, reason: `http_${r.status}` };
  let body: unknown;
  try {
    body = JSON.parse(r.text);
  } catch {
    return { ok: false, reason: 'bad_body' };
  }
  const v = typeof body === 'object' && body !== null ? (body as { version?: unknown }).version : undefined;
  if (typeof v !== 'string') return { ok: false, reason: 'bad_body' };
  return { ok: true, version: v };
}

const TITLE = '线上网页版本和 lemo-ops 的 tag 核对不通过';
const TAIL = [
  `连续 ${VERSION_MIN_ROUNDS} 轮（约 ${VERSION_MIN_ROUNDS * 15} 分钟）都这样才发这封；恢复后连续 2 轮正常会发“已恢复”。`,
  '如果刚按回滚手册只回滚了函数，属预期：网页还是新版，lemo-ops 已回到旧 tag；网页也回滚或重新发布后会自动恢复。',
  '这条告警只抓误发和发布半途停下；有人故意改 tag 或伪造 version.json 挡不住。',
  '处理：按上线与回滚手册第四节核对 Cloudflare › Workers › lemo-ops 部署记录最新一条的 tag 和 Pages 最新一次部署的说明，用同一个 tag 重新发布或回滚。',
];

/** 比对（邮件里只写已通过格式校验的版本号，不回显任意内容）：tag 去掉开头的 v 后和 version.json 的 version 逐字相同才算通过；取不到、格式不对、对不上都报（同一个 key，标题不变） */
export function evaluateVersion(meta: VersionMetadata | undefined, site: SiteVersion): Evaluation {
  const lines: string[] = [];
  const tag = typeof meta?.tag === 'string' ? meta.tag : '';
  if (!meta) {
    lines.push('lemo-ops 没拿到 version_metadata 绑定（wrangler.toml 的 CF_VERSION_METADATA），无法知道自己是哪个 tag。');
  } else if (!TAG_RE.test(tag)) {
    lines.push(
      tag === ''
        ? 'lemo-ops 这一版没有 tag：不是经 publish.ps1 -Ops 部署的（例如在控制台改过设置，或 wrangler secret put 生成了不带 tag 的新版本）。'
        : 'lemo-ops 这一版的 tag 不是 vX.Y.Z 格式（不显示原值）。',
    );
  }
  if (!site.ok) {
    lines.push(`取不到线上 ${VERSION_JSON_PATH}：${site.reason}。`);
  } else if (!SITE_VERSION_RE.test(site.version)) {
    lines.push(`线上 ${VERSION_JSON_PATH} 的 version 不是 X.Y.Z 格式（不显示原值）。`);
  } else if (lines.length === 0 && tag.slice(1) !== site.version) {
    lines.push(`线上网页是「${site.version}」，lemo-ops 是「${tag}」，不是同一次发布。`);
    if (site.version.includes('-preview.')) lines.push('线上网页的版本号带 -preview.，像是把预览产物发到了正式站。');
  }
  if (lines.length === 0) return { active: [], scopes: [VERSION_ISSUE_KEY] };
  return {
    active: [{ key: VERSION_ISSUE_KEY, title: TITLE, lines: [...lines, ...TAIL], minRounds: VERSION_MIN_ROUNDS }],
    scopes: [VERSION_ISSUE_KEY],
  };
}
