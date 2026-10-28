// 按生成的规则表核对 /files 的桶和路径（架构 3.3 G“R2 起”、14.2 第 11 点）。
// 规则表 functions/_generated/files-rules.ts 由清单生成，不手改；这里只做匹配和链接有效期的取值。
import { FILES_RULES, type FilesBucket, type FilesRule, type FilesRuleVariant } from '../_generated/files-rules.ts';

export type { FilesBucket } from '../_generated/files-rules.ts';

export const CLIENT_BUCKETS: readonly FilesBucket[] = ['images', 'files'];

export function isClientBucket(b: string): b is FilesBucket {
  return (CLIENT_BUCKETS as readonly string[]).includes(b);
}

const COMPILED: readonly { rule: FilesRule; re: RegExp }[] = FILES_RULES.map((rule) => ({ rule, re: new RegExp(rule.pathPattern) }));

export interface MatchedPath {
  bucket: FilesBucket;
  segment: FilesRule['segment'];
  variant: FilesRuleVariant;
  /** 路径第一段（user_id） */
  owner: string;
}

/** 桶和路径都对得上规则表才返回；对不上返回 null（调用方回 bad_path） */
export function matchPath(bucket: FilesBucket, path: string): MatchedPath | null {
  for (const { rule, re } of COMPILED) {
    if (rule.bucket !== bucket || !re.test(path)) continue;
    const variant = rule.variants.find((v) => path.endsWith(v.suffix));
    if (!variant) return null;
    return { bucket, segment: rule.segment, variant, owner: path.slice(0, path.indexOf('/')) };
  }
  return null;
}

// ---------- 链接有效期（14.2 第 11 点） ----------

export type Purpose = 'view' | 'download' | 'ms';

export const TTL = {
  /** 随手记插图和缩略图 view；10-29 从 600 秒降到 120 秒（B0 R2 任务单第五节第 7 项、B1 P-files-sig ①） */
  imageView: 120,
  /** 纪念日头像 */
  avatar: 60,
  /** 附件（含附件缩略图）view、download；图片的 download 也按这个 */
  file: 60,
  /** 给微软查看器的 .pptx；B0 实测后取最短（任务单第五节第 3 项） */
  ms: 300,
  /** 硬上限：任何一项都不能超过；保持 ≤600 秒（安全审查员 10-29 条件③），GET 也按它拒 */
  max: 600,
} as const;

/** 返回秒数；这个用途不允许（ms 只给 files 桶的 .pptx）返回 null */
export function ttlFor(m: MatchedPath, purpose: Purpose): number | null {
  let t: number;
  if (purpose === 'ms') {
    if (m.bucket !== 'files' || m.variant.kind !== 'pptx') return null;
    t = TTL.ms;
  } else if (m.segment === 'avatar') {
    t = TTL.avatar;
  } else if (m.segment === 'image' && purpose === 'view') {
    t = TTL.imageView;
  } else {
    t = TTL.file;
  }
  return Math.min(t, TTL.max);
}
