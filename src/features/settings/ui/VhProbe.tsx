// 非正式版诊断区的按钮（AboutSection 在设置 › 关于的诊断打开时挂；正式构建靠 MODE 常量摇掉，build/check_no_probe.mjs 的 PROBE_MARKERS 兜底）。
// 按钮字是英文、不进词典（同诊断区，A20 只管汉字）。Gap fix 没有诊断页开关，日志在全局运行日志里（gapfix 开头的行）
// • Test haptic：点一下震一下，按钮上写震动走的哪条路（switch：iOS 18 系统开关，触感由按钮里的 TapSwitch 出，和左滑“删除”同一套；
//   vibrate：navigator.vibrate；none：都没有）
// • Gemini live（platform/live-audio.ts 的 geminiLiveOn）：默认 ON，按住“＋”走 Gemini 实时转写、边说边出字；
//   点成 OFF 这次打开 App 只用录音上传，对照用（日志 voice hold start 的 gm=、probe gemini live on=）。三个开关共用 DiagToggle
// • Fx warm（platform/feedback.ts 的 fxWarmOn）：默认 ON，点成 OFF 这次打开 App 不预先建放音上下文（首屏、收完音都不建），
//   对照语音出不出字；日志 probe fx warm on=、fx audio close / closed ms=
// • Deep diag（platform/diag-deep.ts）：默认 OFF，点成 ON 以后运行日志多记切回前台的模糊层数（vis-frames blur=）
//   和每次换页的头像状态（swap pin）；这两项开销大，平时不算。同 Gemini live 只管这次打开 app
// • Finger switch：一个看得见的 iOS 系统开关 <input type="checkbox" switch>，让人用手指点：
//   手指点都不震 = 系统触感反馈关着或这台机器不支持，代码改不了；手指点震、Test haptic 不震 = TapSwitch 那套没接对。改变时记 probe finger switch on=
//   （iOS 真机上代点系统开关的写法都不震，只有手指点才震）
// • 全局运行日志的“Send run log”“Copy run log”“Clear run log”11-28 起挪到 RunLogButtons.tsx（正式版也有，负责人 11-28 选“正式版也带”），不在这里
import { useState } from 'react';
import { FormButton } from '../../../kit/components/Form.tsx';
import { TapSwitch } from '../../../kit/components/TapSwitch.tsx';
import { fxWarmOn, setFxWarmOn, tryHaptic, type HapticPath } from '../../../platform/feedback.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { deepDiagOn, setDeepDiagOn } from '../../../platform/diag-deep.ts';
import { geminiLiveOn, setGeminiLiveOn } from '../../../platform/live-audio.ts';
import styles from './SettingsPage.module.css';

/** 试震动（platform/feedback.ts 的 tryHaptic；不看“声音和触感”开关）：按过以后写 Haptic: switch / vibrate / none */
export const HAP_TRY = 'Test haptic';
export const HAP_DONE = 'Haptic: ';
/** 手指点的系统开关 */
export const FS_LABEL = 'Finger switch';
/** 深度诊断（platform/diag-deep.ts）：默认关，打开后运行日志多记回前台模糊层数、换页头像状态（开销大，只在查这两个问题时开） */
export const DD_LABEL_ON = 'Deep diag: ON';
export const DD_LABEL_OFF = 'Deep diag: OFF';
/** 预建放音上下文（platform/feedback.ts 的 fxWarmOn）：默认 ON，点成 OFF 这次打开 App 不预建，对照系统识别出不出字 */
export const FW_LABEL_ON = 'Fx warm: ON';
export const FW_LABEL_OFF = 'Fx warm: OFF (compare)';

/** 按住“＋”走 Gemini 实时转写的对照开关（platform/live-audio.ts 的 geminiLiveOn）：默认 ON，点成 OFF 这次打开 App 只用录音上传 */
export const GL_LABEL_ON = 'Gemini live: ON';
export const GL_LABEL_OFF = 'Gemini live: OFF (compare)';

/** 诊断开关的通用一颗：点一下翻转、存下，按钮上照读回的值写（Fx warm、Deep diag、Gemini live 共用） */
function DiagToggle(p: {
  readonly id: string;
  readonly on: string;
  readonly off: string;
  readonly get: () => boolean;
  readonly set: (on: boolean) => void;
  readonly log?: (on: boolean) => void;
}) {
  const [v, setV] = useState(p.get);
  return (
    <FormButton
      size="compact"
      aria-pressed={v}
      data-testid={p.id}
      onClick={() => {
        p.set(!v);
        const now = p.get();
        setV(now);
        p.log?.(now);
      }}
    >
      {v ? p.on : p.off}
    </FormButton>
  );
}

export function VhProbe() {
  const [hap, setHap] = useState<HapticPath | null>(null);
  return (
    <div data-testid="settings-vh-probe">
      <div className={`${styles.actions} ${styles.probeActions}`}>
        {/* 在点按里同步震一下，按钮上写走的哪条路；iOS 上由按钮里的真开关 TapSwitch 出触感，和左滑“删除”同一套 */}
        <FormButton size="compact" data-testid="vh-haptic" onClick={() => setHap(tryHaptic())}>
          {hap === null ? HAP_TRY : `${HAP_DONE}${hap}`}
          <TapSwitch />
        </FormButton>
      </div>
      <div className={`${styles.actions} ${styles.probeActions}`}>
        <DiagToggle id="vh-gemini-live" on={GL_LABEL_ON} off={GL_LABEL_OFF} get={() => geminiLiveOn()} set={(v) => setGeminiLiveOn(v)} log={(v) => rlog(`probe gemini live on=${v ? 1 : 0}`)} />
        <DiagToggle id="vh-fx-warm" on={FW_LABEL_ON} off={FW_LABEL_OFF} get={fxWarmOn} set={setFxWarmOn} log={(v) => rlog(`probe fx warm on=${v ? 1 : 0}`)} />
        <DiagToggle id="vh-deep-diag" on={DD_LABEL_ON} off={DD_LABEL_OFF} get={deepDiagOn} set={setDeepDiagOn} />
        {/* switch 属性 React 不认识，挂上以后用 ref 补；不受控，只为让手指点一下看震不震 */}
        <label className={styles.probeSwitch}>
          <input
            type="checkbox"
            data-testid="vh-finger-switch"
            ref={(el) => el?.setAttribute('switch', '')}
            onChange={(e) => rlog(`probe finger switch on=${e.currentTarget.checked ? 1 : 0}`)}
          />
          {FS_LABEL}
        </label>
      </div>
    </div>
  );
}
