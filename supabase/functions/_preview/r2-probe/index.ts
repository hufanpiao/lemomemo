// r2-probe 入口（预览专用、一次性；B0 实测清单 P12，R2 任务单第五节第 1、5、8 项）。
//
// 为什么放在 _preview/ 下：supabase functions deploy 部署名字合规的函数目录和 config.toml 里声明的函数，下划线开头的目录不当函数，
// 所以正式发布（tools/release/publish.ps1 的 functions deploy）不会带上它（F6 和 publish.ps1 另查同名目录和配置声明）。只有 deploy-preview.yml 的构建任务
// 在产物里生成 supabase/functions/r2-probe/index.ts（只有一句 import 本文件）并给它 verify_jwt = false。
// build/check_backend.py F6 保证：仓库里没有顶层的 r2-probe 目录，也没有别的函数或 _shared 引到 _preview/。
//
// 令牌、endpoint 只在这里读，交给 _shared/gen/objstore.ts，不进响应、不打印。
// 说明、调用方法、成本估算和下线步骤：docs/09-路线图/B0-R2探测函数.md
import { createObjStore, type ObjFetch } from '../../_shared/gen/objstore.ts';
import { handle } from './handler.ts';
import type { Budget, ProbeClient } from './probe.ts';

/** 每个请求的超时比 objstore 默认的短；整次运行另有总预算（probe.ts 的 TOTAL_BUDGET_MS，25 秒），超了报 deadline */
const OP_TIMEOUT_MS = 5_000;

function makeClient(bucketPrefix: string, budget: Budget): ProbeClient {
  const endpoint = Deno.env.get('R2_ENDPOINT') ?? '';
  const accessKeyId = Deno.env.get('R2_FN_ACCESS_KEY_ID') ?? '';
  const secretAccessKey = Deno.env.get('R2_FN_SECRET_ACCESS_KEY') ?? '';
  if (!endpoint || !accessKeyId || !secretAccessKey) throw new Error('misconfigured');
  const status: { last: number | null } = { last: null };
  // 包一层 fetch：并进总预算的中止信号（超了总预算就中止请求和响应体，第二轮审查低 2），只记状态码（成功的步骤 objstore 不回状态）
  const recFetch: ObjFetch = async (url, init) => {
    const req = (init ?? {}) as RequestInit;
    const own = budget.signal();
    const signal = own && req.signal ? AbortSignal.any([req.signal, own]) : (own ?? req.signal);
    const res = await fetch(url, signal ? { ...req, signal } : req);
    status.last = res.status;
    return res;
  };
  const store = createObjStore({
    endpoint,
    accessKeyId,
    secretAccessKey,
    bucketPrefix,
    fetch: recFetch,
    now: () => Date.now(),
    timeoutMs: OP_TIMEOUT_MS,
    transferTimeoutMs: OP_TIMEOUT_MS,
  });
  return { store, status };
}

function randomHex(bytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

Deno.serve((req) =>
  handle(req, {
    env: (name) => Deno.env.get(name),
    makeClient,
    now: () => Date.now(),
    clock: () => performance.now(),
    randomHex,
  }),
);
