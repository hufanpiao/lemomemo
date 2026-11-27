// 普通随手记的数据来源（./note-source.ts 的默认值）
// • 行：本机集合 notes、note_images、note_files；只读 id：core 的 readonlyIds('notes')
// • 写：kit 的 localIo（core 的 edit-save，进 outbox、本机先生效）；撤销刚新建的一条写 undone
// • 插图：data/image-uploader.ts 的上传器、data/image-view.ts 的签名取图（./useNoteImages.ts）；附件区是 attachments 的 NoteAttachments
// • 没有“移出隐私记”，后台同步状态一直是空的（失败走 outbox 的“发送失败”区）
import { useMemo } from 'react';
import { savePatch } from '../../../core/edit-save.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import { localIo } from '../../../kit/hooks/useEditRecord.ts';
import { useReadonlyIds } from '../../../kit/hooks/useReadonly.ts';
import { clock } from '../../../platform/clock.ts';
import { NoteAttachments } from '../../attachments/index.ts';
import { uploader } from '../data/image-uploader.ts';
import type { Row } from '../data/note-list.ts';
import type { NoteSource, NoteSync } from './note-source.ts';
import { insertImage, useImageSrc, useNoteImages } from './useNoteImages.ts';

const NO_SYNC: NoteSync = { failed: new Set(), dropped: 0, stale: 0, retry: () => undefined, ack: () => undefined, ackStale: () => undefined };

export const notesSource: NoteSource = {
  kind: 'notes',
  caps: { ai: true, convert: true, merge: true, lockrow: true, moveIn: true, moveOut: false, search: true, trashLink: false },
  route: { list: 'notes', edit: 'note' },
  desk: 'notes',
  orderKey: 'notes.order',
  trash: ['trash', 'notes'],
  useTrashCount: () => null,
  text: null,
  useRows() {
    const notes = useCollection<Row>('notes');
    const images = useCollection<Row>('note_images');
    const files = useCollection<Row>('note_files');
    return useMemo(() => ({ notes, images, files }), [notes, images, files]);
  },
  useReadonly: () => useReadonlyIds('notes'),
  editIo: localIo,
  discard: (id) => savePatch('notes', id, { undone: true, updated_at: clock.now() }, false),
  useImages: useNoteImages,
  // 普通来源不看第三个参数 el（只取看得见的是隐私记的做法）
  useImageSrc,
  insertImage,
  onNotice: (fn) => uploader().onNotice(fn),
  Attachments: NoteAttachments,
  moveOut: async () => 'failed',
  useSync: () => NO_SYNC,
};
