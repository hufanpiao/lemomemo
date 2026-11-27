// arch-fixture: path=src/kit/components/Bad.tsx expect=no-restricted-syntax message=CSP rule=A29
// 违规（UI-4 L-4）：DropdownMenu 只准 import * as DropdownMenu，具名引 Root 会绕过“必须 modal={false}”的检查
import { Root } from '@radix-ui/react-dropdown-menu';
export const R = Root;
