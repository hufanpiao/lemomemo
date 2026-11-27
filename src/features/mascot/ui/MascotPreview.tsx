// 设置 › 吉祥物上方的预览：只放当前选中的一只，全页一个 Rive 实例；换一只由外面换 key，旧实例先销毁
// • 只展示：不接手势，不会长按进 AI
// • 区块高度写死，加载中、失败都盖在上面，下面的列表不跳
// • #2 仍走 stage.ts 的私有下载（不存本机、不进 SW）；挂舞台、记状态、运行日志在 hooks/useStageView.ts
import { useRef } from 'react';
import type { MascotChoice } from '../hooks/mascot-data.ts';
import { useMascotT } from '../hooks/useMascotT.ts';
import { useStageView } from '../hooks/useStageView.ts';
import s from './Mascot.module.css';

/** 这么久还没好才显示“加载中”，切换时不闪字 */
const SLOW_MS = 300;

/** id 为 null：还不知道该放哪一只（管理员身份没读到），先不下载 */
export default function MascotPreview({ id }: { id: MascotChoice | null }) {
  const t = useMascotT();
  const rv = useRef<HTMLDivElement>(null);
  const view = useStageView(rv, 'preview', id, undefined, SLOW_MS);
  const msg = view === 'slow' ? t('mascot.preview.loading', {}) : view === 'fail' ? t('mascot.preview.fail', {}) : '';
  return (
    <div className={s['preview']} data-testid="mascot-preview" data-mascot={id ?? undefined} data-state={view}>
      <div ref={rv} className={s['previewRv']} role="img" aria-label={id === null ? undefined : t(`mascot.name.${id}` as const, {})} />
      <p className={s['previewMsg']} role="status">{msg}</p>
    </div>
  );
}
