// arch-fixture: path=src/kit/components/Bad.tsx expect=boundaries/dependencies
// 违规：kit 不能 import 任何功能
import { routes } from '../../features/notes/index.ts';
export const r = routes;
