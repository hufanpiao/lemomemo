// arch-fixture: path=src/features/notes/hooks/useBad.ts expect=react-hooks/rules-of-hooks rule=T3
// 违规：条件里调 hook
import { useState } from 'react';

export function useBad(on: boolean) {
  if (on) {
    const [x] = useState(0);
    return x;
  }
  return 0;
}
