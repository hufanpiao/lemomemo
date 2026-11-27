// 一行 note_files 在界面上算不算“有这个附件”：活着（没删、没撤销）、不是隐私记的（is_vault，这一批不出）、kind 认得
// 随手记列表的“附件 N”和附件区列表都用这一份（B4b-1 整块评审第 7 条：原来列表只看活没活，两处个数会对不上）
// 纯函数
import { DOC_TYPES, type DocKind } from '../../manifests/attachments.ts';
import { isLiveRow } from '../live-row.ts';

export const isDocKind = (k: unknown): k is DocKind => typeof k === 'string' && Object.hasOwn(DOC_TYPES, k);

export const isShownFile = <R extends Readonly<Record<string, unknown>>>(r: R): r is R & { kind: DocKind } =>
  isLiveRow(r) && r['is_vault'] !== true && isDocKind(r['kind']);
