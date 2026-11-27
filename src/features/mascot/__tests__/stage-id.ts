// 测试用：模拟的 createStage 只拿到显示参数，按素材地址认出是哪一只（#2 是私有地址）
import { MASCOTS } from '../data/catalog.ts';
import { PRIVATE_URL } from '../data/mascot-private.ts';

export const stageId = (def: { url: string }): string =>
  def.url === PRIVATE_URL ? '2' : (Object.entries(MASCOTS).find(([, d]) => d.url === def.url)?.[0] ?? `?${def.url}`);
