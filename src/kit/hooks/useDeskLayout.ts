// 电脑版布局的读写（架构 5.9b 第 1、3、4 点；0.29 续第 109 条）：一页一行 settings，键 layout.<页>@inst:<install_id>
// • install_id：platform/device-info.ts 的 readInstallId（这一份安装的随机 id，退出登录也不清）；读不到（隐私模式）时只在内存里改、不存
// • 读：layout-model.ts 的 readLayout；坏值用默认、不自动写回，记一条 logs（act layout、code layout_invalid，不记内容）
// • 写：放下即保存（经 kit 的 useSettingWriter，进 outbox、本机先生效）；界面先按新布局画（local），不等集合跟上
// • 撤销只留一步：记着改之前的布局，撤销就把它写回去
// • “恢复默认布局”= 把代码里的默认布局写进这一行（B6 代定：5.9b 写的是删掉这一行，但 A31 不准客户端对 settings 发软删，
//   要删得先在架构 0.41 登记、给 lemo/settings-ai-write 开口；写默认值效果一样，以后默认布局多了块，readLayout 照样按默认位置补）
// • 运行日志（不记内容）：desk on / off（这一页换成电脑布局 / 换回手机布局）、desk mode（分栏 cols ↔ 一列 one）、
//   desk load（读到什么）、desk save（改了哪一类）、desk undo、desk reset
// • 放在 kit/hooks：kit 的组件不准碰 core、platform（ESLint boundaries），DeskLayout 组件经这里读写、记日志
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DeskLayoutValue } from '../../../shared/schema/layout.ts';
import { logEvent } from '../../../shared/core/log-bus.ts';
import { settingValue } from '../../core/setting-read.ts';
import { readInstallId } from '../../platform/device-info.ts';
import { rlog } from '../../platform/run-log-api.ts';
import { useSettingWriter } from './useSettingWriter.ts';
import { readLayout, sameLayout, toStored } from '../components/DeskLayout/layout-model.ts';

/** 布局切换的运行日志：挂上记 desk on、卸下记 desk off，分栏和一列换了记 desk mode */
export function useDeskModeLog(page: string, wide: boolean): void {
  useEffect(() => {
    rlog(`desk on page=${page}`);
    return () => rlog(`desk off page=${page}`);
  }, [page]);
  useEffect(() => rlog(`desk mode page=${page} mode=${wide ? 'cols' : 'one'}`), [page, wide]);
}

/** 这次改的是哪一类（日志和提示条用） */
export type LayoutChange = 'move' | 'width' | 'collapse' | 'expand' | 'drawer' | 'lock' | 'unlock';

export const layoutKey = (page: string, inst: string): string => `layout.${page}@inst:${inst}`;

export function useDeskLayout(page: string, def: DeskLayoutValue) {
  const [inst] = useState(() => readInstallId());
  const key = inst ? layoutKey(page, inst) : null;
  const { rows, writer } = useSettingWriter();
  const raw = key ? settingValue(rows, key) : undefined;
  const read = useMemo(() => readLayout(raw, def), [raw, def]);
  /** 本页改过的（集合跟上之前、或者存不了的时候）按它画；null 时按读出来的 */
  const [local, setLocal] = useState<DeskLayoutValue | null>(null);
  const layout = local ?? read.layout;
  /** 撤销用的上一步（只留一步） */
  const prev = useRef<DeskLayoutValue | null>(null);
  /** “布局已保存”提示条：每存一次加 1（换 key 重新计时），null 不显示 */
  const [saved, setSaved] = useState<number | null>(null);

  const logged = useRef(false);
  useEffect(() => {
    if (logged.current) return;
    logged.current = true;
    rlog(`desk load page=${page} status=${read.status} cols=${read.layout.cols.length} collapsed=${read.layout.collapsed.length} inst=${inst ? 1 : 0}`);
    if (read.status === 'invalid') logEvent('layout', { code: 'layout_invalid' });
  }, [page, read, inst]);

  /** 换成 next 并保存；what 进运行日志（reset、undo 也走这里） */
  const apply = useCallback(
    (next: DeskLayoutValue, what: LayoutChange | 'reset' | 'undo') => {
      setLocal(next);
      rlog(`desk ${what === 'reset' || what === 'undo' ? what : `save what=${what}`} page=${page} cols=${next.cols.length} collapsed=${next.collapsed.length}`);
      if (key) void writer.save(key, toStored(next));
    },
    [page, key, writer],
  );

  const commit = useCallback(
    (next: DeskLayoutValue, what: LayoutChange | 'reset') => {
      if (sameLayout(next, layout)) return;
      prev.current = layout;
      setSaved((n) => (n ?? 0) + 1);
      apply(next, what);
    },
    [layout, apply],
  );

  const undo = useCallback(() => {
    const p = prev.current;
    if (!p) return;
    prev.current = null;
    setSaved(null);
    apply(p, 'undo');
  }, [apply]);

  const reset = useCallback(() => commit(def, 'reset'), [commit, def]);

  return { layout, commit, undo, reset, saved, closeSaved: useCallback((k: number) => setSaved((n) => (n === k ? null : n)), []) };
}
