// 两段认出的字接起来的唯一一份（11-24 评审第 14 条：原来 Gemini 实时转写的 joinSeg 和手机自带识别的 joinSaid 各写一份，空格规矩还不一样）：
// 两边先去掉首尾空白；韩文、两边接口处都是字母数字（英文单词、数字）时隔一个空格，中文直接接。
// 用的地方：src/platform/live-transcribe.ts（定稿的段 + 正在说的这一段）；原来手机自带识别那一路（voice-speech.ts）11-24 删掉
export function joinSaid(lang: string, a: string, b: string): string {
  const x = a.trim();
  const y = b.trim();
  if (x === '' || y === '') return x + y;
  const word = /[A-Za-z0-9]$/.test(x) && /^[A-Za-z0-9]/.test(y);
  return lang === 'ko-KR' || word ? `${x} ${y}` : x + y;
}
