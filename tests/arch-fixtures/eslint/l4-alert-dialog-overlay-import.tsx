// arch-fixture: path=src/kit/components/Bad.tsx expect=no-restricted-syntax message=CSP count=2 rule=L4
// 违规（架构 2.0、UI-4 L-4）：换成具名 import 也不行（AlertDialog 的 Overlay 同样带 react-remove-scroll）
import { AlertDialogOverlay, Overlay } from '@radix-ui/react-alert-dialog';
export const parts = [Overlay, AlertDialogOverlay];
