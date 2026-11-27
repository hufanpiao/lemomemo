// mine、admin_get 两份读回来的东西放在内存里共用：设置首页“我的 AI”“AI 服务商”两行、两个二级页、密钥详情页读同一份，
// 首页读过一次进二级页不再白等；每个二级页进来照样重读一次（别处改过也能看到新的），改完（改用、删除、存密钥、换哪家）也重读
// • 只在内存、只在这一次打开 app 里；不写 localStorage、不写库（里面没有密钥，只有后四位，也不存）
// • 退出登录换人：设置页整页卸载以后下次进来照样先重读；这里不盯会话，首页那一行在重读回来之前可能先显示上一个人的值（同一台手机上换账号才会碰到）
// 纯 TS：不准 import React
import type { AdminGetRes, MineRes } from '../../../../shared/schema/ai-provider.ts';

export type Load<T> = { kind: 'loading' } | { kind: 'error' } | { kind: 'ok'; value: T };

interface Box<T> {
  get(): Load<T>;
  set(v: Load<T>): void;
  subscribe(fn: () => void): () => void;
}

function box<T>(): Box<T> {
  let v: Load<T> = { kind: 'loading' };
  const subs = new Set<() => void>();
  return {
    get: () => v,
    set(next) {
      v = next;
      for (const fn of subs) fn();
    },
    subscribe(fn) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
  };
}

export const mineBox: Box<MineRes> = box<MineRes>();
export const adminBox: Box<AdminGetRes> = box<AdminGetRes>();

/** 重读失败时：已经有读到的就留着（别把页面刷成“读不出来”），从没读到过才写 error */
export function keepOrFail<T>(b: Box<T>): void {
  if (b.get().kind !== 'ok') b.set({ kind: 'error' });
}
