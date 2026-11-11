// “＋”点一下打开的打字条在 App 里的位置（B3 FA-2、M4；首屏 Q4）：
// • 首屏只有这一点接线：plus 的入口 features/plus/index.ts 本来就经 app/features.ts 进首屏（只有几行 lazy），
//   打字条、本机规则、plus 的词条都在懒加载块里，不进首屏。
//   首屏画完以后（App 在 afterAppPainted 里调 preloadPlus）挂一份 TypeBarPreload 把打字条那一块下载进内存，
//   点“＋”时模块已在内存里（lazy 只等一个微任务，“准备中”有 PREPARING_DELAY_MS 的延迟，不会闪出来）
// • 还没下载好就点了（首屏刚画完就点、离线冷启动又没缓存）：在打字条的位置显示“准备中”（可以关掉），不能点了没反应。
//   下载失败时 lazy 记住失败、浏览器也把失败的动态 import 缓存住（见 src/motion/features.ts 文件头），
//   这一次打开一直是“准备中”，重新打开 App 恢复
import { Suspense, useEffect, useState, useSyncExternalStore } from 'react';
import type { DateStr } from '../../shared/core/date.ts';
import { TypeBar, TypeBarPreload } from '../features/plus/index.ts';
import { useT } from '../kit/hooks/useT.ts';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import styles from './plus-slot.module.css';

/** “准备中”晚这么久才显示：模块已在内存里时 lazy 那一下等待看不出来 */
export const PREPARING_DELAY_MS = 300;

export interface TypeBarSlotProps {
  day: DateStr | null;
  onExpand(text: string, day: DateStr | null): void;
  onEdit?: (table: string, id: string) => void;
  /** 第几次点“＋”打开（Q-10，传给打字条） */
  opened?: number | undefined;
  onClose(): void;
}

let preload = false;
const subs = new Set<() => void>();

/** 开始预先下载打字条（首屏画完以后调；重复调没关系） */
export function preloadPlus(): void {
  if (preload) return;
  preload = true;
  for (const fn of [...subs]) fn();
}

const subscribe = (fn: () => void): (() => void) => {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
};
const current = (): boolean => preload;

/** 只给测试用 */
export function resetPlusForTest(): void {
  preload = false;
}

/** 首屏画完以后一直挂一份预先下载；打开着时画打字条，还没下载好时画“准备中” */
export function PlusSlot(props: TypeBarSlotProps & { open: boolean }) {
  const { open, ...rest } = props;
  const warm = useSyncExternalStore(subscribe, current, current);
  const wait = <Preparing onClose={rest.onClose} />;
  return (
    <>
      {(warm || open) && (
        <ErrorBoundary fallback={null}>
          <Suspense fallback={null}>
            <TypeBarPreload />
          </Suspense>
        </ErrorBoundary>
      )}
      {open && (
        <ErrorBoundary fallback={wait}>
          <Suspense fallback={wait}>
            <TypeBar {...rest} />
          </Suspense>
        </ErrorBoundary>
      )}
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
