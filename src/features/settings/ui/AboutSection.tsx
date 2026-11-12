// 设置 › 关于 二级页的正文（分组表里排最后；SETTINGS-merge-cards：首页卡 3 一个入口行，点进来是这一页）：
// 卡片里一行“版本 4.0.0”（设计评审 M-1，方案第 2 节和线框“关于 4.0.0 ›”）；农历数据的出处放在卡片下面（R-306：农历、节气数据要注明来自香港天文台；评审 S2）。
// “手机时间不准”（K8-clock）是要马上看到的提醒，不跟着进二级页：设置首页在卡 3 下面直接放（SettingsHome）
// 诊断信息（11-06）：3 秒内连点“版本”那一行 5 下，在卡片下面显示一块纯文字（platform/diag-info.ts 收集；只读、只显示、不上报），再连点 5 下收起。
// 11-10 R-371：诊断开着且不是正式版时，下面挂 VhProbe（非正式版诊断按钮：冷启动时间线、Gap fix 对照开关、运行日志）；正式构建靠 MODE 常量摇掉，build/check_no_probe.mjs 的 PROBE_MARKERS 登记了 vh-probe 兜底
// 诊断开着时 <html> 带 data-diag="1"：顶部显示红、蓝两个小色条（base.css .lemo-probe，真机验证顶部回弹），离开设置页也留着，再连点 5 下或重开 App 才没
// 版本那一行仍是只显示的行（不是按钮、不进读屏的可操作列表），点按在外层用监听接住
// 录音探测入口（B3 FA-0，11-10）：主屏幕版没有地址栏、Safari 网页版又不能登录，负责人进不了 #/dev-csp/voice，
//   只在非正式版的卡片里多一行“录音探测（试验）”；用构建期常量 import.meta.env.MODE 挡（同 App.tsx 挂试验页），正式构建整块删掉。
// 诊断按钮（VhProbe.tsx）：诊断开着时在诊断文字下面，同样只在非正式版里有
//   录音探测的文案在词条 settings.about.probe（A20 不准在组件里写汉字；正式版里只剩词典里这一句、没有这一行）；testid 带 check_no_probe.mjs 的标记 csp-lab，正式产物里残留就失败。和 voice-probe 同一个 PR 删
import { useEffect, useRef, useState } from 'react';
import { navigateSub } from '../../../app/router-sub.ts';
import { SettingsCard, SettingsEntryRow, SettingsInfoRow } from '../../../kit/components/Settings/Settings.tsx';
import { collectDiag } from '../../../platform/diag-info.ts';
import { buildInfo } from '../../../platform/env.ts';
import { useSettingsT } from '../hooks/useSettingsT.ts';
import styles from './SettingsPage.module.css';
import { VhProbe } from './VhProbe.tsx';

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
    // 诊断开没开跟着 data-diag（跨页留着）：回到这一页时还开着就把文字也显示出来，连点 5 下关掉
    let open = document.documentElement.dataset['diag'] === '1';
    if (open) {
      void collectDiag().then((lines) => {
        if (alive && open) setDiag(lines);
      });
    }
    const onClick = (e: MouseEvent): void => {
      if (!(e.target instanceof Element) || !e.target.closest('[data-testid="settings-about-version"]')) return;
      const now = Date.now();
      taps = [...taps.filter((x) => now - x < DIAG_WINDOW_MS), now];
      if (taps.length < DIAG_TAPS) return;
      taps = [];
      open = !open;
      if (open) document.documentElement.dataset['diag'] = '1';
      else document.documentElement.removeAttribute('data-diag');
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
        {import.meta.env.MODE !== 'production' && (
          <SettingsEntryRow label={t('settings.about.probe', {})} onOpen={() => void navigateSub('dev-csp', 'voice')} testId="csp-lab-entry" />
        )}
      </SettingsCard>
      <p className={styles.sn} data-testid="settings-lunar-credit">
        {t('settings.about.lunarCredit', {})}
      </p>
      {diag && (
        <pre className={styles.diag} data-testid="settings-about-diag">
          {diag.join('\n')}
        </pre>
      )}
      {/* 非正式版诊断按钮（VhProbe.tsx）：诊断开着、非正式版才有；正式构建整块删掉 */}
      {diag && import.meta.env.MODE !== 'production' && <VhProbe />}
    </div>
  );
}
