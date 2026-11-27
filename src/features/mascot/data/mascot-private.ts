// 吉祥物 #2：同人作品，文件不进仓库、构建产物和公开 CDN，放在私有桶 mascot-private（迁移 20261123120000，只有管理员能读）
// • 这个模块只从懒加载块引用；每次按需下载，cache: 'no-store'，不进 SW 的 lemo-mascot，也不落本机，退出登录不用另外清
// • 署名存在桶里这个文件的元数据上（work、author、url，许可证 license、license_url 可选），代码和产物里不写，只有读得到文件的管理员能看到
import type { MascotDef } from '../../../../shared/schema/mascot.ts';
import { getSupabase } from '../../../platform/supabase/client.ts';

const BUCKET = 'mascot-private';
const PATH = '2.riv';

/** 舞台认这个地址，走下面的私有下载 */
export const PRIVATE_URL = 'private:2';

/** 显示参数照定稿演示页；点头摇头的幅度是演示页的一半系数（0.35 × 0.5），裁切左边留足，头转到最左也不出框 */
export const PRIVATE_DEF: MascotDef = {
  url: PRIVATE_URL,
  size: [1600, 1200],
  crop: [180, 20, 1240, 1120],
  novm: true,
  look: { node: 'mainHeadControl', rest: [-3.81, 4.61], restAB: [804.74, 770.36], toLocal: (x, y) => [(x - 812.36) / 2, (y - 761.14) / 2], reach: 520, wig: 0.175 },
  // 勾完：雷神模式亮 0.9 秒再点头
  react: { done: [{ do: 'pulse', input: 'thunderGodMode', ms: 900 }, { do: 'nod' }], add: [{ do: 'nod' }], del: [{ do: 'shake' }] },
};

export async function downloadPrivateRiv(): Promise<ArrayBuffer> {
  const db = await getSupabase();
  const { data, error } = await db.storage.from(BUCKET).download(PATH, {}, { cache: 'no-store' });
  if (error || !data) throw new Error('riv_private');
  return data.arrayBuffer();
}

export interface PrivateCredit {
  work: string;
  author: string;
  url: string;
  /** 许可证（元数据 license、license_url）：没写就不显示这一行；链接不是 https 的只显示名字 */
  license?: { name: string; url?: string };
}

const https = (v: unknown): v is string => typeof v === 'string' && v.startsWith('https://');

/** 元数据 → 署名；缺项或链接不是 https 的不显示 */
export function creditOf(meta: unknown): PrivateCredit | null {
  if (typeof meta !== 'object' || meta === null) return null;
  const { work, author, url, license, license_url: licenseUrl } = meta as Record<string, unknown>;
  if (typeof work !== 'string' || work === '' || typeof author !== 'string' || author === '') return null;
  if (!https(url)) return null;
  if (typeof license !== 'string' || license === '') return { work, author, url };
  return { work, author, url, license: https(licenseUrl) ? { name: license, url: licenseUrl } : { name: license } };
}

export async function readPrivateCredit(): Promise<PrivateCredit | null> {
  const db = await getSupabase();
  const { data, error } = await db.storage.from(BUCKET).info(PATH);
  if (error || !data) return null;
  return creditOf((data as unknown as { metadata?: unknown }).metadata);
}
