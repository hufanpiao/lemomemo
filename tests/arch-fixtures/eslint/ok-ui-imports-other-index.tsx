// arch-fixture: path=src/features/plus/ui/Good.tsx expect=none
// 对照（应通过）：经别的功能的 index.ts 引用；用 kit 和 hrefOf
import { routes } from '../../notes/index.ts';
import { Placeholder } from '../../../kit/components/Placeholder.tsx';
import { hrefOf } from '../../../app/router.ts';

export function Good() {
  return (
    <a href={hrefOf('notes')}>
      <Placeholder feature={routes[0].name} />
    </a>
  );
}
