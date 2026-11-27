// 只展示的小号吉祥物：网页版右边 AI 栏标题前的光球 #7。和设置页预览共用 hooks/useStageView.ts，单只、一个 Rive 实例
// • 只展示：aria-hidden，画布和盒子都不接指针，不会长按进 AI
// • 盒子大小由调用方的 className 写死，加载中留空、旁边的标题不跳；角色按目录的裁切缩进盒子，底边对齐、横向居中（motion/mascot-stage.ts）
//   crop：调用方要角色本体撑满盒子时另给一个更紧的裁切（目录里的裁切连外圈留白，缩到小盒子里本体就小了）
// • 状态写在 data-state（wait / ready / fail）：下不来时调用方按它画自己的退路（AI 栏退回原来的小脸），这里不抛、不弹窗
// • 减少动态效果时舞台只淡入、画出首帧后停住；页面不可见时暂停；运行日志只记 id 和状态
import { useRef } from 'react';
import type { MascotDef, MascotId } from '../hooks/mascot-data.ts';
import { useStageView } from '../hooks/useStageView.ts';
import s from './Mascot.module.css';

export default function MascotMini({ id, className, crop }: { id: MascotId; className: string | undefined; crop?: MascotDef['crop'] }) {
  const rv = useRef<HTMLSpanElement>(null);
  const view = useStageView(rv, 'mini', id, crop);
  return (
    <span className={className} aria-hidden="true" data-mascot-mini={id} data-state={view}>
      {/* 铺满盒子、不接指针，同设置页预览的画布层 */}
      <span ref={rv} className={s['previewRv']} />
    </span>
  );
}
