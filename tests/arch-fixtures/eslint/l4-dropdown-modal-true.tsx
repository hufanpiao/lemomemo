// arch-fixture: path=src/kit/components/Bad.tsx expect=no-restricted-syntax message=CSP count=3 rule=A29
// 违规（架构 2.0、UI-4 L-4）：modal、modal={true}、modal={变量} 都不算 modal={false}
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { ReactNode } from 'react';
export const A = ({ children }: { children: ReactNode }) => <DropdownMenu.Root modal>{children}</DropdownMenu.Root>;
export const B = ({ children }: { children: ReactNode }) => <DropdownMenu.Root modal={true}>{children}</DropdownMenu.Root>;
export const C = ({ children, m }: { children: ReactNode; m: boolean }) => <DropdownMenu.Root modal={m}>{children}</DropdownMenu.Root>;
