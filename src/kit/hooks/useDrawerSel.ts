// 电脑版列表页（今天页、随手记页）的详情抽屉：开着的是哪一条、开关抽屉（B6 整合，两页原来各写一份）
// • loaded：电脑版那一块换上了；那一块画出错（QuietBoundary 的 onFail 调 fail）以后按没换上算，on 为 false，两页都退回手机排法、点行进编辑页
// • open(s, go)：on 时开抽屉，不然调 go（进编辑页）；只读拦截由页面在调 open 之前做
// • on 变 false（窗口变窄、电脑版出错）时清空；forget(id)：列表里删掉的正好是开着的那一条，抽屉一起关
//   （B6 独立评审第 11 条：不然抽屉里“已删除 · 撤销”和页底撤销条两个撤销入口同时在）
import { useCallback, useEffect, useState } from 'react';

export function useDrawerSel<T extends { id: string }>(loaded: boolean) {
  const [failed, setFailed] = useState(false);
  const on = loaded && !failed;
  const [sel, setSel] = useState<T | null>(null);
  useEffect(() => {
    if (!on) setSel(null);
  }, [on]);
  return {
    on,
    fail: useCallback(() => setFailed(true), []),
    sel,
    open: (s: T, go: () => void): void => (on ? setSel(s) : go()),
    close: useCallback(() => setSel(null), []),
    forget: (id: string): void => setSel((s) => (s?.id === id ? null : s)),
  };
}
