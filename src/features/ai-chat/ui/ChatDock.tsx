// 网页版右边常驻的 AI 助手栏（“助手常驻”方案；唯一参考 本机资料/01-设计方案/2026-11-24_网页端日历待办改善/web-layout-plan.html 的 .ai）
// • 只在宽屏（kit useMedia 的 MQ_DESK_WIDE）、路由表 LEVELS 写了 dock 的页挂（今天、日历、待办、随手记、纪念日列表、设置、最近删除；app/router.ts 的 dockOf，ChatHost.tsx 判断），位置照 base.css 的 --dk-* 定：
//   宽 340（iPad 横屏窄档 288）、离窗口右边 16，上沿和左边内容卡片齐平（页头下面），下沿和卡片底齐平（高度要和其他卡片齐平）
// • 顶上：吉祥物光球（features/mascot 的 MascotMini；运行库、wasm、.riv 栏挂上才下载，下不来退回小脸） + “AI 助手” + 一行“在看今天 / 日历 / ……”；下面是和半屏抽屉同一份的对话区、建议问题、输入条（ChatBody.tsx）
// • 常驻栏开着时“＋”点“问 AI”、长按吉祥物交来的一句（hooks/chat-open.ts）不再开半屏，直接在这里问；空的一句只把光标放进输入框
// • 在这些页之间切换不重挂（ChatHost 在同一个位置画它），对话接着看；去没有常驻栏的页（编辑页、隐私记……）时卸下，卸下取消正在问的那一句（同抽屉关上）
// • 运行日志：chat dock on / off、chat open from=… dock=1
import { Suspense, useEffect, useRef, useState } from 'react';
import type { DockPage } from '../../../app/router.ts';
import { QuietBoundary } from '../../../kit/components/QuietBoundary.tsx';
import { useUi } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { MascotMini } from '../../mascot/index.ts';
import { closeChat, type ChatOpen, type ChatOpenReq } from '../hooks/chat-open.ts';
import { chat } from '../hooks/useChat.ts';
import { ChatBody } from './ChatBody.tsx';
import { useChatT } from './chat-parts.tsx';
import s from './ChatDrawer.module.css';

/** 每页三个建议问题（词典 chat.dock.<页>.1～3） */
const CHIPS = [1, 2, 3] as const;

const noop = (): void => undefined;

/** 标题前放吉祥物里的光球（词条 mascot.name.7） */
const ORB = '7';
/**
 * 光球本体撑满盒子的 32 高（和退路小脸一样高）。目录里的裁切 [10,0,380,380] 连外圈淡光和留白，缩进来本体只有约 20px；
 * 量过 400 画板里不透明（alpha>40）的本体：呼吸时 x 95～313、y 87～313，平均约 207 见方 → 以最大时 226 见方为准，最大正好 32 高、平时约 29～31，外圈淡光略出盒子
 */
const ORB_CROP = [91, 87, 226, 226] as const;
/** 光球的分包下不来时退回小脸（同 MascotMini 自己下不来时的 data-state） */
const face = <span className={s.orb} data-state="fail" aria-hidden="true" />;

export default function ChatDock({ open, page }: { open: ChatOpen | null; page: DockPage }) {
  const t = useChatT();
  const locale = useUi((x) => x.locale);
  const [memOpen, setMemOpen] = useState(false);
  const [record, setRecord] = useState<ChatOpenReq['record']>(null);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t0 = clock.now();
    rlog('chat dock on');
    return () => {
      chat.abort();
      rlog(`chat dock off ms=${clock.now() - t0} turns=${chat.get().turns.length}`);
    };
  }, []);

  // “＋”点“问 AI”、长按吉祥物：这一句在常驻栏里问，交完就把打开信号清掉（ChatHost 不会再画半屏）
  useEffect(() => {
    if (open === null) return;
    const { req } = open;
    rlog(`chat open from=${req.from} dock=1 turns=${chat.get().turns.length}`);
    setRecord(() => req.record);
    if (req.ask !== '') void chat.send(req.ask, locale, req.onAnswered ?? undefined);
    else field.current?.focus();
    closeChat();
  }, [open, locale]);

  const chips = CHIPS.map((i) => t(`chat.dock.${page}.${i}`, {}));
  return (
    <aside className={s.dock} aria-label={t('chat.label', {})} data-testid="chat-dock">
      <div className={s.dh}>
        <QuietBoundary name="chat-dock-orb" fallback={face}>
          <Suspense fallback={<span className={s.orb} aria-hidden="true" />}>
            <MascotMini id={ORB} className={s.orb} crop={ORB_CROP} />
          </Suspense>
        </QuietBoundary>
        <div>
          <b>{t('chat.label', {})}</b>
          <span>{t(`chat.dock.${page}`, {})}</span>
        </div>
      </div>
      <ChatBody compact={false} close={noop} onLeave={noop} record={record} memOpen={memOpen} setMemOpen={setMemOpen} chips={chips} fieldRef={field} />
    </aside>
  );
}
