// “＋”打开的打字条在 App 里的位置。打字条那一块不进首屏：首屏画完以后 preloadPlus 下载、记住组件本身。
// • 点“＋”时直接画它、当场聚焦。不用 lazy：iOS 只在点按的同一个任务里 focus 才弹键盘，lazy 第一次总要挂起一拍
// • 还没下载好就点了：显示“准备中”（可以关掉），不能点了没反应。下载失败时浏览器缓存住失败的动态 import
//   （见 src/motion/features.ts 文件头），一直是“准备中”，重新打开 App 恢复
// • plusHold 交给 GlassBar 只转 pointer 事件（不让它重渲染），下载好以前按住只当点一下
import { useEffect, useState, useSyncExternalStore, type PointerEvent } from 'react';
import type { DateStr } from '../../shared/core/date.ts';
import { createSignal } from '../../shared/core/signal.ts';
import { loadTypeBar } from '../features/plus/index.ts';
import float from '../kit/components/Float.module.css';
import type { PlusHold } from '../kit/components/GlassBar/GlassBar.tsx';
import { useT } from '../kit/hooks/useT.ts';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import styles from './plus-slot.module.css';

/** “准备中”晚这么久才显示：刚好赶上下载完的那一下看不出来 */
export const PREPARING_DELAY_MS = 300;

export interface TypeBarSlotProps {
  day: DateStr | null;
  onExpand(text: string, day: DateStr | null): void;
  onEdit?: (table: string, id: string) => void;
  onClose(): void;
}

type Mod = Awaited<ReturnType<typeof loadTypeBar>>;

/** 下载好的打字条那一块 */
let mod: Mod | undefined;

/** 按住“＋”的转发桥：首屏就交给 GlassBar，下载好才接上打字条那一块的 hold。
 *  用 Proxy 一行转四个口子：首屏额度很紧，逐个写要多几十字节 */
export const plusHold = new Proxy({} as PlusHold, { get: (_, k: keyof PlusHold) => (e: PointerEvent) => mod?.hold[k](e) });
let loading = false;
const subs = createSignal();

/** 下载打字条那一块（重复调没关系），下好了通知重画 */
function load(): void {
  if (loading) return;
  loading = true;
  loadTypeBar().then(
    (m) => {
      mod = m;
      subs.emit();
      // exe 快速记录框：整页只订阅一次，挂在外壳上（不是 exe 时什么也不做）
      m.listenQuickAdd();
    },
    () => undefined, // 下载失败：一直是“准备中”（文件头）
  );
}

/** 开始预先下载打字条（首屏画完以后调；重复调没关系） */
export const preloadPlus = load;

const loaded = (): Mod | undefined => mod;

/** 只给测试用 */
export function resetPlusForTest(): void {
  mod = undefined;
  loading = false;
}

/** 下载好以后一直挂一份 Preload（小气泡、按住录音）；打开着时画打字条或“准备中” */
export function PlusSlot(
  props: TypeBarSlotProps & {
    open: boolean;
    /** 打开打字条（录音那一套的“改用打字”） */
    onOpen?: () => void;
    /** 这一页能不能按住“＋”说话（tab-of.ts 的 hold）；不能时“＋”上方的气泡不出 */
    hold?: boolean;
  },
) {
  const { open, onOpen, hold = true, ...rest } = props;
  const m = useSyncExternalStore(subs.subscribe, loaded, loaded);
  useEffect(() => {
    if (open) load();
  }, [open]);
  const Loaded = m?.default;
  const Pre = m?.Preload;
  return (
    <>
      {Pre && (
        <ErrorBoundary fallback={null}>
          <Pre onType={onOpen} hold={hold} typing={open} />
        </ErrorBoundary>
      )}
      {open &&
        (Loaded ? (
          <ErrorBoundary fallback={<Preparing onClose={rest.onClose} />}>
            <Loaded {...rest} />
          </ErrorBoundary>
        ) : (
          <Preparing onClose={rest.onClose} />
        ))}
    </>
  );
}

function Preparing({ onClose }: { onClose(): void }) {
  const t = useT();
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setShown(true), PREPARING_DELAY_MS);
    return () => clearTimeout(id);
  }, []);
  if (!shown) return null;
  return (
    <div className={`${float.float} ${styles.wait}`} role="status" data-testid="plus-preparing">
      <span>{t('nav.plusPreparing', {})}</span>
      <button type="button" className={styles.close} aria-label={t('nav.plusClose', {})} onClick={onClose} data-testid="plus-preparing-close">
        ×
      </button>
    </div>
  );
}
