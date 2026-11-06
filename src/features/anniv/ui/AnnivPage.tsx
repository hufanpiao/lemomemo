// 【B0 占位】anniv 的页面，对应批次换成真正的界面
// 纪念日还没做好（B2 全站视觉审查 A2）：日历上的入口已置灰；地址栏手打 #/anniv 进来的，原地换回日历页（replace，后退不会再回到这里）
import { useEffect } from 'react';
import { replaceRoute } from '../../../app/router.ts';

export default function AnnivPage() {
  useEffect(() => {
    void replaceRoute('calendar');
  }, []);
  return null;
}
