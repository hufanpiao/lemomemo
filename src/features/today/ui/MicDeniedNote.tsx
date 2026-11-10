// 麦克风被拒时今天页常驻的一行（B3 S23；文案照定稿线框“麦克风被拒绝”卡原文，主持人 11-09 定）
// TodayPage 懒加载本组件，放在“未同步”提示条同一个 role="status" 容器里（.notice:has(p) 给浅灰底，同一个样子）；没被拒时不画
import { isAppleMobile } from '../../../platform/env.ts';
import { useMicDenied } from '../hooks/useMicDenied.ts';
import { useTodayT } from '../hooks/useTodayT.ts';

export default function MicDeniedNote() {
  const t = useTodayT();
  const ios = isAppleMobile();
  if (!useMicDenied()) return null;
  // iPhone、iPad 照线框原文；其他设备用不带“iPhone”的通用说法（R-367，负责人 11-10 定）
  return <p data-testid="today-mic-denied">{t(ios ? 'today.micDenied' : 'today.micDeniedWeb', {})}</p>;
}
