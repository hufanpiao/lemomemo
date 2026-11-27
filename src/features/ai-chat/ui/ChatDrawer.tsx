// AI 助手对话抽屉（照定稿方案页“方向 B 半屏抽屉”和对话各状态的截图）：手机和窄窗口用；网页版宽屏、路由表写了 dock 的页是右边常驻栏（ChatDock.tsx）
// • 外壳是 kit HalfSheet：离顶约 27% 的半屏，拖把手往上拉满、往下关；键盘弹着时拉满（platform/viewport 的 watchKeyboard）
// • 顶上三栏：左“✕ 关闭”，中“AI 助手”，右“记住的事”（进 MemoryPage，盖在抽屉上、抽屉拉满）
// • 对话区、输入条、点开条目、记住的事在 ChatBody.tsx（常驻栏同一份）
// • 挂上时带着一句（“＋”点“问 AI”交来的）就直接问
// • 关：“✕ 关闭”、点后面、Esc、往下拖都走 HalfSheet 带退场的 close（children 拿到它）；卸下时 chat.abort() 真的取消正在问的那一句
// • 运行日志：chat open / close（从哪来、开了多久、几轮）；问答那边的见 hooks/useChat.ts
import { useEffect, useState } from 'react';
import { HalfSheet, type SheetStop } from '../../../kit/components/HalfSheet.tsx';
import { SheetTop } from '../../../kit/components/SheetTop.tsx';
import { useUi } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { isKeyboardOpen, watchKeyboard } from '../../../platform/viewport.ts';
import type { ChatOpen } from '../hooks/chat-open.ts';
import { chat } from '../hooks/useChat.ts';
import { ChatBody } from './ChatBody.tsx';
import { useChatT } from './chat-parts.tsx';

export default function ChatDrawer({ open, onClose }: { open: ChatOpen; onClose(): void }) {
  const t = useChatT();
  const locale = useUi((x) => x.locale);
  const [kb, setKb] = useState(isKeyboardOpen);
  useEffect(() => watchKeyboard((o) => setKb(o)), []);
  const [stop, setStop] = useState<SheetStop>('half');
  const [memOpen, setMemOpen] = useState(false);
  const req = open.req;

  useEffect(() => {
    const t0 = clock.now();
    rlog(`chat open from=${req.from} turns=${chat.get().turns.length}`);
    if (req.ask !== '') void chat.send(req.ask, locale, req.onAnswered ?? undefined);
    return () => {
      chat.abort();
      rlog(`chat close ms=${clock.now() - t0} turns=${chat.get().turns.length}`);
    };
    // 每次打开（open.n 换了 key 重新挂）只问一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <HalfSheet label={t('chat.label', {})} onClose={onClose} full={kb || memOpen} onStop={setStop} log={rlog} tag="chat">
      {(close) => (
        <>
          <SheetTop
            title={t('chat.label', {})}
            left={{ kind: 'close', label: t('chat.close', {}), onClick: close, testId: 'chat-close' }}
            right={{ label: t('chat.mem.entry', {}), onClick: () => setMemOpen(true), testId: 'chat-mem-open' }}
          />
          <ChatBody compact={stop === 'half'} close={close} onLeave={onClose} record={req.record} memOpen={memOpen} setMemOpen={setMemOpen} />
        </>
      )}
    </HalfSheet>
  );
}
