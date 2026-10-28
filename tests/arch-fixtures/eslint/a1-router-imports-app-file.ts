// arch-fixture: path=src/app/router.ts expect=no-restricted-imports
// 违规（0.31 第 3 条）：router.ts 不能 import app 的其他文件，否则下层引它就把整个 app 拖进来
import { App } from './App.tsx';
export const A = App;
