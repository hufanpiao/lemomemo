// 停下来以后记一行运行日志（查找面板 find kw、下拉搜索 pull find 共用）
// • trigger 变了才重新计时（同步来了新数据、line 跟着变，不推迟）；到点记的是那一刻最新的 line
// • line 为 null 时不记（查询为空）
// • 还没到点就卸载了（选中一条、关面板、收起搜索框）：卸载时补记这一行，不然关面板时这一行会丢
// • 只记调用方给的行，调用方负责不把用户打的字放进去
import { useEffect, useRef } from 'react';
import { rlog } from '../../platform/run-log-api.ts';

export function useDebouncedLog(trigger: unknown, line: string | null, ms: number): void {
  const latest = useRef(line);
  const pending = useRef<(() => void) | null>(null);
  useEffect(() => {
    latest.current = line;
  }, [line]);
  // 先声明：卸载时清理按声明顺序跑，要在下面那个 effect 清掉待写之前补记
  useEffect(() => () => pending.current?.(), []);
  useEffect(() => {
    if (latest.current === null) return undefined;
    const fire = (): void => {
      pending.current = null;
      if (latest.current !== null) rlog(latest.current);
    };
    pending.current = fire;
    const id = setTimeout(fire, ms);
    return () => {
      clearTimeout(id);
      if (pending.current === fire) pending.current = null;
    };
  }, [trigger, ms]);
}
