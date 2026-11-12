// 录音面板（B3 FA-3；皮肤视觉稿 PH.rec，定稿线框“按住‘＋’说话”RECPREP / REC / 锁定后 / RECFB）
// • 准备中（按下瞬间，录音器还没 start）：“开始录音 0:00”“说吧”，声波压平、淡一些
// • 录音中：计时“0:07 / 1:00”，50 秒起换成“还剩 N 秒”（架构 5.11 第 2 点；线框没画，写在计时同一位置）；只有声波和计时，不出文字；
//   右下话筒、上面“↑ 拖到这里取消”、左下“← 拖到这里：松手也继续录”（两个区的位置由 useVoice 拿 ref 去量，手指进区高亮）
// • 锁定后：标题“已锁定，松开手也在录”，去掉两个区和话筒，底部“取消 / 记下”两颗 52px 按钮；Esc 等于“取消”
// • 手机自带识别（额度用完、网络慢、没开 AI、“再说一次”）：标题下多一行原因（线框 RECFB），说明文字换成“这次只听中文…”
// • 计时、声波每帧（motion 的 eachFrame，A25）直接写 DOM（textContent、CSSOM transform；CSP 不准内联 style 属性），不走 React 状态：录着时面板不跟着每帧重渲染
// • 进出：<Appear kind="scrim" / "sheet">（--dur-sheet + --ease-drawer；减少动态效果只淡入淡出，17.4）
import { useEffect, useRef } from 'react';
import { FormButton } from '../../../kit/components/Form.tsx';
import { useKeys } from '../../../kit/hooks/useKeys.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { Appear, eachFrame } from '../../../motion/components.ts';
import { fmtClock, recCountdown, type VoiceState } from '../hooks/useVoice.ts';
import { usePlusT } from '../hooks/usePlusT.ts';
import { MicGlyph } from './MicGlyph.tsx';
import styles from './RecordPanel.module.css';

/** 声波几根（视觉稿 waveBars 34 根） */
export const WAVE_BARS = 34;
/** 量不到音量时（手机自带识别没有音量计）画视觉稿的那一排高度，不假装在动 */
const STILL = [14, 26, 38, 22, 44, 30, 18, 40, 52, 28, 16, 34, 46, 24, 12, 30, 42, 20, 36, 48, 26, 14, 32, 44, 22, 38, 18, 28, 40, 16, 24, 34, 20, 12];
const BAR_PX = 52;
const BAR_KEYS = STILL.slice(0, WAVE_BARS).map((_, i) => `w${String(i)}`);
const FLAT = 4 / BAR_PX;

export function RecordPanel({ v }: { v: VoiceState }) {
  const t = usePlusT();
  const locale = useUi((s) => s.locale);
  const show = v.status === 'preparing' || v.status === 'recording' || v.status === 'listening';
  const prep = v.status === 'preparing';
  const speech = v.path === 'speech';
  const clock = useRef<HTMLElement>(null);
  const max = useRef<HTMLSpanElement>(null);
  const wave = useRef<HTMLDivElement>(null);
  const live = useRef(v);
  live.current = v;

  useKeys({
    Escape: () => {
      if (!show || !v.locked) return false;
      v.discard();
      return true;
    },
  });

  // 每帧：计时、倒数、声波（只写 DOM）
  useEffect(() => {
    if (!show) return undefined;
    const bars = [...(wave.current?.querySelectorAll('i') ?? [])];
    const hist: number[] = Array.from({ length: bars.length }, () => FLAT);
    let last = '';
    const frame = (): void => {
      const cur = live.current;
      const ms = cur.status === 'preparing' ? 0 : cur.elapsed();
      const left = recCountdown(ms);
      const shown = left === null ? fmtClock(ms) : t('plus.rec.left', { n: left });
      if (shown !== last) {
        last = shown;
        if (clock.current) clock.current.textContent = shown;
        if (max.current) max.current.hidden = left !== null;
      }
      const lv = cur.status === 'preparing' ? -2 : cur.level();
      if (lv >= 0) {
        hist.shift();
        hist.push(Math.max(FLAT, Math.min(1, 0.12 + lv)));
      }
      bars.forEach((b, i) => {
        const h = lv === -2 ? FLAT : lv < 0 ? (STILL[i] ?? BAR_PX) / BAR_PX : (hist[i] ?? FLAT);
        b.style.setProperty('transform', `scaleY(${h.toFixed(3)})`);
      });
    };
    frame();
    return eachFrame(frame);
  }, [show, t]);

  const lang = t(locale === 'ko-KR' ? 'plus.lang.ko' : 'plus.lang.zh', {});
  const other = t(locale === 'ko-KR' ? 'plus.lang.zh' : 'plus.lang.ko', {});
  const label = prep ? 'plus.rec.prep' : v.locked ? 'plus.rec.locked' : 'plus.rec.on';
  const head = prep ? t('plus.rec.say', {}) : !speech ? t('plus.rec.head', {}) : t(v.locked ? 'plus.rec.headAgain' : 'plus.rec.headSpeech', {});
  const sub = speech
    ? t('plus.rec.subSpeech', { lang, other })
    : prep
      ? t('plus.rec.head', {})
      : t('plus.rec.sub', {});
  const why = v.why === 'quota' ? t('plus.rec.whyQuota', { lang }) : v.why === 'net' ? t('plus.rec.whyNet', {}) : null;
  const zones = !prep && !v.locked;

  return (
    <>
      <Appear kind="scrim" show={show} className={styles.scrim}>
        {null}
      </Appear>
      <Appear kind="sheet" show={show} className={styles.dock}>
        <section className={styles.sheet} data-locked={v.locked ? '' : undefined} aria-label={t('plus.rec.label', {})} data-testid="rec-panel" data-status={v.status}>
          <div className={styles.hdr}>
            <span>
              <span className={styles.dot} aria-hidden="true" />
              {t(label, {})}
            </span>
            <span className={styles.clock}>
              <b ref={clock} role="timer" data-testid="rec-clock" />
              <span ref={max} className={styles.muted}>
                {' '}
                {t('plus.rec.max', {})}
              </span>
            </span>
          </div>
          {why === null ? null : (
            <div className={styles.why} data-testid="rec-why">
              {why}
            </div>
          )}
          <h4 className={styles.head}>{head}</h4>
          <div className={styles.sub}>{sub}</div>
          <div ref={wave} className={styles.wave} data-flat={prep ? '' : undefined} aria-hidden="true">
            {BAR_KEYS.map((k) => (
              <i key={k} />
            ))}
          </div>
          {zones ? (
            <>
              <div
                ref={v.cancelZone}
                className={`${styles.zone} ${styles.cancelZone}`}
                data-on={v.zone === 'cancel' ? '' : undefined}
                data-testid="rec-cancel-zone"
              >
                {t('plus.rec.cancelZone', {})}
              </div>
              <div ref={v.lockZone} className={`${styles.zone} ${styles.lockZone}`} data-on={v.zone === 'lock' ? '' : undefined} data-testid="rec-lock-zone">
                {t('plus.rec.lockZone', {})}
              </div>
            </>
          ) : null}
          {v.locked ? (
            <div className={styles.acts}>
              <FormButton type="button" onClick={v.discard} data-testid="rec-cancel">
                {t('plus.rec.cancel', {})}
              </FormButton>
              <FormButton type="button" variant="primary" onClick={v.finish} data-testid="rec-done">
                {t('plus.rec.done', {})}
              </FormButton>
            </div>
          ) : (
            <div className={styles.mic} aria-hidden="true">
              <MicGlyph />
            </div>
          )}
        </section>
      </Appear>
    </>
  );
}
