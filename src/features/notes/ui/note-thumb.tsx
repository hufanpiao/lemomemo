// 一张插图的缩略图（B4b-3，线框 sFind“图片命中直接出缩略图”）：查找面板“最相关”里图片横排用，经 index.ts 的 TodayNotes part="thumb" 懒加载
// • 取图、失败提示和瀑布流卡片顶部的图同一个（CardCover：16:10，取不到写“图片没传上 / 还没传上”）
// • 这条随手记里找不到这张图（刚删、还没同步来）就什么都不画
import { useNoteImages } from '../hooks/useNoteImages.ts';
import { CardCover } from './NoteImages.tsx';

export default function NoteThumb({ noteId, imageId }: { noteId: string; imageId: string }) {
  const { items } = useNoteImages(noteId);
  const it = items.find((x) => x.img.id === imageId);
  return it ? <CardCover img={it.img} count={1} /> : null;
}
