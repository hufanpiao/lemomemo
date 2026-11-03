// 两个字简称（架构 5.12 第 2 点、R-104、第三轮架构 L3；TC-B2-10、11）
// 月历标签和周视图色块写的是这件事的 short；AI 没生成、用户也没填时，显示时取 itemShort(title)。
// 规则：去掉开头的标点、跳过所有空白，取前 2 个字形簇（Intl.Segmenter grapheme：韩文音节、emoji、带组合符号的字、
// ZWJ 连起来的家庭 emoji 都算一个）。英文也一样取前 2 个字形簇（“SignPlex review” → “Si”），R-104 定的，不另设例外。
// 纯函数：不碰 DOM、不读设置，前端和 Edge Functions 共用。

/** 简称取几个字形簇 */
export const SHORT_GRAPHEMES = 2;

// 字形簇切分和语言无关，传 undefined 用默认；建一次反复用
let segmenter: Intl.Segmenter | undefined;
function graphemes(text: string): string[] {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

/** 开头的标点和空白（\p{P} 含中文、韩文的全角标点；emoji 属于 \p{S}，不去掉） */
const LEADING_PUNCT = /^[\p{P}\s]+/u;
const ANY_SPACE = /\s+/gu;

/** 按 R-104 的规则取前 n 个字形簇；空标题、只有标点和空白时返回空串 */
function firstGraphemes(text: string, n: number): string {
  const body = text.normalize('NFC').replace(LEADING_PUNCT, '').replace(ANY_SPACE, '');
  return graphemes(body).slice(0, n).join('');
}

/** 事项标题的简称（AI 没生成 short 时显示用） */
export function itemShort(title: string): string {
  return firstGraphemes(title, SHORT_GRAPHEMES);
}

/** 项目名的简称（规则和 itemShort 相同，给以后的项目标签用） */
export function projectShort(name: string): string {
  return firstGraphemes(name, SHORT_GRAPHEMES);
}

/** 字符串有几个字形簇（AI 输出 schema 校验 short 不超过 2 个字形簇时可以用） */
export function graphemeCount(text: string): number {
  return graphemes(text).length;
}

/** 月历、周视图实际显示的简称：存了 short（AI 生成或用户手改）就用它，否则按标题取 */
export function displayShort(item: { readonly title: string; readonly short: string | null }): string {
  const s = item.short?.trim() ?? '';
  return s !== '' ? s : itemShort(item.title);
}

/**
 * 改标题时简称跟不跟着清（第三轮架构 L3）：short_by = 'ai' 时，同一个 patch 里把 short、short_by 清空，
 * 显示回到按新标题取的 itemShort；用户手改的（'user'）和本来就没有的（null）不动，返回空对象。
 * 只在标题真的变了时调用；返回值直接并进 patch。
 */
export function shortPatchOnTitleChange(prev: {
  readonly short_by: 'ai' | 'user' | null;
}): { short: null; short_by: null } | Record<string, never> {
  return prev.short_by === 'ai' ? { short: null, short_by: null } : {};
}
