// logs 一行（客户端写得了的列）和上传结果（架构 0.38 第 68 条；数据字典 4.6）
// 放 shared：core/log/queue.ts（队列规矩）和 platform/supabase/log-upload.ts（批量 insert）都引这一份，core 不再从 platform 引类型
// 列按迁移 0001 的列级授权：insert (t, device, kind, act, src, coll, item_id, fields, code)；user_id 由默认值 auth.uid() 填
export interface LogRow {
  t: number;
  act: string;
  coll?: string;
  code?: string;
  item_id?: string;
  fields?: string[];
}

/**
 * 一批的上传结果：
 * • ok：写上了
 * • drop：这一批整个丢掉、不重试——超了每人每天的额度（quota）、RLS 拒绝（42501）
 * • bad：数据错误（22xxx、23xxx）：一批里至少有一条有问题，队列二分重传，只丢真正出错的那一条
 * • retry：断网、超时、5xx、401、408、426、429 和其余 4xx：留着下次再传
 */
export type LogUploadResult = 'ok' | 'drop' | 'bad' | 'retry';
