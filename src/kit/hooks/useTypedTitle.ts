// 新建页接住打字条“展开编辑”带过来的字（B3 R-353：已经打的字带过去，不丢字）：
// 新建（id 为 'new'）的表单挂上以后，从 kit/state/new-item.ts 取走那段字，当成用户打的填进标题（走 change，照常保存）。
// 只取一次：StrictMode 下 effect 跑两遍也只填一次；取走就清，下次新建不沿用
import { useEffect, useRef } from 'react';
import { takeNewItemTitle } from '../state/new-item.ts';

export function useTypedTitle(id: string, change: (p: { title: string }) => void): void {
  const done = useRef(false);
  useEffect(() => {
    if (done.current || id !== 'new') return;
    done.current = true;
    const t = takeNewItemTitle();
    if (t !== null && t.trim() !== '') change({ title: t });
  }, [id, change]);
}
