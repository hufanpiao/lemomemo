// 今天页右上角头像上的字（B2 FA-7；负责人 11-05 ①：手机版设置入口是今天页右上角头像，名字第一个字）
// 名字取启动时缓存的 profiles 本人那一行的 display_name；没有名字（还没填、没缓存）时返回 null，页面画人形
import { getBoot } from '../../../core/boot.ts';

/** 名字开头不算数的字符：空白、格式控制符（零宽空格 / 连接符、方向控制符、标签字符都在 Cf 里）、单独的组合附加符（代码审查 M1） */
const LEAD = /^[\p{White_Space}\p{Cf}\p{M}]+/u;
/** 头像上能放的字：字母（含汉字、韩文）、数字、表情、国旗 */
const SHOWN = /^[\p{L}\p{N}\p{Extended_Pictographic}\p{Regional_Indicator}]/u;

/** 名字的第一个字（按字素切，韩文音节、表情、带变音的字不切半）；开头的不可见字符跳过；没有能显示的字返回 null（画人形） */
export function nameInitial(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const s = name.replace(LEAD, '');
  if (s === '') return null;
  const first = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)[Symbol.iterator]().next();
  if (first.done || !SHOWN.test(first.value.segment)) return null;
  return first.value.segment;
}

export function useMeInitial(): string | null {
  return nameInitial(getBoot()?.profile?.display_name);
}
