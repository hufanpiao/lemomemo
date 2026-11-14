// 现在算不算在线（第三方审查前端-12：同一个表达式原来在 11 处各写一份）：浏览器明确说离线（navigator.onLine === false）才算离线，读不到当在线。
// 断网提示选“没有网络”还是“暂时连不上服务器”、重试前看一眼、按钮灰不灰都用这一份；要跟着 online / offline 事件变的用 kit/hooks/useOnline.ts
// 纯 TS：不准 import React 和任何功能（A1）
export const onlineNow = (): boolean => typeof navigator === 'undefined' || navigator.onLine !== false;
