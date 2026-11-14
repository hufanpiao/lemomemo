// 附件文件名清理 sanitizeFileName（架构 5.13 第 4 点、架构约定 9.7、附录 A note_files.name 的 check 约束）：
// • 只取最后一段（去掉路径）；去掉控制字符、方向控制字符（U+202A～U+202E、U+2066～U+2069，以及 U+200E、U+200F）；
// • 去掉 Windows 不允许的 \ / : * ? " < > |（: 在 NTFS 上是备用数据流）；主名不能以点或空格结尾；
// • 主名是保留名（CON、PRN、AUX、NUL、COM0～9、LPT0～9，和库里约束一样只看第一个点前面）的前面加 _；
// • 扩展名一律按判断出的类型重写；连扩展名最多 120 个字符（按码点数，和库里 char_length 一致）。
// 写进 note_files.name 和下载时的文件名都先过这里；结果一定满足库里的 check 约束（tests/shared/files/file-name.test.ts 对拍）。
import type { DocKind } from '../../manifests/attachments.ts';

export const FILE_NAME_MAX = 120;

// 控制字符、方向控制、Windows 不允许的字符；用 \u 写，源码里不出现这些字符本身
// eslint-disable-next-line no-control-regex -- 就是要去掉控制字符和方向控制符
const BAD = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069\\/:*?"<>|]/gu;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

export function sanitizeFileName(raw: string, kind: DocKind): string {
  const last = raw.split(/[\\/]/).pop() ?? '';
  const dot = last.lastIndexOf('.');
  let base = (dot > 0 ? last.slice(0, dot) : last).replace(BAD, '').trim();
  if (RESERVED.test((base.split('.')[0] ?? '').toLowerCase())) base = `_${base}`;
  const room = FILE_NAME_MAX - kind.length - 1;
  base = [...base].slice(0, room).join('').replace(/[. ]+$/u, '');
  if (base === '' || base.startsWith('.')) base = `file${base}`;
  return `${base}.${kind}`;
}
