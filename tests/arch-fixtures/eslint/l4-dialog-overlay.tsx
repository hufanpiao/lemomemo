// arch-fixture: path=src/kit/components/Bad.tsx expect=no-restricted-syntax message=CSP rule=L4
// 违规（架构 2.0、UI-4 L-4）：Radix Dialog.Overlay 带 react-remove-scroll，会插内联 <style>，被 style-src 'self' 拦；遮罩自己画
import * as RD from '@radix-ui/react-dialog';
export const Bad = () => (
  <RD.Root open>
    <RD.Portal>
      <RD.Overlay />
    </RD.Portal>
  </RD.Root>
);
