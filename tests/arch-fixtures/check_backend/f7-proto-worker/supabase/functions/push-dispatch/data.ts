// 违规 F7（第四轮必改 2）：import 地址是 data: / blob:，静态、动态都报
import d from 'data:text/javascript,export default 1';
export const e = await import('blob:https://example.com/x');
export { d };
