// 打字条开着时在历史里垫一条（负责人 11-18 录屏：“展开以后左滑退出的时候会闪一下简约输入框”）。
// 根因：iPhone 从左边缘侧滑返回时，底下那一页画的是离开它那一刻系统拍的截图（WebKit 在压新历史时拍）；原来“展开编辑”从今天页
// 直接压新建页那一条，拍下的是打字条和模糊层还盖着的画面，划回来先显示这张截图（录屏第 256～270、476～489 帧），
// 今天页重画完才换成真页面，看着就是闪了一下打字条。
// 做法：打字条画出来之前（useLayoutEffect：这一帧还没上屏）在同一地址垫一条历史（app/router-sub.ts 的 pushTypeEntry），截图拍在这一刻，
// 是打开前干净的页面；“展开编辑”等从这一条出发的换页由路由器换掉它、不再压（app/router.ts 的 goHref），历史里不多出一条；
// 打字条收起（或只留“已记下”提示条）时退掉这一条；侧滑返回、浏览器后退已经把它退掉了，打字条跟着收起（onBack）。
// StrictMode 卸了又挂的那一下：退掉推迟到下一个任务，紧接着又挂上就取消，不重复垫。
// 运行日志 typebar entry push|pop|back（只记动作）
import { useLayoutEffect, useRef } from 'react';
import { goBack } from '../../../app/router.ts';
import { onTypeEntry, pushTypeEntry } from '../../../app/router-sub.ts';
import { rlog } from '../../../platform/run-log-api.ts';

/** 推迟到下一个任务的退出（StrictMode 重挂时取消） */
let leaving: ReturnType<typeof setTimeout> | null = null;
/** 自己调了后退、那一次 popstate 还没派完：这期间的 popstate 不当成用户返回 */
let popping = false;

function popOwn(): void {
  if (!onTypeEntry()) return;
  rlog('typebar entry pop');
  popping = true;
  // 这一次 popstate 派完（所有监听都看到 popping）以后再清
  window.addEventListener('popstate', () => setTimeout(() => (popping = false), 0), { once: true });
  goBack();
}

/** open：打字条画着（没收起）；onBack：这一条被侧滑返回、浏览器后退退掉了 */
export function useTypeEntry(open: boolean, onBack: () => void): void {
  const back = useRef(onBack);
  back.current = onBack;
  useLayoutEffect(() => {
    if (!open) return;
    if (leaving !== null) {
      clearTimeout(leaving);
      leaving = null;
    } else if (!onTypeEntry()) {
      pushTypeEntry();
      rlog('typebar entry push');
    }
    const onPop = (): void => {
      if (popping || onTypeEntry()) return;
      rlog('typebar entry back');
      back.current();
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      leaving = setTimeout(() => {
        leaving = null;
        popOwn();
      }, 0);
    };
  }, [open]);
}
