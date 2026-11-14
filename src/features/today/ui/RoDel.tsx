// 今天页只读行的删除 ×（FA-2 视觉验收第二轮第 1 条）：变淡、aria-disabled，label 是最终的读屏名字；点了照样调 onClick（由 useReadonlyGuard 拦下出提示条）。
// 今天页（TodayPage，按需下载的那份到之前先画）和 TodayToasts 的 part="del"（读屏名字接上“要更新到新版本才能修改”）共用；
// 单独一个文件，免得 TodayToasts 反过来 import TodayPage（B6 整合）
import list from '../../../kit/components/List.module.css';
import { Pressable } from '../../../motion/components.ts';

export function RoDel(p: { label: string; onClick(): void; testId: string }) {
  return (
    <Pressable className={list.trail} aria-label={p.label} aria-disabled="true" onClick={p.onClick} data-testid={p.testId} data-no-proxy="">
      ×
    </Pressable>
  );
}
