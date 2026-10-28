// CSP 试验页（B0 第一项验证，架构 2.0、N3）：在带 CSP 的 wrangler pages dev 下跑 Radix Dialog、Popover 和 Motion
// 只在非正式版里挂（App.tsx）；端到端测试 tests/e2e/csp.spec.ts 逐个打开，记录有没有 CSP 报错
// 结论写在 docs/07-开发日志/B0-验证-CSP下Radix与Motion.md
// 开发用页面，文字不进词典（只用英文，不触发 A20）
import * as RD from '@radix-ui/react-dialog';
import { useState } from 'react';
import { Dialog, DialogClose } from '../../kit/components/Dialog.tsx';
import { Popover } from '../../kit/components/Popover.tsx';
import { Appear, Pressable, SharedLayout } from '../../motion/components.ts';
import styles from './CspLab.module.css';

/** 对照组：Radix 原样用法（带 Dialog.Overlay，里面有 react-remove-scroll） */
function RawRadixDialog() {
  return (
    <RD.Root>
      <RD.Trigger className={styles.btn} data-testid="raw-dialog-open">
        Raw Radix dialog (with Overlay)
      </RD.Trigger>
      <RD.Portal>
        <RD.Overlay className={styles.overlay} />
        <RD.Content className={styles.panel} data-testid="raw-dialog" aria-describedby={undefined}>
          <RD.Title>Raw</RD.Title>
          <RD.Close className={styles.btn}>Close</RD.Close>
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

export default function CspLab() {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(false);
  const [wide, setWide] = useState(false);
  return (
    <main className={styles.page} data-testid="csp-lab">
      <h1>CSP lab</h1>
      <section>
        <button type="button" className={styles.btn} data-testid="dialog-open" onClick={() => setOpen(true)}>
          Dialog (kit)
        </button>
        <Dialog open={open} onOpenChange={setOpen} title="Kit dialog" description="No Radix overlay; own scroll lock">
          <DialogClose className={styles.btn} data-testid="dialog-close">
            Close
          </DialogClose>
        </Dialog>
      </section>
      <section>
        <RawRadixDialog />
      </section>
      <section>
        <Popover
          label="Year and month"
          trigger={
            <button type="button" className={styles.btn} data-testid="popover-open">
              Popover
            </button>
          }
        >
          <p data-testid="popover-body">Popover body</p>
        </Popover>
      </section>
      <section>
        <Pressable className={styles.btn} data-testid="motion-toggle" onClick={() => setShown((s) => !s)}>
          Motion appear
        </Pressable>
        <Appear kind="toast" show={shown}>
          <p data-testid="motion-box" className={styles.box}>
            Appear (toast)
          </p>
        </Appear>
      </section>
      <section>
        <button type="button" className={styles.btn} data-testid="layout-toggle" onClick={() => setWide((w) => !w)}>
          Motion layout
        </button>
        <div className={wide ? styles.rowEnd : styles.row}>
          <SharedLayout id="lab-dot" className={styles.dot}>
            <span data-testid="layout-dot">dot</span>
          </SharedLayout>
        </div>
      </section>
    </main>
  );
}
