// 随手记（B2 时还没上线）：底栏点“随手记”进来，只写“即将推出”（负责人 11-05 ②，中韩文案都有）；对应批次换成真正的界面
import { Placeholder } from '../../../kit/components/Placeholder.tsx';
import { useT } from '../../../kit/hooks/useT.ts';

export default function NotesPage() {
  const t = useT();
  return <Placeholder feature="notes" title={t('nav.notes', {})} note={t('notes.soon', {})} />;
}
