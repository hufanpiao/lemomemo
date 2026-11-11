// “＋”点一下打开的打字条在 App 里的位置（B3 FA-2、M4；首屏 Q4）：
// • 首屏只有这一点接线：plus 的入口 features/plus/index.ts 本来就经 app/features.ts 进首屏（只有几行），
//   打字条、本机规则、plus 的词条都在懒加载块里，不进首屏。
//   首屏画完以后（App 在 afterAppPainted 里调 preloadPlus）用 loadTypeBar 把打字条那一块下载下来、记住组件本身；
//   点“＋”时直接画这个组件，打开的那一次渲染里当场画出、当场聚焦（Q-24：iOS 只在点按的同一个任务里 focus 才弹键盘；
//   原来用 lazy，第一次渲染总要挂起一拍、React 19 再压后约 300ms 才放出来，冷启动后第一次点＋键盘不弹）
// • 还没下载好就点了（首屏刚画完就点、离线冷启动又没缓存）：在打字条的位置显示“准备中”（可以关掉），不能点了没反应；
//   下载好了换成打字条（这一次聚焦不在点按里，键盘要再点一下输入框，只在这种情况下）。
//   下载失败：浏览器把失败的动态 import 缓存住（见 src/motion/features.ts 文件头），这一次打开一直是“准备中”，重新打开 App 恢复
import { Suspense, useEffect, useState, useSyncExternalStore } from 'react';
import type { DateStr } from '../../shared/core/date.ts';
import { loadTypeBar, TypeBarPreload } from '../features/plus/index.ts';
import { useT } from '../kit/hooks/useT.ts';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import styles from './plus-slot.module.css';

/** “准备中”晚这么久才显示：刚好赶上下载完的那一下看不出来 */
export const PREPARING_DELAY_MS = 300;

export interface TypeBarSlotProps {
  day: DateStr | null;
  onExpand(text: string, day: DateStr | null): void;
  onEdit?: (table: string, id: string) => void;
  /** 第几次点“＋”打开（Q-10，传给打字条） */
  opened?: number | undefined;
  onClose(): void;
}

type Bar = Awaited<ReturnType<typeof loadTypeBar>>['default'];

let preload = false;
let bar: Bar | null = null;
let loading = false;
const subs = new Set<() => void>();
const emit = (): void => {
  for (const fn of [...subs]) fn();
};

/** 下载打字条那一块（重复调没关系）；下好了记住组件本身，通知重画 */
function load(): void {
  if (loading) return;
  loading = true;
  loadTypeBar().then(
    (m) => {
      bar = m.default;
      emit();
    },
    () => undefined, // 下载失败：一直是“准备中”（文件头）
  );
}

/** 开始预先下载打字条（首屏画完以后调；重复调没关系） */
export function preloadPlus(): void {
  if (preload) return;
  preload = true;
  load();
  emit();
}

const subscribe = (fn: () => void): (() => void) => {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
};
const isWarm = (): boolean => preload;
const loadedBar = (): Bar | null => bar;

/** 只给测试用 */
export function resetPlusForTest(): void {
  preload = false;
  bar = null;
  loading = false;
}

/** 首屏画完以后一直挂一份小气泡；打开着时画打字条，还没下载好时画“准备中” */
export function PlusSlot(props: TypeBarSlotProps & { open: boolean }) {
  const { open, ...rest } = props;
  const warm = useSyncExternalStore(subscribe, isWarm, isWarm);
  const Loaded = useSyncExternalStore(subscribe, loadedBar, loadedBar);
  useEffect(() => {
    if (open) load();
  }, [open]);
  return (
    <>
      {(warm || open) && (
        <ErrorBoundary fallback={null}>
          <Suspense fallback={null}>
            <TypeBarPreload />
          </Suspense>
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
    <div className={styles.wait} role="status" data-testid="plus-preparing">
      <span>{t('nav.plusPreparing', {})}</span>
      <button type="button" className={styles.close} aria-label={t('nav.plusClose', {})} onClick={onClose} data-testid="plus-preparing-close">
        ×
      </button>
    </div>
  );
}
