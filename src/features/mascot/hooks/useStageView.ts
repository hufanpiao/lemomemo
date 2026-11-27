// 只展示的舞台（设置页预览 MascotPreview、AI 栏小光球 MascotMini）共用：挂一只、不降落、记状态，卸下时销毁
// • 状态：wait 加载中 / slow 加载超过 slowMs（不给就不会有）/ ready 画出来了 / fail 下不来
// • 运行日志只记 id 和状态：mascot <tag> load|ready|fail id=…
import { useEffect, useState, type RefObject } from 'react';
import { rlog } from '../../../platform/run-log-api.ts';
import { defOf, type MascotChoice, type MascotDef } from './mascot-data.ts';
import { createStage } from './stage.ts';

export type StageView = 'wait' | 'slow' | 'ready' | 'fail';

/** id 为 null：还不知道放哪一只，先不下载；crop 给了就用它替换目录里的裁切 */
export function useStageView(ref: RefObject<HTMLElement | null>, tag: string, id: MascotChoice | null, crop?: MascotDef['crop'], slowMs?: number): StageView {
  const [view, setView] = useState<StageView>('wait');
  // 调用方每次渲染都可能给新数组：按四个数比，不按数组本身
  const [cx, cy, cw, ch] = crop ?? [];
  useEffect(() => {
    setView('wait');
    const slow = slowMs === undefined ? undefined : setTimeout(() => setView((v) => (v === 'wait' ? 'slow' : v)), slowMs);
    const el = ref.current;
    if (!el || id === null) return () => clearTimeout(slow);
    const base = defOf(id);
    const def = cx === undefined || cy === undefined || cw === undefined || ch === undefined ? base : { ...base, crop: [cx, cy, cw, ch] as const };
    rlog(`mascot ${tag} load id=${id}`);
    const stage = createStage(el, def, {
      noDrop: true,
      onReady() {
        rlog(`mascot ${tag} ready id=${id}`);
        setView('ready');
      },
      onFail() {
        rlog(`mascot ${tag} fail id=${id}`);
        setView('fail');
      },
    });
    return () => {
      clearTimeout(slow);
      stage.destroy();
    };
  }, [ref, tag, id, cx, cy, cw, ch, slowMs]);
  return view;
}
