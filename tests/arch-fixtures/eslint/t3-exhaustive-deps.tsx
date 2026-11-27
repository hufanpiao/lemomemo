// arch-fixture: path=src/features/notes/ui/Bad.tsx expect=react-hooks/exhaustive-deps rule=T3
// 违规：依赖没写全
import { useEffect } from 'react';

export function Bad({ id, onLoad }: { id: string; onLoad: (id: string) => void }) {
  useEffect(() => {
    onLoad(id);
  }, []);
  return null;
}
