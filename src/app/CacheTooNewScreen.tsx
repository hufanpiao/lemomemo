// 本机库来自更新的版本（TC-B1-49，接手清单 K6-ver-new）：整屏提示“本机数据是新版本写的，请更新 App”
// • 只给“去更新”（升级中心的 requestUpdate：拉新 SW、接管后重新载入）和“刷新”（重新载入），不给继续使用：
//   这时本机库打不开（cache === null），write.* 一律不写，界面停在这一屏
// • 读屏：role="alertdialog"、aria-modal，标题、说明分别接 aria-labelledby / aria-describedby；打开时焦点落在“去更新”；
//   更新进度、失败用 role="status" 播报
// • 动效：用 src/motion 的 Appear（page 进场）；减少动态效果时不包 Appear，直接出现、不做动画
// 只由 main.tsx 在 boot.status === 'version_too_new' 时懒加载，不进主包
import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { UpgradeCenter } from '../core/upgrade.ts';
import { useT } from '../kit/hooks/useT.ts';
import { Appear, Pressable, useReducedMotionPref } from '../motion/components.ts';
import styles from './CacheTooNewScreen.module.css';

export interface CacheTooNewScreenProps {
  /** coldStart 返回的升级中心（boot.upgrade） */
  upgrade: UpgradeCenter;
  /** “刷新”：重新载入页面（platform/sw-register.ts 的 reloadPage） */
  onRefresh(): void;
}

export function CacheTooNewScreen({ upgrade, onRefresh }: CacheTooNewScreenProps) {
  const t = useT();
  const state = useSyncExternalStore(upgrade.subscribe, upgrade.getState);
  const reduced = useReducedMotionPref();
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    box.current?.querySelector<HTMLButtonElement>('[data-primary]')?.focus();
  }, []);

  const updating = state.update === 'updating';
  const status =
    state.update === 'updating'
      ? t('update.updating', {})
      : state.update === 'failed'
        ? t('update.failed', {})
        : state.update === 'still_old'
          ? t('update.stillOld', {})
          : '';

  const screen = (
    <div
      ref={box}
      className={styles.screen}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="cache-too-new-title"
      aria-describedby="cache-too-new-body"
      data-testid="cache-too-new"
    >
      <div className={styles.card}>
        <h1 id="cache-too-new-title" className={styles.title}>
          {t('update.tooNew.title', {})}
        </h1>
        <p id="cache-too-new-body" className={styles.body}>
          {t('update.tooNew.body', {})}
        </p>
        <div className={styles.actions}>
          <Pressable
            data-primary=""
            className={styles.primary}
            aria-disabled={updating}
            onClick={() => {
              if (!updating) void upgrade.requestUpdate();
            }}
          >
            {t('update.tooNew.update', {})}
          </Pressable>
          <Pressable className={styles.secondary} onClick={onRefresh}>
            {t('update.tooNew.refresh', {})}
          </Pressable>
        </div>
        <p role="status" className={styles.status}>
          {status}
        </p>
      </div>
    </div>
  );

  return reduced ? (
    screen
  ) : (
    <Appear kind="page" show>
      {screen}
    </Appear>
  );
}
