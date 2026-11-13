// 设置 › 字体（架构 5.9c；R-128、R-135）：可选字体清单（platform/fonts.ts 读 /app/fonts-index.json）、现在的下载状态、选了哪个。
// 选择存 ui.font（经 useLookSetting，按账号存）；真正下载、套上由 platform/look.ts 盯着 settings 交给 platform/fonts.ts
import { useEffect, useState, useSyncExternalStore } from 'react';
import { fontIndex, fontState, retryFont, type FontEntry } from '../../../platform/fonts.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { useLookSetting } from './useLookSetting.ts';

/** list：二级页总要清单；首页那一行只在选了系统字体以外的字体时才读清单（系统字体的人打开设置不多发一个请求） */
export function useFontSetting(list = false) {
  const { look, set, error } = useLookSetting();
  const [fonts, setFonts] = useState<readonly FontEntry[]>([]);
  const need = list || look.font !== 'system';
  useEffect(() => {
    if (!need) return;
    let live = true;
    void fontIndex().then((f) => live && setFonts(f));
    return () => {
      live = false;
    };
  }, [need]);
  const state = useSyncExternalStore(fontState.subscribe, fontState.get);
  const locale = useUi((s) => s.locale);
  const label = (f: FontEntry) => (locale.startsWith('ko') ? f.label.ko : f.label.zh);
  // 设置里的值清单里没有（登记删了、源字体文件还没放进来）：按系统字体显示，不写回（5.9c 第 4 点）
  const chosen = fonts.find((f) => f.id === look.font);
  return {
    fonts,
    label,
    value: chosen ? chosen.id : 'system',
    chosenLabel: chosen ? label(chosen) : null,
    // 状态按“是不是现在选中的这种字体”认（整块评审第 11 条）：清单还没读到时首页那一行照样显示下载进度
    state: state.id === look.font ? state : { id: look.font, status: 'ok' as const, pct: 100 },
    pick: (id: string) => set('font', id),
    retry: () => void retryFont(),
    error,
  };
}
