// arch-fixture: path=src/kit/components/Bad.tsx expect=no-restricted-syntax message=CSP rule=A29
// 违规（架构 2.0、UI-4 L-4）：DropdownMenu.Root 默认 modal，会挂 react-remove-scroll 插内联 <style>；必须写 modal={false}
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { ReactNode } from 'react';
export const Bad = ({ children }: { children: ReactNode }) => <DropdownMenu.Root>{children}</DropdownMenu.Root>;
