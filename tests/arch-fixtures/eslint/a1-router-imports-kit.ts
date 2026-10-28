// arch-fixture: path=src/app/router.ts expect=no-restricted-imports message=router.ts rule=A1
// 违规（0.31 第 3 条）：router.ts 下层也能引，所以它不能 import kit（也不能 import 功能、platform、app 的其他文件）
import { Placeholder } from '../kit/components/Placeholder.tsx';
export const P = Placeholder;
