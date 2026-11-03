// 设置 › 电脑 › 快速记录热键（R-297；只在电脑版 exe 显示，网页版和手机没有这一项）
// • 一行：标题“快速记录热键”，右边是现在的热键（Space 显示成“空格 / 스페이스”，spaceLabel 从词典取，A20），下面“更改”“恢复默认”
// • 启动时就没注册上（registered === false）：常驻一句“热键被占用”
// • 点“更改”：变成“按下新的组合键…”的录键框并拿到焦点；Esc 或移开焦点取消；只按修饰键继续等；不能用的组合提示一句
// • 改失败按 invalid、in_use、save_failed、failed 提示（role=alert）；忙的时候两个按钮都不可点
import { useEffect, useRef } from 'react';
import { Pressable } from '../../../motion/components.ts';
import { hotkeyLabel, type HotkeyNotice, type QuickAddHotkey } from '../hooks/useQuickAddHotkey.ts';
import { useSettingsT, type SettingsMsgKey } from '../hooks/useSettingsT.ts';
import styles from './SettingsPage.module.css';

const NOTICE_KEY = {
  invalid: 'settings.hotkey.err.invalid',
  in_use: 'settings.hotkey.err.inUse',
  save_failed: 'settings.hotkey.err.saveFailed',
  failed: 'settings.hotkey.err.failed',
  combo: 'settings.hotkey.err.combo',
} as const satisfies Record<HotkeyNotice, SettingsMsgKey>;

export function DesktopSection({ hotkey }: { hotkey: QuickAddHotkey }) {
  const t = useSettingsT();
  const recRef = useRef<HTMLButtonElement>(null);
  const { status, recording, saving, notice } = hotkey;

  useEffect(() => {
    if (recording) recRef.current?.focus();
  }, [recording]);

  if (!status) return null;
  const label = hotkeyLabel(status.accelerator, t('settings.hotkey.space', {}));
  const isDefault = status.accelerator === status.defaultAccelerator;

  return (
    <section aria-labelledby="settings-desktop-title" data-section="desktop">
      <h2 id="settings-desktop-title" className={styles.gt}>
        {t('settings.desktop.title', {})}
      </h2>
      <ul className={styles.grp}>
        <li className={styles.row}>
          <span id="settings-hotkey-title" className={styles.tx}>
            {t('settings.hotkey.title', {})}
          </span>
          {recording ? (
            <button
              ref={recRef}
              type="button"
              className={styles.btn}
              aria-labelledby="settings-hotkey-title settings-hotkey-rec"
              onKeyDown={(e) => {
                if (hotkey.onKey(e)) {
                  e.preventDefault();
                  e.stopPropagation();
                }
              }}
              onBlur={hotkey.cancelRecording}
              data-testid="settings-hotkey-recorder"
            >
              <span id="settings-hotkey-rec">{t('settings.hotkey.press', {})}</span>
            </button>
          ) : (
            <span className={styles.v} data-testid="settings-hotkey-current">
              {label}
            </span>
          )}
        </li>
      </ul>
      <div className={styles.actions}>
        <Pressable
          className={styles.btn}
          disabled={saving || recording}
          aria-busy={saving}
          onClick={hotkey.startRecording}
          data-testid="settings-hotkey-change"
        >
          {t('settings.hotkey.change', {})}
        </Pressable>
        <Pressable
          className={styles.btn}
          disabled={saving || isDefault}
          onClick={() => void hotkey.resetDefault()}
          data-testid="settings-hotkey-reset"
        >
          {t('settings.hotkey.reset', {})}
        </Pressable>
      </div>
      <p className={styles.sn}>{t('settings.hotkey.note', {})}</p>
      {!status.registered && notice !== 'in_use' ? (
        <p className={styles.error} role="alert" data-testid="settings-hotkey-unregistered">
          {t('settings.hotkey.unregistered', {})}
        </p>
      ) : null}
      {notice ? (
        <p className={styles.error} role="alert" data-testid="settings-hotkey-notice" data-notice={notice}>
          {t(NOTICE_KEY[notice], {})}
        </p>
      ) : null}
    </section>
  );
}
