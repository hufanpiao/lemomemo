// arch-fixture: path=src/kit/components/Bad.tsx expect=boundaries/dependencies rule=A1
// 违规（0.31 第 3 条）：下层只准引 app/router.ts，App.tsx 这类 app 的其他文件一律不准
import { App } from '../../app/App.tsx';
export const A = App;
