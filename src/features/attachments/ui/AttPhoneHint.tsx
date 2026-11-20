// 手机和窄窗口（不是电脑布局，MQ_SIDEBAR）的“文档请在电脑上加。手机上可以看、预览、下载。”（R-114 D-3：手机不能加附件）
// • 记录页美化方向 A（负责人 11-20“记录页美化方案用A”）：从附件区（AttPanel.tsx）挪到随手记、隐私记手机编辑页底部浮动工具条右侧，
//   编辑页经 index.ts 懒加载挂；新建还没存的隐私记（附件区还不挂）也出
// • 照方案分两行：第一句后换行，文案不改（读屏、textContent 还是整句）；电脑布局不出东西（附件区自己出“加附件”）
// • 外观由挂它的地方给 className
import { MQ_SIDEBAR, useMedia } from '../../../kit/hooks/useMedia.ts';
import { useAttT } from '../hooks/useNoteFiles.ts';

export default function AttPhoneHint({ className }: { className?: string | undefined }) {
  const t = useAttT();
  const desk = useMedia(MQ_SIDEBAR);
  if (desk) return null;
  const s = t('att.phoneOnly', {});
  const m = /^(.+?[。.!?！？])\s*(.+)$/su.exec(s);
  const a = m?.[1] ?? s;
  const b = m?.[2] ?? '';
  return (
    <span className={className} data-testid="note-files-phone">
      {a}
      {b ? <br /> : null}
      {b}
    </span>
  );
}
