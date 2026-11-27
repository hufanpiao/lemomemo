// images 桶“签名 → 取字节”只有这一份：纪念日头像、我的头像（core/avatar-view.ts）和随手记插图（features/notes/data/image-view.ts）共用
// • 同一轮（setTimeout 0 之前）要的路径攒成一次 sign（用途 view）；一次多少条不用管，platform/files.ts 的 sign 自己按 SIGN_BATCH_MAX 分批
// • 逐个 fetchBlob（签名在请求头）；签名过期（fetchBlob 回 resign）重签一次再取，还不行就算取不到
// • 结果带 why（步骤和结果码，如 "sign denied:not_found"、"fetch resign:expired"），调用方记运行日志用；不含路径、不含图片
// • missing：服务器说这张图不在（行写上了、图没传上），插图据此出“图片没传上”
// 带 platform/files.ts（有 zod），不进首屏：头像经 core/avatar-view.ts 按需加载，插图在随手记那一包
import { fetchBlob as realFetchBlob, sign as realSign, type FilesClient, type SignResult } from './files.ts';

export type ViewFetchResult = { ok: true; blob: Blob } | { ok: false; missing: boolean; why: string };

export interface ViewFetchDeps {
  sign: FilesClient['sign'];
  fetchBlob: FilesClient['fetchBlob'];
}

const realDeps: ViewFetchDeps = { sign: (items) => realSign(items), fetchBlob: (link) => realFetchBlob(link) };
const item = (path: string) => ({ bucket: 'images' as const, path, purpose: 'view' as const });
const fail = (missing: boolean, why: string): ViewFetchResult => ({ ok: false, missing, why });

/** 建一个取图器：返回 get(path)，同一轮的路径攒成一批签名 */
export function createViewFetch(deps: ViewFetchDeps = realDeps): (path: string) => Promise<ViewFetchResult> {
  let batch: { path: string; resolve(r: ViewFetchResult): void }[] = [];

  async function fetchSigned(path: string, s: SignResult | undefined, resign: boolean): Promise<ViewFetchResult> {
    if (!s) return fail(false, 'sign no_result');
    if (!s.ok) return fail(s.code === 'not_found' || s.reason === 'no_row', `sign ${s.kind}:${s.code}`);
    if (s.sig === null) return fail(false, 'sign no_sig');
    const b = await deps.fetchBlob({ url: s.url, sig: s.sig });
    if (b.ok) return { ok: true, blob: b.blob };
    if (b.kind === 'resign' && resign) {
      const [again] = await deps.sign([item(path)]);
      return fetchSigned(path, again, false);
    }
    return fail(b.code === 'not_found', `fetch ${b.kind}:${b.code}`);
  }

  async function flush(): Promise<void> {
    const items = batch;
    batch = [];
    let signed: SignResult[];
    try {
      signed = await deps.sign(items.map((x) => item(x.path)));
    } catch {
      for (const x of items) x.resolve(fail(false, 'sign failed'));
      return;
    }
    await Promise.all(
      items.map(async (x, i) => {
        try {
          x.resolve(await fetchSigned(x.path, signed[i], true));
        } catch {
          x.resolve(fail(false, 'fetch failed'));
        }
      }),
    );
  }

  return (path) =>
    new Promise<ViewFetchResult>((resolve) => {
      if (batch.length === 0) setTimeout(() => void flush(), 0);
      batch.push({ path, resolve });
    });
}
