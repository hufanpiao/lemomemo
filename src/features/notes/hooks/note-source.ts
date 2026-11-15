// 随手记界面的数据来源（B5 隐私记重写，主持人 11-15 定稿：notes 出界面、vault 出来源）
// • 随手记页、编辑器、电脑抽屉、插图区都从 useNoteSource() 拿数据和写入口子，不再直接碰本机集合、edit-save、插图上传器
// • 普通随手记的来源在 ./note-source-default.ts（原来的做法原样包进去，随手记行为不变）；context 默认值就是它，
//   今天页的抽屉、查找面板这些没包 Provider 的地方照旧走普通来源
// • 隐私记的来源在 vault 功能里（vault/hooks/vault-note-source.ts，satisfies 这里的 NoteSource），经 notes/index.ts 的 NotesSurface 传进来；
//   类型经 notes/index.ts 的 export type 给出去（A27）
// • caps：两种来源界面上不一样的地方只按这几个开关分，不按 kind 到处判断
// • 放在 hooks 不放 data：类型里有 React 组件（附件区），data 层不准 import React（A1）
import { createContext, useContext, type ComponentType, type RefObject } from 'react';
import type { ActionResult } from '../../../core/action-result.ts';
import type { SaveOutcome } from '../../../core/edit-save.ts';
import type { EditIo } from '../../../kit/hooks/useEditRecord.ts';
import type { ImgNotice, InsertResult, PendingImage } from '../data/image-uploader.ts';
import type { NoteImage, Row } from '../data/note-list.ts';
import { notesSource } from './note-source-default.ts';
import type { ImageSrc } from './useNoteImages.ts';

export type { ActionResult, EditIo, ImageSrc, ImgNotice, InsertResult, NoteImage, PendingImage, Row, SaveOutcome };

/** 界面上两种来源不一样的地方 */
export interface NoteCaps {
  /** AI 小标、识图状态、打开即写“看过了” */
  ai: boolean;
  /** 转成待办 / 日程 */
  convert: boolean;
  /** 合并分类提示条 */
  merge: boolean;
  /** 列表顶上的隐私记入口行 */
  lockrow: boolean;
  /** “移到隐私记”（菜单、左滑） */
  moveIn: boolean;
  /** “移出隐私记”（菜单、左滑、编辑页“⋯”） */
  moveOut: boolean;
  /** 列表、卡片上的“附件 N” */
  filesMark: boolean;
}

/** 列表要的几张表（行的形状同本机集合：notes、note_images、note_files） */
export interface NoteRows {
  notes: readonly Row[];
  images: readonly Row[];
  files: readonly Row[];
}

/** 一条随手记的图（插入先后），每张带上传状态（不在传为 null） */
export interface NoteImagesApi {
  items: readonly { img: NoteImage; pending: PendingImage | null }[];
  insert(file: File): Promise<InsertResult>;
  remove(id: string): Promise<boolean>;
  /** 再传一次；图不在内存里回 false（界面让用户重新选一张） */
  retry(id: string): boolean;
}

/** 后台同步的状态（普通随手记走 outbox，这里一直是空的）：failed = 没保存上的条目；dropped = 上一段解锁期没来得及发就上锁丢掉的改动数 */
export interface NoteSync {
  failed: ReadonlySet<string>;
  dropped: number;
  retry(id: string): void;
  /** 看过“有 N 处改动没来得及保存”了 */
  ack(): void;
}

export interface NoteAttachmentsProps {
  noteId: string | null;
  disabled: boolean;
  onImages(files: readonly File[]): void;
}

/** 来源自己的几句话（普通来源为 null，用随手记的文案） */
export interface NoteSourceText {
  /** 列表页大标题、电脑版分类栏标题 */
  title: string;
  /** 列表空着时 */
  empty: string;
  /** 编辑页左上角“‹ …” */
  back: string;
  /** 列表上方“最近删除”入口的字 */
  trash: string;
}

export interface NoteSource {
  kind: 'notes' | 'vault';
  caps: NoteCaps;
  /** 列表、编辑页的路由名；电脑布局存设置用的页名（两种来源分开存） */
  route: { list: 'notes' | 'vault'; edit: 'note' | 'vault' };
  desk: 'notes' | 'vault';
  /** 列表上方居中的“最近删除”入口去哪（负责人 11-15：随手记页也常驻一个，原来只能从图片空间满的提示条进）：
   *  随手记是全站的 #/trash，隐私记是自己的 #/vault/trash；写成路由和参数，直接交给 kit 的 TrashLink */
  trash: readonly ['trash'] | readonly ['vault', 'trash'];
  /** 入口上带的条数（隐私记：删了的几条）；不带数时 null（全站最近删除还有日程、待办，随手记页不另数一遍） */
  useTrashCount(): number | null;
  text: NoteSourceText | null;
  useRows(): NoteRows;
  /** 只读行（要新版本才能改的） */
  useReadonly(): ReadonlySet<string>;
  /** 新建、改、删除、撤销删除（编辑页经 useEditRecord 的 io，列表页直接调） */
  editIo: EditIo;
  /** 撤销刚新建的一条（输入行插图一张都没成，不留空条） */
  discard(id: string): Promise<SaveOutcome>;
  useImages(noteId: string | null): NoteImagesApi;
  /** thumb：卡片、列表用缩略图；el：图所在的元素（隐私记只取看得见的，普通来源不用） */
  useImageSrc(img: NoteImage | null, thumb: boolean, el?: RefObject<Element | null>): ImageSrc;
  /** 输入行插图：note 是函数时编码成了才新建随手记（回 null = 没建成） */
  insertImage(note: string | (() => Promise<string | null>), file: File): Promise<InsertResult>;
  /** 插图失败的提示；回退订函数 */
  onNotice(fn: (n: ImgNotice) => void): () => void;
  Attachments: ComponentType<NoteAttachmentsProps>;
  /** 移出隐私记（caps.moveOut 才有意义） */
  moveOut(id: string): Promise<ActionResult>;
  useSync(): NoteSync;
}

const Ctx = createContext<NoteSource>(notesSource);

export const NoteSourceProvider = Ctx.Provider;

export function useNoteSource(): NoteSource {
  return useContext(Ctx);
}
