// 麦克风说明卡（B3 S23；定稿线框“第一次按住：先单独申请麦克风”“麦克风被拒绝”两张 MICCARD）
// • 先只做组件，暂不挂到任何地方（主持人 11-09 定）：FA-3 第一次按住、以后的首次引导序列（归属待定）直接用
// • 系统授权框只在用户点“允许麦克风”时才触发（线框：手指已经离开屏幕，不在长按时弹）；这里只回调，申请由调用方做
// • 装在 kit 的 Dialog 里（弹层、焦点、Esc 关闭都由它管）；exe 不出这张卡（R-90，调用方不挂）
// • 负责人 11-10 定：用 kit 的底部弹层（不改成线框的居中浮卡）；按线框 s10 卡顶加麦克风图标、文字居中（Dialog 的 lead、center）；
//   标题字重照 kit（加粗）；打开时主按钮的焦点框先不改，等真机看
import { Dialog } from '../../../kit/components/Dialog.tsx';
import { FormButton } from '../../../kit/components/Form.tsx';
import { isAppleMobile } from '../../../platform/env.ts';
import { usePlusT } from '../hooks/usePlusT.ts';
import { MicGlyph } from './MicGlyph.tsx';
import styles from './MicCard.module.css';

export type MicCardKind = 'ask' | 'denied';

export interface MicCardProps {
  open: boolean;
  kind: MicCardKind;
  onOpenChange(open: boolean): void;
  /** ask：点“允许麦克风”（调用方在这次点按里申请）；denied：点“我已打开，再试一次” */
  onRetry(): void;
  /** ask：“先只用打字”；denied：“改用打字” */
  onType(): void;
}

// body：iPhone、iPad 上照线框原文；bodyWeb：其他设备不带“iPhone”的通用说法（R-367，负责人 11-10 定）
const TEXT = {
  ask: { title: 'plus.mic.ask.title', body: 'plus.mic.ask.body', bodyWeb: 'plus.mic.ask.bodyWeb', main: 'plus.mic.ask.allow', alt: 'plus.mic.ask.type' },
  denied: { title: 'plus.mic.denied.title', body: 'plus.mic.denied.body', bodyWeb: 'plus.mic.denied.bodyWeb', main: 'plus.mic.denied.type', alt: 'plus.mic.denied.retry' },
} as const;

export default function MicCard({ open, kind, onOpenChange, onRetry, onType }: MicCardProps) {
  const t = usePlusT();
  const k = TEXT[kind];
  // 是不是 iPhone、iPad：直接用 platform/env.ts 的 isAppleMobile（S23 复审 R2）
  const ios = isAppleMobile();
  // 线框：ask 的主按钮是“允许麦克风”，denied 的主按钮是“改用打字”
  const main = kind === 'ask' ? onRetry : onType;
  const alt = kind === 'ask' ? onType : onRetry;
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t(k.title, {})} description={t(ios ? k.body : k.bodyWeb, {})} lead={<MicGlyph />} center>
      <div className={styles.btns} data-testid={`mic-card-${kind}`}>
        <FormButton type="button" variant="primary" block onClick={main} data-testid="mic-card-main">
          {t(k.main, {})}
        </FormButton>
        <FormButton type="button" block onClick={alt} data-testid="mic-card-alt">
          {t(k.alt, {})}
        </FormButton>
      </div>
    </Dialog>
  );
}
