// 附件对象的路径只在这里拼（架构约定 9.7“路径不由客户端决定”、架构 5.13 第 1 点）：<user_id>/<note_id>/<id>.<kind>，缩略图 <user_id>/<note_id>/<id>.t.webp。
// 客户端写 note_files 的 path（库里 check 约束钉死同一个拼法）、file-check 按行里的 user_id、note_id、id、kind 自己拼，都用这一份，不读存下来的路径。
// files 桶（普通随手记）和 vault-files 桶（隐私记，B4b-1 后续）是同一个拼法。
import type { DocKind } from '../../manifests/attachments.ts';

export const noteFilePath = (userId: string, noteId: string, id: string, kind: DocKind): string => `${userId}/${noteId}/${id}.${kind}`;

export const noteFileThumbPath = (userId: string, noteId: string, id: string): string => `${userId}/${noteId}/${id}.t.webp`;
