// 隐私记首页分类格的小图标（负责人 11-19 选“按分类名配图标”）：只用方案乙里的三个——健康 ♥、证件 ▤、账号 ✱，
// 按分类名里的词配（中韩都认）；配不上的回 null，格子只画分类色块。词表含汉字、谚文，按 A20 放在 -data.ts 里
const GLYPHS: readonly (readonly [RegExp, string])[] = [
  [/健康|体检|医|病|药|건강|병원|검진|약/, '♥'],
  [/证件|护照|身份证|签证|驾照|증명|여권|신분증|비자|면허/, '▤'],
  [/账号|帐号|账户|密码|계정|비밀번호|아이디/, '✱'],
];

/** 分类名配哪个小图标；配不上回 null（只画色块） */
export function tileGlyph(name: string): string | null {
  return GLYPHS.find(([re]) => re.test(name))?.[1] ?? null;
}
