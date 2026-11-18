// 录音面板（B3 FA-3；皮肤视觉稿 PH.rec，定稿线框“按住‘＋’说话”RECPREP / REC / 锁定后 / RECFB）
// • 准备中（按下瞬间，录音器还没 start）：“开始录音 0:00”“说吧”，声波压平、淡一些
// • 录音中：计时“0:07 / 1:00”，50 秒起换成“还剩 N 秒”（架构 5.11 第 2 点；线框没画，写在计时同一位置）；只有声波和计时，不出文字；
//   右下话筒、上面“↑ 拖到这里取消”、左下“← 拖到这里：松手也继续录”（两个区的位置由 useVoice 拿 ref 去量，手指进区高亮）
// • 锁定后：标题“已锁定，松开手也在录”，去掉两个区和话筒，底部“取消 / 记下”两颗 52px 按钮；Esc 等于“取消”
// • 手机自带识别（额度用完、网络慢、没开 AI、“再说一次”）：标题下多一行原因（线框 RECFB），说明文字换成“这次只听中文…”
// • 计时、声波每帧（motion 的 eachFrame，A25）直接写 DOM（textContent、CSSOM transform；CSP 不准内联 style 属性），不走 React 状态：录着时面板不跟着每帧重渲染
// • 边说边出字（R-456，部分取代上面“只有声波和计时，不出文字”）：手机自带识别那一路认出了字，计时上方一个大文字框，
//   深色底浅色字（令牌 --img-badge-bg / --img-badge-fg，两套皮肤、深浅色都是深底白字），字往后追加、框里滚到最新一行；没认出字不出这个框
// • 进出：<Appear kind="scrim" / "sheet">（--dur-sheet + --ease-drawer；减少动态效果只淡入淡出，17.4）
import { useEffect, useLayoutEffect, useRef } from 'react';
import { FormButton } from '../../../kit/components/Form.tsx';
import { useLayer } from '../../../kit/hooks/useLayer.ts';
import { Appear, eachFrame } from '../../../motion/components.ts';
import { fmtClock, recCountdown, type VoiceState } from '../hooks/useVoice.ts';
import { useLangNames, usePlusT } from '../hooks/usePlusT.ts';
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
  const { lang, other } = useLangNames();
  const show = v.capturing;
  const prep = v.status === 'preparing';
  // 识别主路（why=live，11-18 起有系统识别就走它）和录音一样：边说边出字、标题副标题用录音的；只有额度、网慢、没开 AI、再说一次才用识别的说明
  const speech = v.path === 'speech' && v.why !== 'live';
  const clock = useRef<HTMLElement>(null);
  const max = useRef<HTMLSpanElement>(null);
  const wave = useRef<HTMLDivElement>(null);
  const said = useRef<HTMLDivElement>(null);
  const live = useRef(v);
  live.current = v;
  // 认出了字就出框，不分哪种原因走的识别（11-19：额度用完、网慢、没开 AI、再说一次这几种识别认出了字，原来被 !speech 挡掉不出框）
  const text = show ? v.live : '';

  // 边说边出字：字多了框里滚到最新一行
  useLayoutEffect(() => {
    const el = said.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);

  // 锁定录音时是层栈里的一层（kit/hooks/layers.ts）：Esc 只在它是栈顶时丢掉这段录音
  useLayer(show && v.locked, { name: 'rec-lock', onEsc: () => v.discard(), back: () => [] });

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
          {text === '' ? null : (
            <div ref={said} className={styles.said} role="log" aria-live="off" aria-label={t('plus.rec.live', {})} data-testid="rec-live">
              {text}
            </div>
          )}
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
