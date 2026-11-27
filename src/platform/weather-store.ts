// 天气在本机记的东西（只在这台设备，不同步到账号、不上服务器；负责人 11-26 定坐标不存服务器）：一个 localStorage 键 lemo.wx
// • place：天气看哪儿——auto 自动定位（默认）、city 手动选的城市（名字 + 粗坐标）、off 不看天气（设置里关掉）
// • auto：上次自动定位拿到的粗坐标（iOS 的定位权限状态不可靠，不能每次打开都问，见 geo-locate.ts）
// • cache：上次取到的天气包、取到的时刻和那时的坐标（本机缓存 30 分钟；没网时照样拿来显示，标出时间；坐标对不上的不拿来用）
// • nudge：“设置城市看天气”小胶囊——第一次出现（或上次点）的日子、关掉没有（关掉或连续 7 天没点就不再出）
// 退出、换账号时整份删掉：只走 exit-basics.ts 的 forgetAccountLocal（键名定义在那里）
// 读出来先过 zod，坏了当没有；写不进（隐私模式、满了）不报错
// 纯 TS：不准 import React
import { z } from 'zod';
import { wxPackSchema } from '../../shared/schema/weather.ts';
import { WX_LOCAL_KEY } from './exit-basics.ts';

const placeSchema = z.union([
  z.object({ mode: z.literal('auto') }),
  // key：内置常用城市（shared/logic/weather/cities.ts），显示时按当前语言取名字；没有 key 的照旧用 name（搜索时那种语言）
  z.object({ mode: z.literal('city'), key: z.string().max(40).optional(), name: z.string().min(1).max(80), lat: z.number().finite(), lon: z.number().finite() }),
  z.object({ mode: z.literal('off') }),
]);
const localSchema = z.object({
  v: z.literal(1),
  place: placeSchema,
  auto: z.object({ lat: z.number().finite(), lon: z.number().finite() }).nullable(),
  cache: z.object({ lat: z.number(), lon: z.number(), at: z.number(), pack: wxPackSchema }).nullable(),
  nudge: z.object({ first: z.string().nullable(), gone: z.boolean() }),
});
export type WxLocal = z.infer<typeof localSchema>;
export type WxPlaceMode = z.infer<typeof placeSchema>;

export const emptyWxLocal = (): WxLocal => ({ v: 1, place: { mode: 'auto' }, auto: null, cache: null, nudge: { first: null, gone: false } });

function storage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** 读本机那份；没有、坏了都回一份空的 */
export function readWxLocal(): WxLocal {
  let raw: unknown = null;
  try {
    const s = storage()?.getItem(WX_LOCAL_KEY);
    raw = s ? (JSON.parse(s) as unknown) : null;
  } catch {
    raw = null;
  }
  const r = localSchema.safeParse(raw);
  return r.success ? r.data : emptyWxLocal();
}

export function writeWxLocal(v: WxLocal): void {
  try {
    storage()?.setItem(WX_LOCAL_KEY, JSON.stringify(v));
  } catch {
    // 写不进：这次照样用内存里的
  }
}
