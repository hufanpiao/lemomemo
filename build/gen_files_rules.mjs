// /files/v1/* 的规则表生成器（架构 3.5 第 2 点、0.32 第 9 条；任务单 FB-2）。
// 从数据清单里 store = 'r2'、客户端可传的桶（images、files）生成 functions/_generated/files-rules.ts：
// 每段路径的整条正则（照抄清单的 pathPattern，一字不改，D1 拿它和 files_authorize_impl 里的正则比），
// 以及按后缀分的 Content-Type、大小上限、要不要查 webp 文件头。
//
// 用法：node build/gen_files_rules.mjs          重新生成
//       node build/gen_files_rules.mjs --check  重新生成后和仓库里的比，不一致退出码 1（CI；npm run check:files-rules）
// 需要 Node 22.18 以上（直接 import .ts）。
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const OUT = join(ROOT, 'functions', '_generated', 'files-rules.ts');

const common = await import(pathToFileURL(join(ROOT, 'shared', 'manifests', '_common.ts')).href);

/** 客户端经 /files 能传的桶（3.3 G“R2 起”：vault-* 一律只经服务器函数）；和 files_authorize_impl、D1 用同一份（shared/manifests/_common.ts） */
export const CLIENT_BUCKETS = [...common.CLIENT_FILE_BUCKETS];

/** 清单的 store（后端 BE-3 起必填） */
export function storeOf(b) {
  if (b.store !== 'r2' && b.store !== 'supabase') fail(`${b.name} 没写 store（或不是 r2、supabase）`);
  return b.store;
}

/** 附件 10 种扩展名 → MIME（R-114 D-4）。生成时和清单的 allowedMimeTypes、pathPattern 里的扩展名逐个核对，对不上就失败 */
export const DOC_EXT_MIME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  docm: 'application/vnd.ms-word.document.macroEnabled.12',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  pptm: 'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
};

const WEBP = 'image/webp';
const S = '00000000-0000-4000-8000-000000000000';

function fail(msg) {
  throw new Error(`gen_files_rules：${msg}`);
}

function sameSet(a, b) {
  const x = [...new Set(a)].sort();
  const y = [...new Set(b)].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

function mustMatch(re, sample, what) {
  if (!re.test(sample)) fail(`${what} 的 pathPattern 认不出样例路径 ${sample}`);
}

/** 由清单算出规则表（纯函数，测试直接调） */
export function buildRules(manifests) {
  const segs = manifests.flatMap((m) => (m.buckets ?? []).map((b) => ({ b, feature: m.feature })));
  const owners = new Map();
  for (const { b } of segs) if (b.limits) owners.set(b.name, b);

  const rules = [];
  for (const { b, feature } of segs) {
    if (!CLIENT_BUCKETS.includes(b.name)) continue;
    if (storeOf(b) !== 'r2') fail(`${b.name}（${feature}）不是 store = 'r2'，客户端可传的桶必须在 R2`);
    const owner = owners.get(b.name);
    if (!owner) fail(`${b.name} 没有哪份清单写了 limits（桶的主人要写）`);
    const re = new RegExp(b.pathPattern);
    const where = `${b.name} ${b.pathPrefix}（${feature}）`;

    if (b.name === 'images') {
      if (!sameSet(owner.limits.allowedMimeTypes, [WEBP])) fail('images 桶只能放 image/webp');
      const max = owner.limits.fileSizeLimit;
      if (b.pathPrefix === '<user_id>/anniv/') {
        mustMatch(re, `${S}/anniv/${S}/${S}.webp`, where);
        rules.push({ bucket: 'images', segment: 'avatar', pathPattern: b.pathPattern, variants: [v('avatar', '.webp', WEBP, max, true)] });
      } else if (b.pathPrefix === '<user_id>/') {
        mustMatch(re, `${S}/${S}/${S}.webp`, where);
        mustMatch(re, `${S}/${S}/${S}.t.webp`, where);
        rules.push({
          bucket: 'images',
          segment: 'image',
          pathPattern: b.pathPattern,
          variants: [v('thumb', '.t.webp', WEBP, max, true), v('image', '.webp', WEBP, max, true)],
        });
      } else {
        fail(`${where}：生成器不认识这段路径，加了新的一段要同时改生成器和 /files 的有效期规则`);
      }
    } else {
      if (b.pathPrefix !== '<user_id>/') fail(`${where}：生成器不认识这段路径`);
      const m = /\\\.\(([a-z|]+)\)/.exec(b.pathPattern);
      if (!m) fail(`${where}：pathPattern 里找不到扩展名的列表`);
      const exts = m[1].split('|');
      if (!sameSet(exts, Object.keys(DOC_EXT_MIME))) fail(`${where}：pathPattern 的扩展名和生成器的 DOC_EXT_MIME 不一致`);
      const docMimes = owner.limits.allowedMimeTypes.filter((t) => t !== WEBP);
      if (!owner.limits.allowedMimeTypes.includes(WEBP)) fail('files 桶要放 image/webp（缩略图）');
      if (!sameSet(docMimes, Object.values(DOC_EXT_MIME))) fail('files 桶的 allowedMimeTypes 和 DOC_EXT_MIME 不一致');
      const thumbMax = owners.get('images')?.limits.fileSizeLimit;
      if (!thumbMax) fail('缩略图的大小上限取 images 桶的，清单里没找到');
      mustMatch(re, `${S}/${S}/${S}.t.webp`, where);
      const variants = [v('thumb', '.t.webp', WEBP, thumbMax, true)];
      // 长后缀在前：.pptm 不会被 .ppt 抢走（后缀按整段比，本来就不会，排一下更直观）
      for (const ext of [...exts].sort((a, c) => c.length - a.length || a.localeCompare(c))) {
        mustMatch(re, `${S}/${S}/${S}.${ext}`, where);
        variants.push(v(ext, `.${ext}`, DOC_EXT_MIME[ext], owner.limits.fileSizeLimit, false));
      }
      rules.push({ bucket: 'files', segment: 'file', pathPattern: b.pathPattern, variants });
    }
  }
  for (const name of CLIENT_BUCKETS) if (!rules.some((r) => r.bucket === name)) fail(`清单里没有 ${name} 桶`);
  return rules;
}

function v(kind, suffix, contentType, maxBytes, webp) {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) fail(`${kind} 的大小上限不对`);
  return { kind, suffix, contentType, maxBytes, webp };
}

/** 后端 D1 核对用（10-28 约定）：清单 → 规则表全文 */
export function renderFilesRules(manifests) {
  return render(buildRules(manifests));
}

export function render(rules) {
  return `// 自动生成，不要手改：由 build/gen_files_rules.mjs 从 shared/manifests（store = 'r2'、客户端可传的桶 images、files）生成。
// 改了清单就运行 npm run gen:files-rules；CI（npm run check:files-rules 和 tests/build/gen-files-rules.test.ts）
// 重新生成后和这份逐字比对，不一致就失败（架构 3.5 第 2 点、0.32 第 9 条）。
// pathPattern 照抄清单，D1 拿它和 files_authorize_impl 里的正则比（3.5 第 4 点）。

export type FilesBucket = 'images' | 'files';

export interface FilesRuleVariant {
  /** image、thumb、avatar，或附件的扩展名 */
  readonly kind: string;
  /** 路径以它结尾（长的在前） */
  readonly suffix: string;
  /** 上传时 Content-Type 必须等于它 */
  readonly contentType: string;
  /** Content-Length 上限（字节） */
  readonly maxBytes: number;
  /** 要查前 12 字节 RIFF????WEBP */
  readonly webp: boolean;
}

export interface FilesRule {
  readonly bucket: FilesBucket;
  /** image：随手记插图和缩略图；avatar：纪念日头像；file：附件和缩略图 */
  readonly segment: 'image' | 'avatar' | 'file';
  readonly pathPattern: string;
  readonly variants: readonly FilesRuleVariant[];
}

export const FILES_RULES: readonly FilesRule[] = ${JSON.stringify(rules, null, 2)};
`;
}

export async function loadManifests() {
  const mod = await import(pathToFileURL(join(ROOT, 'shared', 'manifests', 'index.ts')).href);
  return mod.allManifests;
}

async function main() {
  const check = process.argv.includes('--check');
  const code = render(buildRules(await loadManifests()));
  if (check) {
    let cur = '';
    try {
      cur = readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n');
    } catch {
      cur = '';
    }
    if (cur !== code) {
      console.error('functions/_generated/files-rules.ts 和清单不一致：运行 npm run gen:files-rules 重新生成（不要手改）');
      process.exit(1);
    }
    console.log('files 规则表和清单一致');
    return;
  }
  writeFileSync(OUT, code, 'utf8');
  console.log('已生成 functions/_generated/files-rules.ts');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
