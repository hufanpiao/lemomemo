// 今天页要不要下载纪念日一行：纪念日开关开着、有纪念日才下载 AnnivLine；挑哪一条（7 天内最近的）在 AnnivLine 里算（hooks/useAnnivUpcoming.ts），
// 挑选的代码不进首屏（这里只留最小的判断）
import { annivOn } from '../../../kit/hooks/anniv-on.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';

export function useAnnivAny(): boolean {
  return useCollection('anniversaries').length > 0 && annivOn();
}
