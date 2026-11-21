// 解锁（线框 s9 UNLOCKOV / PWERR；视觉稿 PH.unlock）：绑定过 Face ID 时磨砂遮罩 + 解锁卡；输密码是盖满屏幕的整页（同设密码页）
// • 卡片（R-452 V2，负责人 11-17 选“kenotex 风”，图 设计方案/2026-11-17_打字条与隐私记/v-v2-card-*）：贴在底栏上方的一条，
//   第一行“🔒 隐私记已上锁 · N 条 …… 取消”，第二行“用 Face ID 解锁”“输入密码”并排；自动上锁说明从卡上拿掉（解锁后提示行、设置 › 隐私记“自动上锁”都有）
//   Face ID 按钮只在这台设备能用（exe、不支持的环境不显示）、绑定过、没有“别处改过密码”（relock）时出现（S4、TC-B5-47 ②）
// • 隐私记页锁着（center，负责人 11-19“锁着用甲”，方案 柠檬记APP-本机资料/设计方案/2026-11-19_隐私记改善/方案.html 甲）：不是贴底的一条，
//   整页居中：自带顶栏“‹ 随手记 | 🔒 隐私记”、柠檬黄圆底大锁、“隐私记已上锁”“里面有 N 条”，下面竖排“输入密码”（主按钮）、“用 Face ID 解锁”（次按钮）；
//   这一页不是遮罩（LockLayer variant="page" 照常排在页面里，底栏能点；11-19 独立评审高 1～3：原来是透明的全屏模态遮罩，底栏看得见点不动），返回走顶栏“‹ 随手记”（同取消）。
//   移到隐私记、设置里那两处等解锁（waiting）照旧是磨砂遮罩里贴底的一条（LockLayer variant="overlay"）
// • 用不了 Face ID（没绑定、设备不支持、relock）时卡片只有“输入密码”“取消”（线框 s9 说明：“就只显示‘输入密码’”），点了再进密码页
// • 点“输入密码”换成密码键盘，焦点放到密码页标题（data-unlock-main）；Face ID 连续两次没认出来自动换成密码键盘（D18），标题下写“Face ID 没认出来，请输入密码”
// • 密码页是整页：顶栏“‹ 随手记 … 取消”；输错写“密码不对，还能再试 N 次”、锁定中写倒计时，都在圆点下面、键盘上面（PWERR），键盘不能按。
//   提示只看这一次动作回的结果（hooks/useVault.ts 的 useFailText），不读会话里共用的 lastError
// • “Ctrl + L 立即上锁 · Esc 取消”只在电脑版（侧栏宽度）显示
// • 解锁成功：锁着页、遮罩淡出 --dur-ui 后卸掉（S21，唯一的动效）；锁上时直接盖上、不做动效
// • 读屏和焦点（审查第 6 条）：遮罩是 Radix Dialog 的模态 Content（同 kit Dialog、smart-search 的 FindPanel；不用 Overlay，CSP 拦它的内联 style），
//   名字是隐藏标题“隐私记已上锁”（aria-labelledby 由 Radix 接），挂上时焦点移到卡里第一个按钮、Tab 圈在遮罩里，遮罩外的内容对读屏隐藏。
//   Esc 由 kit 层栈接住（锁屏是栈顶时），经 EscCtx 交给卡片的“取消”（和按钮同一个 cancel）；点遮罩空白处不关
// • 结构：useUnlockFlow 管状态和动作，CenterCard / BarCard / PinView 只管画；锁层只有 LockLayer 一份（页面、遮罩两种）
import * as RD from '@radix-ui/react-dialog';
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { FormButton } from '../../../kit/components/Form.tsx';
import { NumIn } from '../../../kit/components/NumIn.tsx';
import { prevent, useLayer } from '../../../kit/hooks/useLayer.ts';
import { MQ_SIDEBAR, useMedia } from '../../../kit/hooks/useMedia.ts';
import { useFailText, useVault, useVaultCount, type VaultResult } from '../hooks/useVault.ts';
import { useWebauthn } from '../hooks/useVaultAuth.ts';
import { useVaultT } from '../hooks/useVaultT.ts';
import { LockBadge, LockIcon, PadLayer, PinPad, PinTop, useDuration, VaultTop } from './Pin.tsx';
import styles from './Vault.module.css';

/** 解锁遮罩打开时把焦点给卡上的主按钮（data-unlock-main）；没有就照 Radix 默认落第一个可聚焦的 */
function focusMain(e: Event, root: HTMLElement | null): void {
  const main = root?.querySelector<HTMLElement>('[data-unlock-main]');
  if (!main) return;
  e.preventDefault();
  main.focus();
}

/** 遮罩把 Esc 交给里面的解锁卡（卡片挂上时登记自己的 cancel） */
const EscCtx = createContext<{ current: (() => void) | null }>({ current: null });
// 解锁卡在磨砂遮罩（对话框）里：对话框的名字已经是隐藏标题“隐私记已上锁”（RD.Title），卡片上那行同样的字对读屏藏起来，不念两遍（独立评审 11-19 高 6）
const InDialog = createContext(false);

/** 锁定倒计时：每秒刷新一次，到点回 0、停掉定时器 */
function useLeft(until: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  // until 一变先在画出来之前刷新“现在”（原来只在挂上时记，刚锁定那一秒会把卡片开着的时长也算进去：60 秒显示成 1 分 2 秒）
  useLayoutEffect(() => {
    if (until === null) return;
    setNow(Date.now());
    const id = setInterval(() => {
      const n = Date.now();
      setNow(n);
      if (n >= until) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [until]);
  return until === null ? 0 : Math.max(0, Math.ceil((until - now) / 1000));
}

/**
 * 解锁卡的状态和动作（三种画法共用）。onCancel：取消以后还要做的事（隐私记页回随手记）；可以不给。
 * 有请求等着解锁（waiting）时，取消一律先作废它们（会话的 cancelWait：原请求回失败、后台队列整个丢掉并记个数），三处用法不再各自调（审查第 1 条）
 */
function useUnlockFlow(onCancel: (() => void) | undefined) {
  const { state, s } = useVault();
  const wa = useWebauthn();
  const count = useVaultCount();
  const [mode, setMode] = useState<'card' | 'pin'>('card');
  const [faceFails, setFaceFails] = useState(0);
  const [busy, setBusy] = useState(false);
  /** 这一次动作（输密码、Face ID）回的结果：密码页的提示只看它 */
  const [fail, setFail] = useState<VaultResult<unknown> | null>(null);
  const canFace = wa.canUnlock(state);
  const left = useLeft(state.lockedUntil);
  const cancel = (): void => {
    if (s.get().waiting) s.cancelWait();
    onCancel?.();
  };
  const esc = useContext(EscCtx);
  useLayoutEffect(() => {
    esc.current = cancel;
  });

  // 卡上有 Face ID 按钮就先要好解锁挑战（11-19“隐私记感觉没变快”）：点了直接弹系统 Face ID，不先等 webauthn_options 往返；没认出要再点时也先要好
  useEffect(() => {
    if (canFace && mode === 'card' && !busy) s.prepareFace();
  }, [s, canFace, mode, busy, faceFails]);

  const face = async (): Promise<void> => {
    setBusy(true);
    const r = await wa.unlock();
    setBusy(false);
    if (r?.ok) return;
    setFail(r);
    const n = faceFails + 1;
    setFaceFails(n);
    if (n >= 2) setMode('pin');
  };
  const pin = async (p: string): Promise<void> => {
    setBusy(true);
    const r = await s.unlock(p);
    setBusy(false);
    setFail(r);
  };
  return {
    relocked: state.relocked, method: wa.label, canFace, count, mode, faceFails, busy, fail, cancel, face, pin,
    left, locked: left > 0, toPin: (): void => setMode('pin'),
  };
}
type Flow = ReturnType<typeof useUnlockFlow>;

export function UnlockPanel({ onCancel, onForgot, testId = 'vault-unlock', backLabel, center = false }: { onCancel?(): void; onForgot(): void; testId?: string; backLabel?: string; center?: boolean }) {
  const f = useUnlockFlow(onCancel);
  if (f.mode === 'pin') return <PinView f={f} testId={testId} backLabel={backLabel} onForgot={onForgot} />;
  return center ? <CenterCard f={f} testId={testId} backLabel={backLabel} /> : <BarCard f={f} testId={testId} />;
}

/** “密码已在别的设备修改”（TC-B5-47 ②） */
function Relock({ f, testId }: { f: Flow; testId: string }) {
  const t = useVaultT();
  return f.relocked ? (
    <p className={styles.notice} role="alert" data-testid={`${testId}-relock`}>
      {t('vault.err.relock', {})}
    </p>
  ) : null;
}

/** Face ID 没认出来：一行次要色小字 */
function FaceMsg({ f }: { f: Flow }) {
  const t = useVaultT();
  return f.faceFails > 0 ? <p className={styles.cardMsg} role="status">{t('vault.unlock.notRecognized', { method: f.method })}</p> : null;
}

/**
 * “输入密码”“用 Face ID 解锁”两颗按钮（主次只在这里判断一次）：锁着页（center）输密码在上、是主按钮，整行宽；
 * 贴底的卡 Face ID 在前、是主按钮，用不了 Face ID 时“输入密码”是主按钮。密码锁定期间照样给 Face ID（服务器锁定期也放行 WebAuthn）
 */
function UnlockButtons({ f, center, testId }: { f: Flow; center: boolean; testId: string }) {
  const t = useVaultT();
  const main: 'pin' | 'face' = center || !f.canFace ? 'pin' : 'face';
  const order = center ? (['pin', 'face'] as const) : (['face', 'pin'] as const);
  return (
    <>
      {order
        .filter((k) => k === 'pin' || f.canFace)
        .map((k) => {
          const primary = k === main ? { variant: 'primary' as const, strong: true, 'data-unlock-main': '' } : {};
          return k === 'pin' ? (
            <FormButton key={k} {...primary} size="row" block={center} onClick={f.toPin} data-testid={`${testId}-pin`}>
              {t('vault.unlock.pin', {})}
            </FormButton>
          ) : (
            <FormButton key={k} {...primary} size="row" block={center} disabled={f.busy} onClick={() => void f.face()} data-testid={`${testId}-face`}>
              {t('vault.unlock.with', { method: f.method })}
            </FormButton>
          );
        })}
    </>
  );
}

/** 隐私记页锁着（方案甲）：整页居中，自带顶栏 */
function CenterCard({ f, testId, backLabel }: { f: Flow; testId: string; backLabel: string | undefined }) {
  const t = useVaultT();
  return (
    <div className={styles.center} data-testid={`${testId}-card`} data-layout="center">
      <VaultTop back={{ label: backLabel ?? t('vault.back', {}), onBack: f.cancel, testId: `${testId}-cancel` }} title={t('vault.title', {})} lock />
      <div className={styles.centerBody}>
        <Relock f={f} testId={testId} />
        <LockBadge />
        <h2 className={styles.centerTitle}>{t('vault.locked.title', {})}</h2>
        <p className={styles.centerSub}><NumIn text={t('vault.locked.count', { n: f.count })} num={String(f.count)} /></p>
        <FaceMsg f={f} />
        <div className={styles.centerBtns}>
          <UnlockButtons f={f} center testId={testId} />
        </div>
      </div>
    </div>
  );
}

/** 贴在底栏上方的一条（遮罩里） */
function BarCard({ f, testId }: { f: Flow; testId: string }) {
  const t = useVaultT();
  const inDialog = useContext(InDialog);
  return (
    <div className={styles.card} data-testid={`${testId}-card`}>
      <Relock f={f} testId={testId} />
      <div className={styles.cardHead}>
        <LockIcon />
        <h2 className={styles.cardTitle} aria-hidden={inDialog || undefined}>
          {t('vault.locked.title', {})}
        </h2>
        <span className={styles.cardSub}><NumIn text={t('vault.locked.countShort', { n: f.count })} num={String(f.count)} /></span>
        {/* “取消”是右上角的文字按钮（不描边、次要色、点击区 44） */}
        <button type="button" className={styles.cardCancel} onClick={f.cancel} data-testid={`${testId}-cancel`}>
          {t('vault.cancel', {})}
        </button>
      </div>
      <FaceMsg f={f} />
      <div className={styles.cardBtns}>
        <UnlockButtons f={f} center={false} testId={testId} />
      </div>
    </div>
  );
}

/**
 * 输密码是整页（线框 s9 PWERR：整页浅灰底、白色圆形数字键），和设密码页（SetupPin 的 NewPinSteps）同一套 .pin 排版和 PinPad；
 * 输错、锁定倒计时写在同一行 .pinErr（04、05）。换到这一页时焦点放到标题上（键盘、读屏用户知道换了页）
 */
function PinView({ f, testId, backLabel, onForgot }: { f: Flow; testId: string; backLabel: string | undefined; onForgot(): void }) {
  const t = useVaultT();
  const dur = useDuration();
  const failText = useFailText();
  const desk = useMedia(MQ_SIDEBAR);
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    title.current?.focus();
  }, []);
  const sub = f.faceFails >= 2 ? t('vault.unlock.notRecognized', { method: f.method }) : t('vault.locked.count', { n: f.count });
  const err = f.locked ? t('vault.unlock.lockedFor', { t: dur(f.left) }) : failText(f.fail);
  return (
    <div className={styles.pinPage} data-testid={`${testId}-pinview`}>
      <PinTop backLabel={backLabel} onCancel={f.cancel} testId={testId} />
      <div className={styles.pin}>
        <Relock f={f} testId={testId} />
        <LockIcon big />
        <h2 ref={title} tabIndex={-1} className={styles.pinTitle} data-unlock-main="">
          {t('vault.unlock.enter', {})}
        </h2>
        <p className={styles.pinSub}>{sub}</p>
        <PinPad onSubmit={(p) => void f.pin(p)} disabled={f.busy || f.locked} testId={`${testId}-pad`} msg={err} msgTestId={`${testId}-err`} />
        <div className={styles.pinFoot}>
          <button type="button" className={styles.link} onClick={onForgot} data-testid={`${testId}-forgot`}>
            {t('vault.unlock.forgot', {})}
          </button>
          {desk ? <p className={styles.muted}>{t('vault.keys', {})}</p> : null}
        </div>
      </div>
    </div>
  );
}

/** 解锁成功时淡出 --dur-ui 再卸掉（S21）；打开时直接出现。用 transitionend 收尾（done），另设 400 ms 兜底（减少动态效果时不会卡住） */
function useFadeOut(open: boolean): [shown: boolean, done: () => void] {
  const [shown, setShown] = useState(open);
  useEffect(() => {
    if (open) {
      setShown(true);
      return undefined;
    }
    const id = setTimeout(() => setShown(false), 400);
    return () => clearTimeout(id);
  }, [open]);
  return [open || shown, () => setShown(false)];
}

/**
 * 锁层（一份，两种）：
 * • page：隐私记页锁着（负责人 11-19“锁着用甲”）：解锁卡就是这一页，照常排在页面里（不是遮罩：底栏照常能点，返回走顶栏“‹ 随手记”）；锁上那一刻焦点给主按钮
 * • overlay：磨砂遮罩里放解锁卡（移到隐私记、设置 › 隐私记里令牌过期等解锁时），Radix 模态
 * 两种都在层栈里是模态层（kit/hooks/layers.ts）：Esc 只在它是栈顶时交给里面的退路（esc）；页面的快捷键收不到，里面密码键盘的数字键登记在这一层上（PadLayer）；
 * 不锁滚动（keepScroll：取消时直接换页）；焦点不由层栈还。解锁成功后同一块淡出（S21）：淡出那一下盖在刚画出来的内容上、不接点击
 */
export function LockLayer({ variant, open, children, testId }: { variant: 'page' | 'overlay'; open: boolean; children: ReactNode; testId?: string }) {
  const t = useVaultT();
  const esc = useRef<(() => void) | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const [shown, done] = useFadeOut(open);
  const layer = useLayer(open, { name: 'unlock', modal: true, keepScroll: true, el: () => root.current, onEsc: () => esc.current?.(), back: () => [] });
  const page = variant === 'page';
  // 锁着页锁上那一刻焦点给主按钮（同遮罩的 focusMain）：键盘用户不用先 Tab 过“‹ 随手记”
  useEffect(() => {
    if (page && open) root.current?.querySelector<HTMLElement>('[data-unlock-main]')?.focus();
  }, [page, open]);
  if (!shown) return null;
  const leaving = !open;
  const inner = (
    <EscCtx.Provider value={esc}>
      <InDialog.Provider value={!page}>
        <PadLayer.Provider value={layer}>{children}</PadLayer.Provider>
      </InDialog.Provider>
    </EscCtx.Provider>
  );
  // 锁着页就是这一页本身，用 <main>（每页一个 main 是全 app 的约定：切页按它认“新页出来了”，motion/page-shown.ts PAGE_SELECTOR）。
  // 11-21 负责人截图“点隐私记变成这样”：原来是 div，从随手记推进来认不到新页，随手记的快照叠着留满 30 秒、点按一直被吞
  if (page)
    return (
      <main ref={root} className={leaving ? `${styles.lockPage} ${styles.lockOut}` : styles.lockPage} data-testid={testId ?? 'vault-locked'} data-leaving={leaving || undefined} onTransitionEnd={() => leaving && done()}>
        {inner}
      </main>
    );
  return (
    <RD.Root open={open}>
      {/* 打开时焦点落到主按钮（Face ID，没有就“输入密码”），不落到标题行右边的“取消”（R-452 V2 把“取消”挪到了第一行，DOM 里排第一）；
          Esc 由层栈在捕获阶段接住交给 esc，Radix 自己的 Esc 那条路走不到（独立评审 11-19 低 19：原来的 onOpenChange 是死代码） */}
      <RD.Content asChild forceMount aria-describedby={undefined} onOpenAutoFocus={(e) => focusMain(e, root.current)} onPointerDownOutside={prevent} onFocusOutside={prevent} onInteractOutside={prevent} onCloseAutoFocus={prevent}>
        <div
          ref={root}
          className={leaving ? `${styles.scrim} ${styles.scrimOut}` : styles.scrim}
          data-testid={testId ?? 'vault-scrim'}
          data-leaving={leaving || undefined}
          onTransitionEnd={() => leaving && done()}
          aria-modal="true"
        >
          <RD.Title className={styles.sr}>{t('vault.locked.title', {})}</RD.Title>
          {inner}
        </div>
      </RD.Content>
    </RD.Root>
  );
}
