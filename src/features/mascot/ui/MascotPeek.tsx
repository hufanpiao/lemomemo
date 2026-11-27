// 输入框小人 #11：身体下沿贴输入框上沿，手扒在框里；打字时切 writingSent，停手 1 秒切回
import { useEffect, useRef } from 'react';
import { rlog } from '../../../platform/run-log-api.ts';
import { PEEK } from '../hooks/mascot-data.ts';
import { createStage } from '../hooks/stage.ts';
import s from './Mascot.module.css';

const ONLINE_DELAY_MS = 400;
const TYPING_MS = 1000;

/** kind="warm"：什么都不画，只让懒加载提前走完（plus 的 TypeBarPreload 首屏后挂一份）。只提前 import 不够：lazy 第一次渲染照样挂起，
 *  React 约 0.3 秒后才重试，冷启动第一次聚焦时键盘已弹出才挂上，光标位置不对 */
export default function MascotPeek({ kind }: { kind: 'chat' | 'plus' | 'warm' }) {
  return kind === 'warm' ? null : <Peek kind={kind} />;
}

function Peek({ kind }: { kind: 'chat' | 'plus' }) {
  const rv = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = rv.current;
    const root = box.current;
    if (!el || !root) return undefined;
    let online: ReturnType<typeof setTimeout> | undefined;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const st = createStage(el, PEEK, {
      onReady() {
        rlog(`mascot peek ready at=${kind}`);
        online = setTimeout(() => st.setBool('onlineOffline', true), ONLINE_DELAY_MS);
      },
      onFail() {
        rlog(`mascot peek fail at=${kind}`);
        root.hidden = true;
      },
    });
    const form = root.closest('form');
    const onInput = (): void => {
      st.setBool('writingSent', true);
      clearTimeout(idle);
      idle = setTimeout(() => st.setBool('writingSent', false), TYPING_MS);
    };
    const onSubmit = (): void => {
      clearTimeout(idle);
      st.setBool('writingSent', false);
    };
    form?.addEventListener('input', onInput);
    form?.addEventListener('submit', onSubmit);
    return () => {
      clearTimeout(online);
      clearTimeout(idle);
      form?.removeEventListener('input', onInput);
      form?.removeEventListener('submit', onSubmit);
      st.destroy();
    };
  }, [kind]);
  return (
    <div ref={box} className={`${s['peek']} ${kind === 'chat' ? s['peekChat'] : s['peekPlus']}`} aria-hidden="true" data-testid={`mascot-peek-${kind}`}>
      <div ref={rv} className={s['peekRv']} />
    </div>
  );
}
