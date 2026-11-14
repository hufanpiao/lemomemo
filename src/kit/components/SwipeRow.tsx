// 左滑露出操作的列表行（kit，B5 视觉稿 anniv“左滑露出编辑 / 删除”；纪念日、随手记列表方式都用这一个，待办以后也用；
// 随手记原来自己有一份 NoteSwipe.tsx，审查“左滑行两套”删掉、并到这里）
// • 手势底层是 motion 的 useHDrag（和月历翻页同一套，R-420 审查第 4 条）：横向先走过起滑距离且比竖向多才算“滑”（抓住指针、直接写 transform 跟手）；
//   竖着先走就放手不管，行面写 touch-action: pan-y，竖着滚列表交给浏览器；左边缘 20 px 以内起手让给系统返回；电脑上鼠标也能拖（mouse: true）
// • 松手：拉过操作区一半就停在“露出”，否则收回；滑过之后紧跟的那一下 click 吞掉（不进编辑）
// • 露着的时候（照 iOS，R-420 审查第 5、7 条主持人定）：
//   – 行面可以直接拖回去；点一下行面是收起，那一下 click 吞掉
//   – 按在另一行上：第一下只收起露着的这一行，点到的那一行不打开（click 吞掉）；接着横滑照常滑那一行
//   – 点行外别处、按 Esc 收起；点操作按钮照常（做完收起）
//   一次只露一行：模块里记着“现在露着的那一条”。落在任何一行行面上的按下都由那一行自己的按下处理，document 上的捕获监听只管落在行外的
// • 收起时焦点在操作按钮上（Tab 过去、再 Esc）：交还给行面的主按钮，不让它跟着按钮变 inert 掉回 body（R-420 审查第 6 条）
// • 收回、停住的过渡写在 CSS（.face[data-snap]），减少动态效果（data-rm）时没有过渡、直接到位，不回弹
// • 读屏和键盘：操作按钮收着时 inert（不进 Tab 顺序、读屏读不到），这些用户照样点行进编辑层（或行里的“⋯”菜单，同一套动作），在那里删；
//   滑开以后按钮可 Tab、可读。按钮排在行面后面（Tab 顺序里行面的按钮在前）；行面 z-index 盖住按钮
// • 外观：按钮默认 .act / .danger；look="compact" 是随手记列表行的窄按钮（每个 64 宽、浅深两套底色，R-171、R-172；样式见 .compact）
// • 运行日志 log 必传（同 Mist：kit 不直接引 platform，调用方传 platform 的 rlog；必传就不会有哪一处忘了接，R-420 审查第 8 条）：
//   按下、定方向、松手、取消各记一行，松手记按下到松手的毫秒数（ms=），不记内容
// • 只渲染和手势，不碰数据：操作做什么由调用方给 onClick
import { useEffect, useRef, useState, type ElementType, type ReactNode } from 'react';
import { useHDrag } from '../../motion/gestures.ts';
import styles from './SwipeRow.module.css';

export interface SwipeAction {
  key: string;
  label: string;
  onClick(): void;
  danger?: boolean;
  testId?: string;
}

export interface SwipeRowProps {
  actions: readonly SwipeAction[];
  children: ReactNode;
  /** 外框元素（列表里用 li） */
  as?: ElementType;
  className?: string | undefined;
  /** 只读行等：不能滑 */
  disabled?: boolean;
  /** 按钮外观：不给是默认（纪念日）；compact 是随手记列表行的窄按钮 */
  look?: 'compact' | undefined;
  /** 记一行运行日志（platform 的 rlog；必传） */
  log(line: string): void;
  'data-testid'?: string;
  [data: `data-${string}`]: unknown;
}

/** 行面上的标记（data-swipe-face）：document 的捕获监听认它，落在任何一行行面上的按下交给那一行自己处理 */
const FACE_SEL = '[data-swipe-face]';

/** 现在露着的那一条的“收起” */
let openRow: (() => void) | null = null;

export function SwipeRow({ actions, children, as: Tag = 'div', className, disabled = false, look, log, ...rest }: SwipeRowProps) {
  const acts = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const openNow = useRef(false);
  openNow.current = open;
  /** 这次按下时这一行露着：没滑成就当点一下行面，收起 */
  const tapCloses = useRef(false);
  const width = (): number => acts.current?.offsetWidth ?? 0;

  /** 收起这一行（内容每次渲染更新）；me 是它固定身份的外壳，记在 openRow 里比“是不是这一行” */
  const closeNow = useRef(() => {});
  const me = useRef(() => closeNow.current()).current;
  const drag = useHDrag({
    mouse: true,
    tag: 'swipe',
    log,
    start: (e) => {
      // 一行露着时按在另一行上：先收起那一行，这一下补来的 click 吞掉（不打开这一行；接着横滑照常）
      if (openRow && openRow !== me) {
        openRow();
        drag.swallow();
      }
      if (disabled) {
        log('swipe down skip=disabled');
        return null;
      }
      tapCloses.current = openNow.current;
      log(`swipe down type=${e.pointerType} open=${openNow.current ? 1 : 0}`);
      return openNow.current ? -width() : 0;
    },
    clamp: (x) => Math.min(0, Math.max(-width(), x)),
    end: ({ axis, x, cancel, ms }) => {
      const w = width();
      const slid = axis === 'h' && !cancel;
      const keep = slid && x < -w / 2;
      const was = tapCloses.current;
      tapCloses.current = false;
      // started=1 先留着：b5-vault.spec.ts 的断言按这个格式认（那批 e2e 在另一批整理），时长记在 ms=
      log(`swipe ${cancel ? 'cancel' : 'up'} started=1 axis=${axis} last=${axis === 'h' ? Math.round(x) : 'none'} w=${w} open=${slid ? (keep ? 1 : 0) : was ? 0 : 'keep'} ms=${ms}`);
      if (slid && keep) {
        drag.place(-w, true);
        setOpen(true);
        return;
      }
      if (slid || was) {
        // 露着时点一下行面（没滑成）：收起，补来的 click 吞掉；滑了的那一下 hdrag 已经吞了
        if (!slid && !cancel) drag.swallow();
        me();
        return;
      }
      if (axis === 'h') drag.place(0, true);
    },
  });

  closeNow.current = () => {
    const a = acts.current;
    // 焦点在操作按钮上：交还给行面的主按钮（按钮马上要 inert）
    if (a && document.activeElement instanceof HTMLElement && a.contains(document.activeElement)) {
      drag.bind.ref.current?.querySelector<HTMLElement>('button, a[href], [tabindex]:not([tabindex="-1"])')?.focus();
    }
    drag.place(0, true);
    setOpen(false);
  };

  // 露着的时候：记成“现在露着的那一条”，点行外别处、Esc 收起
  useEffect(() => {
    if (!open) return undefined;
    if (openRow && openRow !== me) openRow();
    openRow = me;
    const onDown = (e: PointerEvent): void => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (acts.current?.contains(t) || t.closest(FACE_SEL)) return;
      me();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') me();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      if (openRow === me) openRow = null;
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, me]);

  return (
    <Tag className={[styles.wrap, className].filter(Boolean).join(' ')} data-swipe={open ? 'open' : undefined} {...rest}>
      <div
        className={styles.face}
        data-swipe-face=""
        ref={drag.bind.ref}
        onPointerDown={drag.bind.onPointerDown}
        onPointerMove={drag.bind.onPointerMove}
        onPointerUp={drag.bind.onPointerUp}
        onPointerCancel={drag.bind.onPointerCancel}
      >
        {children}
      </div>
      <div ref={acts} className={styles.acts} inert={!open || undefined} aria-hidden={!open || undefined}>
        {actions.map((a) => (
          <button
            key={a.key}
            type="button"
            className={[styles.act, a.danger && styles.danger, look === 'compact' && styles.compact].filter(Boolean).join(' ')}
            onClick={() => {
              me();
              a.onClick();
            }}
            data-testid={a.testId}
          >
            {a.label}
          </button>
        ))}
      </div>
    </Tag>
  );
}
