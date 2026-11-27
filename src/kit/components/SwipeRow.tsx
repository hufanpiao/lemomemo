// 左滑露出操作的列表行（kit）：纪念日、随手记列表方式、待办列表都用这一个，不另写一套左滑行
// • 手势底层是 motion 的 useHDrag（和月历翻页同一套）：横向先走过起滑距离且比竖向多才算“滑”（抓住指针、直接写 transform 跟手）；
//   竖着先走就放手不管，行面写 touch-action: pan-y，竖着滚列表交给浏览器；左右两条切页带（含左边缘 20 px 系统返回区）里起手不起滑；电脑上鼠标左键也能拖（mouse: true）
// • 松手：拉过操作区一半就停在“露出”，否则收回；滑过之后紧跟的那一下 click 吞掉（不进编辑）
// • 拉到底直接做（full，可选；照 iOS 邮件整行滑删）：给了 full（某个动作的 key）时可以拉过操作区一直拉到整行；
//   松手时拉过整行 FULL_RATIO（大半行）就整行滑走、当场做这个动作（日志 swipe full），不用再点按钮；没过就照上面停在“露出”或收回。
//   阈值反馈：没过 FULL_RATIO 时行底是中性的灰（只有按钮是自己的底色）；跟手拉过了就在外框打 data-full，整行换成那个动作的底色，
//   来回跨过阈值时跟着打上、摘掉（直接写 DOM 的 dataset，不经 React state；日志 swipe full arm=1|0）；底色过渡写在 CSS。
//   做完 FULL_RESET_MS 以后行面放回原位、摘掉 data-full：行已删掉就无所谓；没删成、撤销回来时不会一直空着。
//   随手记、纪念日不开
// • 露着的时候（照 iOS）：
//   – 行面可以直接拖回去；点一下行面是收起，那一下 click 吞掉
//   – 按在另一行上：第一下只收起露着的这一行，点到的那一行不打开（click 吞掉）；接着横滑照常滑那一行
//   – 点行外别处、按 Esc 收起（露着时是层栈里的一层，Esc 只在它是栈顶时收它）；点操作按钮照常（做完收起）
//   一次只露一行：模块里记着“现在露着的那一条”。落在任何一行行面上的按下都由那一行自己的按下处理，document 上的捕获监听只管落在行外的
// • 收起时焦点在操作按钮上（Tab 过去、再 Esc）：交还给行面的主按钮，不让它跟着按钮变 inert 掉回 body
// • 收回、停住的过渡写在 CSS（.face[data-snap]），减少动态效果（data-rm）时没有过渡、直接到位，不回弹
// • 读屏和键盘：操作按钮收着时 inert（不进 Tab 顺序、读屏读不到），这些用户照样点行进编辑层（或行里的“⋯”菜单，同一套动作），在那里删；
//   滑开以后按钮可 Tab、可读。按钮排在行面后面（Tab 顺序里行面的按钮在前）；行面 z-index 盖住按钮
// • 外观：按钮默认 .act / .danger；look="compact" 是随手记列表行的窄按钮（每个 64 宽、浅深两套底色；样式见 .compact）
// • 运行日志 log 必传（kit 不直接引 platform，调用方传 platform 的 rlog；必传就不会有哪一处忘了接）：
//   按下、定方向、松手、取消各记一行，松手记按下到松手的毫秒数（ms=），不记内容
// • 只渲染和手势，不碰数据：操作做什么由调用方给 onClick
// • 震动：每个操作按钮里藏一个真系统开关（TapSwitch，这一行第一次按下行面时才挂上），手指点“删除”时 iOS 才出触感；onClick 里没调该震的 fx 的按钮点了不震。
//   拉到底直删不是点按（没有 click），iOS 上不震
//
// 谁负责收起（一次只露一行）：
//   • onFaceDown：落在行面上的每一下按下（见函数说明）
//   • document 捕获监听（露着时挂）：按在行面、这一行操作按钮以外的地方
//   • useLayer（露着时算一层）：Esc、层栈要收起；焦点由 closeNow 交还行面
//   • 这一行露出时（open 变 true 的 effect）先收起模块里记着的上一条（openRow）
import { useEffect, useRef, useState, type ElementType, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import { useHDrag } from '../../motion/gestures.ts';
import { useLayer } from '../hooks/useLayer.ts';
import list from './List.module.css';
import styles from './SwipeRow.module.css';
import { TapSwitch } from './TapSwitch.tsx';

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
  /** 拉到底直接做的那个动作的 key（见文件头）；不给不能拉过操作区 */
  full?: string | undefined;
  /** 记一行运行日志（platform 的 rlog；必传） */
  log(line: string): void;
  'data-testid'?: string;
  [data: `data-${string}`]: unknown;
}

/** 行面上的标记（data-swipe-face）：document 的捕获监听认它，落在任何一行行面上的按下交给那一行自己处理 */
const FACE_SEL = '[data-swipe-face]';

/** 现在露着的那一条的“收起” */
let openRow: (() => void) | null = null;

/** 拉过整行多少算“拉到底”（大半行） */
export const FULL_RATIO = 0.6;
/** 拉到底做完以后多久把行面放回原位（比列表删行的离场长，离场途中不往回滑） */
export const FULL_RESET_MS = 1000;

export function SwipeRow({ actions, children, as: Tag = 'div', className, disabled = false, look, full, log, ...rest }: SwipeRowProps) {
  const acts = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  // 按钮里的震动开关用到才挂（随手记 200 条每条 3 个按钮，全挂就是 600 个 TapSwitch）：按钮本身照常一直画（收着时 inert，外观、读屏不变）；这一行第一次按下行面（滑开之前一定先按下）才挂上开关，挂上以后一直留着
  const [armed, setArmed] = useState(false);
  const openNow = useRef(false);
  openNow.current = open;
  /** 这次按下时这一行露着：没滑成就当点一下行面，收起 */
  const tapCloses = useRef(false);
  const width = (): number => acts.current?.offsetWidth ?? 0;
  const fullAct = actions.find((a) => a.key === full);
  /** 整行宽（拉到底的终点）；没有 full 时不能拉过操作区 */
  const span = (): number => (fullAct ? (drag.bind.ref.current?.offsetWidth ?? 0) : width());
  const resetT = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(resetT.current), []);
  const wrap = useRef<HTMLElement>(null);
  /** 拉过阈值没有：外框打 / 摘 data-full（整行底色跟着换，CSS），状态变了才记日志 */
  const arm = (on: boolean): void => {
    const el = wrap.current;
    if (!el || ('full' in el.dataset) === on) return;
    if (on) el.dataset['full'] = '';
    else delete el.dataset['full'];
    log(`swipe full arm=${on ? 1 : 0}`);
  };

  /** 收起这一行（内容每次渲染更新）；me 是它固定身份的外壳，记在 openRow 里比“是不是这一行” */
  const closeNow = useRef(() => {});
  const me = useRef(() => closeNow.current()).current;
  /** 这一下按下 hdrag 接没接（进了 start）：左右切页带、鼠标右键 hdrag 在 start 之前就不管了 */
  const taken = useRef(false);
  const drag = useHDrag({
    mouse: true,
    tag: 'swipe',
    log,
    start: (e) => {
      taken.current = true;
      if (disabled) {
        log('swipe down skip=disabled');
        return null;
      }
      tapCloses.current = openNow.current;
      log(`swipe down type=${e.pointerType} open=${openNow.current ? 1 : 0}`);
      return openNow.current ? -width() : 0;
    },
    clamp: (x) => {
      const row = span();
      const c = Math.min(0, Math.max(-row, x));
      if (fullAct) arm(c < -row * FULL_RATIO);
      return c;
    },
    end: ({ axis, x, cancel, ms }) => {
      const w = width();
      const slid = axis === 'h' && !cancel;
      const row = span();
      if (slid && fullAct && x < -row * FULL_RATIO) {
        tapCloses.current = false;
        log(`swipe full key=${fullAct.key} w=${Math.round(row)} ms=${ms}`);
        drag.place(-row, true);
        setOpen(false);
        fullAct.onClick();
        clearTimeout(resetT.current);
        resetT.current = setTimeout(() => {
          drag.place(0, false);
          arm(false);
        }, FULL_RESET_MS);
        return;
      }
      arm(false);
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

  /**
   * 行面上的每一下按下都先到这里（hdrag 过滤之前），“按下就收起”只在这一处，不放进拖动的 start
   * （切页带里起手、鼠标右键按下都到不了 start，放那里露着的行收不起来）：
   * • 别的行露着：先收起那一行，这一下补来的 click 吞掉（不打开这一行；接着横滑照常）
   * • 这一行露着、这一下 hdrag 不接：当点一下行面，收起、吞掉 click；hdrag 接了的照旧（可以直接拖回去，松手时 tapCloses 收）
   */
  const onFaceDown = (e: RPointerEvent<HTMLDivElement>): void => {
    if (!armed && !disabled) setArmed(true);
    if (openRow && openRow !== me) {
      openRow();
      drag.swallow();
    }
    taken.current = false;
    drag.bind.onPointerDown(e);
    if (e.isPrimary && !taken.current && openNow.current) {
      log(`swipe down close=untaken type=${e.pointerType} button=${e.button}`);
      drag.swallow();
      me();
    }
  };

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
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      if (openRow === me) openRow = null;
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [open, me]);
  // 露着算一层（kit/hooks/layers.ts）：Esc 是栈顶时才收起；焦点由 closeNow 交还行面，层栈不另还
  useLayer(open, { name: 'swipe', onEsc: me, back: () => [] });

  return (
    <Tag ref={wrap} className={[styles.wrap, fullAct?.danger && styles.fullBg, className].filter(Boolean).join(' ')} data-swipe={open ? 'open' : undefined} {...rest}>
      <div
        className={styles.face}
        data-swipe-face=""
        ref={drag.bind.ref}
        onPointerDown={onFaceDown}
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
            {armed ? <TapSwitch /> : null}
          </button>
        ))}
      </div>
    </Tag>
  );
}

export interface DelSwipeProps {
  /** 测试 id 前缀（todos、today）：外框 `<tid>-swipe-<id>`、按钮 `<tid>-swipe-del-<id>` */
  tid: string;
  id: string;
  ro: boolean;
  label: string;
  onDel(): void;
  log(line: string): void;
  children: ReactNode;
}

/** 待办行的左滑删除（待办页、今天页同一份）：露出“删除”点了删，一口气拉过大半行直接删（full）；
 *  只读行不能滑。放在这里不放 kit TodoRow：今天页首屏画完才下载左滑（features/today 的 loadTodaySwipe），参数跟着这一块走、不占首屏 */
export function DelSwipe({ tid, id, ro, label, onDel, log, children }: DelSwipeProps) {
  return (
    <SwipeRow
      className={list.swp}
      disabled={ro}
      full="del"
      log={log}
      actions={[{ key: 'del', label, danger: true, onClick: onDel, testId: `${tid}-swipe-del-${id}` }]}
      data-testid={`${tid}-swipe-${id}`}
    >
      {children}
    </SwipeRow>
  );
}
