// usage-report 读 R2 本月操作次数（B0-R2 任务单 R2 提醒线：A 类、B 类各到免费额度 70% 提醒）。
// 走 Cloudflare GraphQL 分析接口 r2OperationsAdaptiveGroups，要一把只读的账号分析令牌（Account Analytics: Read）；
// 没配 CF_ACCOUNT_ID、CF_ANALYTICS_TOKEN 时 index.ts 不提供这项，返回体里就没有 r2_ops_* 两项（不是读不到）。
// 口径：整个 Cloudflare 账号、UTC 当月 1 日 00:00 到现在、所有桶（R2 的免费额度按账号算）。
// 分类照 Cloudflare R2 定价页：A 类算“写”、B 类算“读”，删除等免费操作不计。不 import npm 包；fetch 由调用方传入。

export const CF_GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';

export const CLASS_A: ReadonlySet<string> = new Set([
  'ListBuckets', 'PutBucket', 'ListObjects', 'PutObject', 'CopyObject', 'CompleteMultipartUpload', 'CreateMultipartUpload',
  'LifecycleStorageTierTransition', 'ListMultipartUploads', 'UploadPart', 'UploadPartCopy', 'ListParts',
  'PutBucketEncryption', 'PutBucketCors', 'PutBucketLifecycleConfiguration',
]);

export const CLASS_B: ReadonlySet<string> = new Set([
  'HeadBucket', 'HeadObject', 'GetObject', 'UsageSummary', 'GetBucketEncryption', 'GetBucketLocation', 'GetBucketCors',
  'GetBucketLifecycleConfiguration',
]);

const QUERY = `query($acc: string!, $start: Time!, $end: Time!) {
  viewer { accounts(filter: {accountTag: $acc}) {
    r2OperationsAdaptiveGroups(limit: 10000, filter: {datetime_geq: $start, datetime_leq: $end}) {
      sum { requests }
      dimensions { actionType }
    }
  } }
}`;

/** UTC 当月 1 日 00:00 */
export function monthStart(now: number): string {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

/** GraphQL 返回体 → {write, read}；形状不对、带 errors 抛错（usage.ts 记 r2_ops:error） */
export function sumOps(body: unknown): { write: number; read: number } {
  const b = body as { errors?: unknown; data?: { viewer?: { accounts?: { r2OperationsAdaptiveGroups?: unknown }[] } } } | null;
  if (!b || typeof b !== 'object' || (Array.isArray(b.errors) && b.errors.length > 0)) throw new Error('r2_ops');
  const groups = b.data?.viewer?.accounts?.[0]?.r2OperationsAdaptiveGroups;
  if (!Array.isArray(groups)) throw new Error('r2_ops');
  let write = 0;
  let read = 0;
  for (const g of groups as { sum?: { requests?: unknown }; dimensions?: { actionType?: unknown } }[]) {
    const n = g?.sum?.requests;
    const t = g?.dimensions?.actionType;
    if (typeof n !== 'number' || typeof t !== 'string') throw new Error('r2_ops');
    if (CLASS_A.has(t)) write += n;
    else if (CLASS_B.has(t)) read += n;
  }
  return { write, read };
}

// R2 存储量（B7a 评审第 14 条）：r2StorageAdaptiveGroups 每个桶取最近一个时间点的 max { payloadSize metadataSize }，
// 字段名照 Cloudflare R2 文档 platform/metrics-analytics 的示例（filter 用 bucketName、datetime_geq、datetime_leq，orderBy datetime_DESC）；
// 一个桶一个别名（b0～b3），不靠没写进文档的 bucketName_in。数字是 Cloudflare 每隔一段时间记下的快照，比实际晚几小时，
// 但不用逐页列对象（四个桶一共一次请求，原来每 1000 个对象一次 B 类操作、桶大了会超 7 秒）。
const STORAGE_QUERY = (n: number) => `query($acc: string!, $start: Time!, $end: Time!${Array.from({ length: n }, (_, i) => `, $b${i}: string!`).join('')}) {
  viewer { accounts(filter: {accountTag: $acc}) {
${Array.from({ length: n }, (_, i) => `    b${i}: r2StorageAdaptiveGroups(limit: 1, filter: {datetime_geq: $start, datetime_leq: $end, bucketName: $b${i}}, orderBy: [datetime_DESC]) { max { payloadSize metadataSize } }`).join('\n')}
  } }
}`;

/** 存储快照往回看几天：Cloudflare 隔一段时间才记一次，两天内总有一个点 */
export const STORAGE_LOOKBACK_MS = 2 * 86_400_000;

/** GraphQL 返回体 → 字节合计；某个桶两天内没有快照（空桶从没记过）算 0；形状不对、带 errors 抛错 */
export function sumStorage(body: unknown, n: number): number {
  const b = body as { errors?: unknown; data?: { viewer?: { accounts?: Record<string, unknown>[] } } } | null;
  if (!b || typeof b !== 'object' || (Array.isArray(b.errors) && b.errors.length > 0)) throw new Error('r2_bytes');
  const acc = b.data?.viewer?.accounts?.[0];
  if (!acc || typeof acc !== 'object') throw new Error('r2_bytes');
  let total = 0;
  for (let i = 0; i < n; i++) {
    const groups = new Map(Object.entries(acc)).get(`b${i}`);
    if (!Array.isArray(groups)) throw new Error('r2_bytes');
    const g = groups.at(0) as { max?: { payloadSize?: unknown; metadataSize?: unknown } } | undefined;
    if (g === undefined) continue;
    const p = g.max?.payloadSize;
    const m = g.max?.metadataSize;
    if (typeof p !== 'number' || typeof m !== 'number' || p < 0 || m < 0) throw new Error('r2_bytes');
    total += p + m;
  }
  return total;
}

export async function readR2Storage(
  fetchFn: (url: string, init: RequestInit) => Promise<Response>,
  accountId: string,
  token: string,
  bucketNames: readonly string[],
  now: number,
  signal: AbortSignal,
): Promise<number> {
  const vars = Object.fromEntries([
    ['acc', accountId], ['start', new Date(now - STORAGE_LOOKBACK_MS).toISOString()], ['end', new Date(now).toISOString()],
    ...bucketNames.map((name, i) => [`b${i}`, name] as const),
  ]);
  const res = await fetchFn(CF_GRAPHQL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ query: STORAGE_QUERY(bucketNames.length), variables: vars }),
    signal,
  });
  if (!res.ok) throw new Error('r2_bytes');
  return sumStorage(await res.json(), bucketNames.length);
}

export async function readR2Ops(
  fetchFn: (url: string, init: RequestInit) => Promise<Response>,
  accountId: string,
  token: string,
  now: number,
  signal: AbortSignal,
): Promise<{ write: number; read: number }> {
  const res = await fetchFn(CF_GRAPHQL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ query: QUERY, variables: { acc: accountId, start: monthStart(now), end: new Date(now).toISOString() } }),
    signal,
  });
  if (!res.ok) throw new Error('r2_ops');
  return sumOps(await res.json());
}
