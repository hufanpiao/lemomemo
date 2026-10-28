// arch-fixture: path=src/kit/components/Good.tsx expect=none
// 对照组（UI-4 L-4）：自己画遮罩的 Dialog、DropdownMenu.Root modal={false} 都可以
import * as RD from '@radix-ui/react-dialog';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { ReactNode } from 'react';
export const Sheet = ({ children }: { children: ReactNode }) => (
  <RD.Root open>
    <RD.Portal>
      <div className="scrim" />
      <RD.Content>{children}</RD.Content>
    </RD.Portal>
  </RD.Root>
);
export const Menu = ({ children }: { children: ReactNode }) => <DropdownMenu.Root modal={false}>{children}</DropdownMenu.Root>;
