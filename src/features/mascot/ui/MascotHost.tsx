// 今天页的吉祥物（首屏画完以后由 plus 的 TypeBarPreload 挂，不进首屏闭包）：找到“现在”卡，贴一层在它上面
// • 这一层放在卡片后面（卡片自己裁到圆角，放里面伸不出去），位置和大小跟着卡片；层级在今天页内容之上、底栏和弹层之下
// • 运行日志只记 id 和状态
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRoute } from '../../../app/router.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import { RLOG_ON, rlog } from '../../../platform/run-log-api.ts';
import { loadChatOpen } from '../../ai-chat/index.ts';
import { DEFAULT_MASCOT, PRIVATE_ID, defOf, type MascotChoice, type MascotRow } from '../hooks/mascot-data.ts';
import { cardClipPath, inCardClip, overClipPath, watchGesture } from '../hooks/gesture.ts';
import { mascotSession } from '../hooks/mascot-session.ts';
import { createStage, type MoodFlag, type ReactKind, type Stage } from '../hooks/stage.ts';
import { useMascotChoice } from '../hooks/useMascotChoice.ts';
import { useMascotReactions } from '../hooks/useMascotReactions.ts';
import s from './Mascot.module.css';

// 这次打开 App 的状态（降落过没有、留着的舞台）在 hooks/mascot-session.ts 的 mascotSession，只在内存
// • 留着的舞台：进二级页再回来时吉祥物要一直在，不能消失一下再出来。每次回今天页都重新下载重建的话（#2 走网络要上百到上千毫秒），中间是空的。
//   所以离开今天页只把这一层从页面上摘下、舞台不销毁，回来接到新的卡片后面；换了角色才销毁（#2 的文件照旧不进任何缓存）
// • 第一次出现不额外等：页面一出来吉祥物就开始降落（负责人 11-27 定）。这个组件不走 lazy（见 plus 的 TypeBarPreload）

/** 时间尺下面多出来的行（“下一件 08:00 起床 · …”“明天 …”）把卡片撑高了多少：卡片内容区底边减时间尺（含下外边距）的底边；
 *  没有这些行是 0。不逐个数后面的元素：背景流动层也排在时间尺后面，但它是绝对定位、不占高度 */
const belowRuler = (card: HTMLElement): number => {
  const ruler = card.querySelector<HTMLElement>('[data-testid="now-ruler"]');
  const box = ruler?.parentElement;
  if (!ruler || !box) return 0;
  const bs = getComputedStyle(box);
  const inner = box.getBoundingClientRect().bottom - (parseFloat(bs.paddingBottom) || 0) - (parseFloat(bs.borderBottomWidth) || 0);
  return Math.max(0, Math.round(inner - ruler.getBoundingClientRect().bottom - (parseFloat(getComputedStyle(ruler).marginBottom) || 0)));
};

const firstCard = (): HTMLElement | null => [...document.querySelectorAll<HTMLElement>('[data-testid="now-card"]')].find((c) => c.offsetWidth > 0) ?? null;

function Hero({ id, onPrivateFail }: { id: MascotChoice; onPrivateFail(): void }) {
  const stage = useRef<Stage | null>(null);
  const fire = useCallback((k: ReactKind) => {
    rlog(`mascot react id=${id} k=${k}`);
    stage.current?.react(k);
  }, [id]);
  /** 持续状态先记下：反应钩子的副作用比下面建舞台的早跑，舞台建好、接回时再补上 */
  const flags = useRef<Partial<Record<MoodFlag, boolean>>>({});
  const flag = useCallback((f: MoodFlag, on: boolean) => {
    flags.current[f] = on;
    stage.current?.flag(f, on);
  }, []);
  useMascotReactions(fire, flag);
  useEffect(() => {
    const def = defOf(id);
    const over = def.over === true;
    // 留着的那一份是同一个角色就接回来用，不是就销毁
    const { kept } = mascotSession;
    const reuse = kept?.id === id ? kept : null;
    if (kept && !reuse) kept.stage.destroy();
    mascotSession.kept = null;
    const anchor = reuse?.anchor ?? document.createElement('div');
    const rv = reuse?.rv ?? document.createElement('div');
    const applyFlags = (st: Stage): void => {
      for (const [f, on] of Object.entries(flags.current) as [MoodFlag, boolean][]) st.flag(f, on);
    };
    if (reuse) {
      stage.current = reuse.stage;
      applyFlags(reuse.stage);
      rlog(`mascot keep id=${id}`);
    } else {
      anchor.className = s['anchor'] ?? '';
      anchor.dataset['testid'] = 'mascot';
      anchor.dataset['mascot'] = id;
      // 切页时旧页快照带上吉祥物当前这一帧，不空一下（motion/copy-node.ts 的 COPY_PIXELS_ATTR）
      anchor.setAttribute('data-copy-pixels', '');
      anchor.setAttribute('aria-hidden', 'true');
      rv.className = `${s['rv'] ?? ''} ${over ? (s['over'] ?? '') : ''}`;
      // 只限右边的盒子（Mascot.module.css 的 .bleed）：画布不撑宽页面，左、上、下（出格角色）照样能出卡片
      const bleed = document.createElement('div');
      bleed.className = `${s['bleed'] ?? ''} ${over ? (s['bleedOver'] ?? '') : ''} ${def.ride === true ? (s['ride'] ?? '') : ''}`;
      bleed.appendChild(rv);
      anchor.appendChild(bleed);
    }
    let card: HTMLElement | null = null;
    let radius = 0;
    let t0 = 0;
    // 查位置偏离用：卡片尺寸变、舞台就绪时记一行位置（只记数字）。
    // h 卡高、top 卡顶离文档顶、dy 层顶减卡顶、dh 层高减卡高、rv 角色框高、rvb 卡底减角色框底、edge 主屏幕 App 的 --edge-clear、lift 时间尺下面多出来的高度（ride 角色往上抬这么多）
    const pos = (): void => {
      // 正式版不记运行日志：不读这几块的位置（每次卡片尺寸变都会调）
      if (!card || !RLOG_ON) return;
      const c = card.getBoundingClientRect();
      const a = anchor.getBoundingClientRect();
      const r = rv.getBoundingClientRect();
      const edge = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--edge-clear')) || 0;
      const n = (v: number): number => Math.round(v);
      rlog(`mascot pos h=${n(c.height)} top=${n(c.top + window.scrollY)} dy=${n(a.top - c.top)} dh=${n(a.height - c.height)} rv=${n(r.height)} rvb=${n(c.bottom - r.bottom)} edge=${n(edge)} lift=${belowRuler(card)}`);
    };
    // 位置靠 NowCard 外面的槽位（relative + inset: 0）跟着卡走，这里只在尺寸变时算裁切
    const clip = (): void => {
      if (!card) return;
      const W = card.offsetWidth;
      const H = card.offsetHeight;
      radius = parseFloat(getComputedStyle(card).borderTopRightRadius) || 0;
      anchor.style.clipPath = over ? overClipPath(W, H, radius) : cardClipPath(radius);
      anchor.style.setProperty('--lift', `${belowRuler(card)}px`);
      pos();
    };
    const ro = new ResizeObserver(() => {
      if (card && card.offsetWidth === 0) sync();
      else clip();
    });
    const sync = (): void => {
      const next = firstCard();
      if (next !== card) {
        if (card) ro.unobserve(card);
        card = next;
        if (!card) {
          anchor.remove();
          return;
        }
        card.after(anchor);
        ro.observe(card);
        clip();
        if (!stage.current) {
          t0 = performance.now();
          rlog(`mascot load id=${id}`);
          stage.current = createStage(rv, def, {
            noDrop: mascotSession.landed,
            // 真显示出来才算降落过：加载好了但当场切走、舞台被销毁的，下次回来还要降落
            onShown: () => {
              mascotSession.landed = true;
            },
            // 静态图显示出来、Rive 第一帧换上各是第几毫秒（从挂上算）
            onStill: () => rlog(`mascot still id=${id} ms=${Math.round(performance.now() - t0)}`),
            onLive: () => rlog(`mascot live id=${id} ms=${Math.round(performance.now() - t0)}`),
            onReady: (ms) => {
              rlog(`mascot ready id=${id} ms=${Math.round(performance.now() - t0)}`);
              // 拆开：下载运行库和素材多久、new Rive 到加载好（wasm 编译、解析，占主线程的那一段）多久
              rlog(`mascot init ms=${ms.init} load=${ms.load}`);
              pos();
            },
            onMood: (m) => rlog(`mascot mood id=${id} s=${m}`),
            onForm: (n) => rlog(`mascot form id=${id} n=${n}`),
            onFail: () => {
              rlog(`mascot fail id=${id}`);
              anchor.remove();
              if (id === PRIVATE_ID) onPrivateFail();
            },
          });
          applyFlags(stage.current);
        }
      }
    };
    sync();
    // 卡还在页面上就什么都不做；卡被换掉或还没出来时才重新找
    const mo = new MutationObserver(() => {
      if (!card?.isConnected) sync();
    });
    mo.observe(document.body, { childList: true, subtree: true });
    const stop = watchGesture({
      hit(x, y) {
        const st = stage.current;
        if (!st?.ready || !card) return false;
        const under = document.elementFromPoint(x, y);
        if (!under?.closest('[data-testid="today"]')) return false;
        return inCardClip(x, y, anchor.getBoundingClientRect(), radius, over) && st.opaqueAt(x, y);
      },
      look: (x, y) => stage.current?.lookAt(x, y),
      tap() {
        rlog(`mascot tap id=${id}`);
        stage.current?.react('tap');
      },
      canDouble: () => stage.current?.canShuffle === true,
      double() {
        rlog(`mascot double id=${id}`);
        stage.current?.shuffle();
      },
      long() {
        rlog(`mascot long id=${id}`);
        void loadChatOpen().then((m) => m.openChat({ ask: '', from: 'mascot', record: null, onAnswered: null }));
      },
    });
    return () => {
      stop();
      mo.disconnect();
      ro.disconnect();
      // 已经画出来的留着（只从页面上摘下，舞台看不到自己就自己停），回今天页接回；还没加载好、加载失败的照旧销毁
      const st = stage.current;
      if (st?.ready) mascotSession.kept = { id, anchor, rv, stage: st };
      else st?.destroy();
      stage.current = null;
      anchor.remove();
    };
  }, [id, onPrivateFail]);
  return null;
}

export default function MascotHost() {
  const onToday = useRoute().name === 'today';
  const rows = useCollection<MascotRow>('settings');
  // 放哪只和设置页同一处判断（hooks/useMascotChoice.ts）：管理员身份 2 秒没读到先挂 Aldo，读到是管理员再换成 #2，设置页同时换。
  // #2 下载失败、桶里没文件时这次回落默认（Aldo），不报错
  const best = useMascotChoice(rows).id;
  const [privateBroken, setPrivateBroken] = useState(false);
  const onPrivateFail = useCallback(() => setPrivateBroken(true), []);
  const id = best === PRIVATE_ID && privateBroken ? DEFAULT_MASCOT : best;
  useEffect(() => {
    if (onToday && id !== null) rlog(`mascot pick id=${id}`);
  }, [onToday, id]);
  return onToday && id !== null ? <Hero key={id} id={id} onPrivateFail={onPrivateFail} /> : null;
}
