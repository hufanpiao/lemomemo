// 设置 › 关于 二级页的正文（分组表里排最后；SETTINGS-merge-cards：首页卡 3 一个入口行，点进来是这一页）：
// 卡片里一行“版本 4.0.0”（设计评审 M-1，方案第 2 节和线框“关于 4.0.0 ›”）；农历数据的出处放在卡片下面（R-306：农历、节气数据要注明来自香港天文台；评审 S2）。
// “手机时间不准”（K8-clock）是要马上看到的提醒，不跟着进二级页：设置首页在卡 3 下面直接放（SettingsHome）
// 诊断信息（11-06）：3 秒内连点“版本”那一行 5 下，在卡片下面显示一块纯文字（platform/diag-info.ts 收集；只读、只显示、不上报），再连点 5 下收起。
// 版本那一行仍是只显示的行（不是按钮、不进读屏的可操作列表），点按在外层用监听接住
import { useEffect, useRef, useState } from 'react';
import { SettingsCard, SettingsInfoRow } from '../../../kit/components/Settings/Settings.tsx';
import { collectDiag } from '../../../platform/diag-info.ts';
import { buildInfo } from '../../../platform/env.ts';
import { useSettingsT } from '../hooks/useSettingsT.ts';
import styles from './SettingsPage.module.css';

/** 连点几下、在多长时间内算数 */
export const DIAG_TAPS = 5;
export const DIAG_WINDOW_MS = 3000;

export function AboutSection() {
  const t = useSettingsT();
  const box = useRef<HTMLDivElement | null>(null);
  const [diag, setDiag] = useState<string[] | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    let taps: number[] = [];
    let alive = true;
    let open = false;
    const onClick = (e: MouseEvent): void => {
      if (!(e.target instanceof Element) || !e.target.closest('[data-testid="settings-about-version"]')) return;
      const now = Date.now();
      taps = [...taps.filter((x) => now - x < DIAG_WINDOW_MS), now];
      if (taps.length < DIAG_TAPS) return;
      taps = [];
      open = !open;
      if (!open) {
        setDiag(null);
        return;
      }
      void collectDiag().then((lines) => {
        if (alive && open) setDiag(lines);
      });
    };
    el.addEventListener('click', onClick);
    return () => {
      alive = false;
      el.removeEventListener('click', onClick);
    };
  }, []);
  return (
    <div data-section="about" ref={box}>
      <SettingsCard title={t('settings.about.title', {})} testId="settings-about-card">
        <SettingsInfoRow label={t('settings.about.version', {})} value={buildInfo.version} testId="settings-about-version" valueTestId="settings-about-version-value" />
      </SettingsCard>
      <p className={styles.sn} data-testid="settings-lunar-credit">
        {t('settings.about.lunarCredit', {})}
      </p>
      {diag && (
        <pre className={styles.diag} data-testid="settings-about-diag">
          {diag.join('\n')}
        </pre>
      )}
    </div>
  );
}
