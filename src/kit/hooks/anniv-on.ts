// 纪念日功能开关对本人开着吗（B5；0.27 第 4 点）：日历的“纪念日”分段和菱形、今天页的纪念日一行都看它。
// 按启动时缓存的 config 算（core/boot.ts 的 flags）；没有缓存的 config 时按开着（同 app/features.ts 的全挂）
import { getBoot } from '../../core/boot.ts';

export function annivOn(): boolean {
  const f = getBoot()?.flags;
  return f == null || f.has('anniv');
}
