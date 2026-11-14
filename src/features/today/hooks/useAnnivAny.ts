// 今天页要不要下载纪念日一行（B5 S14）：纪念日开关开着、有纪念日才下载 AnnivLine；挑哪一条（7 天内最近的）在 AnnivLine 里算（hooks/useAnnivUpcoming.ts），
// 挑选的代码不进首屏（主持人 11-13：B5 首屏增量压到 200 B 以内）
import { annivOn } from '../../../kit/hooks/anniv-on.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';

export function useAnnivAny(): boolean {
  return useCollection('anniversaries').length > 0 && annivOn();
}
