// 天气胶囊的状态（一份，今天页手机两处、宽屏页头、半屏、设置页共用）：看哪儿 → 取天气 → 给界面画什么
// • 看哪儿：设置里手动选的城市优先；没有就“自动定位”：定位权限明确是 granted 时当场取一次（不弹框），否则用上次记下的粗坐标；
//   两样都没有 → 出“设置城市看天气”小胶囊（nudge），点了去 设置 › 天气，那里点“用当前位置”才问定位（负责人 11-26：不要一打开就问）
// • 本机缓存 30 分钟（同一粗坐标）：没过期不发请求；过期或没缓存就取；取不到时有同一地点的缓存就照旧显示、标出取到的时刻（stale），没有就不出胶囊。
//   手里有同一地点能用的缓存时先画上，再去定位、取新的（不空着等）
// • 什么时候再取：挂上、回到前台、页面开着过了一刻钟时，缓存超过 30 分钟才取（refreshIfOld）；设置里改了看哪儿时马上取（load(true)）
// • 同时只跑一次；跑着的时候又要“马上取”（改了城市），跑完接着再跑一次。每次写本机都先重读，只改自己那一项，不把别处刚写的盖掉
// • “设置城市看天气”：第一次出现记下日子；点过一次就从点的那天重新算；连续 7 天没点就不再出；设置里选“不看天气”也不出
// 纯 TS：不准 import React
import { diffDays, todayOf } from '../../../../shared/core/date.ts';
import { createSignal } from '../../../../shared/core/signal.ts';
import { packCoversNow } from '../../../../shared/logic/weather/tips.ts';
import type { WxPack } from '../../../../shared/schema/weather.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { clock } from '../../../platform/clock.ts';
import { geoPermission, locate, type GeoFail } from '../../../platform/geo-locate.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { browserLifecycle } from '../../../platform/net.ts';
import { fetchWeather, searchPlaces } from '../../../platform/weather-net.ts';
import { readWxLocal, writeWxLocal, type WxLocal, type WxPlaceMode } from '../../../platform/weather-store.ts';

/** 本机缓存多久算新（负责人 11-26 定 30 分钟） */
export const WX_FRESH_MS = 30 * 60_000;
/** “设置城市看天气”连续多少天没点就不再出 */
export const NUDGE_DAYS = 7;

export type WxView =
  /** 还没算出来（第一次读本机、等定位、等第一份天气）：什么都不画 */
  | { kind: 'wait' }
  /** 不出胶囊：选了不看天气、取不到又没缓存、小胶囊已经不出了 */
  | { kind: 'none' }
  /** “设置城市看天气” */
  | { kind: 'nudge' }
  /** 有天气：at 是这份取到的时刻；stale 为真时是旧的（刚才没取到新的） */
  | { kind: 'show'; pack: WxPack; at: number; stale: boolean; place: WxPlaceMode };

export interface WxDeps {
  now(): number;
  /** 用户的时区（“连续 7 天”按这里的日子算，同 App 别处） */
  tz(): string;
  read(): WxLocal;
  write(v: WxLocal): void;
  perm(): Promise<'granted' | 'denied' | 'prompt' | 'unsupported'>;
  locate(): ReturnType<typeof locate>;
  fetch(lat: number, lon: number): ReturnType<typeof fetchWeather>;
}

const defaultDeps: WxDeps = {
  now: () => clock.now(),
  tz: () => currentTz(),
  read: readWxLocal,
  write: writeWxLocal,
  perm: geoPermission,
  locate,
  fetch: (lat, lon) => fetchWeather(lat, lon, () => clock.now()),
};

type Coords = { lat: number; lon: number };
type Cached = NonNullable<WxLocal['cache']>;

export function createWeatherState(deps: WxDeps = defaultDeps) {
  let view: WxView = { kind: 'wait' };
  let running: Promise<void> | null = null;
  let again = false;
  const changed = createSignal();
  const set = (v: WxView): void => {
    view = v;
    changed.emit();
  };
  /** 本机的“看哪儿”改了、天气还没取回：换一份同内容的快照让订状态的界面马上重画（设置里单选卡、首页那一行的值不等取天气最长 10 秒） */
  const touch = (): void => set({ ...view });
  const today = (): string => todayOf(deps.now(), deps.tz());
  /** 先重读再改一项（不把别处刚写的盖掉） */
  const patch = (f: (loc: WxLocal) => Partial<WxLocal>): void => {
    const loc = deps.read();
    deps.write({ ...loc, ...f(loc) });
  };
  /** 同一地点、盖得住“现在”的缓存；没有为 null */
  const usable = (cache: WxLocal['cache'], c: Coords): Cached | null =>
    cache && cache.lat === c.lat && cache.lon === c.lon && packCoversNow(cache.pack, deps.now()) ? cache : null;
  const isOld = (at: number): boolean => deps.now() - at >= WX_FRESH_MS;
  const show = (c: Cached, place: WxPlaceMode, stale: boolean): WxView => ({ kind: 'show', pack: c.pack, at: c.at, stale, place });

  /** 小胶囊这一次要不要出（顺手记下第一次出现的日子、到 7 天就记成不再出） */
  const nudgeOrNone = (): WxView => {
    const { nudge } = deps.read();
    if (nudge.gone) return { kind: 'none' };
    const first = nudge.first ?? today();
    if (diffDays(first, today()) >= NUDGE_DAYS) {
      patch(() => ({ nudge: { first, gone: true } }));
      rlog('wx nudge gone=7d');
      return { kind: 'none' };
    }
    if (nudge.first === null) patch(() => ({ nudge: { first, gone: false } }));
    return { kind: 'nudge' };
  };

  /** 看哪儿的粗坐标；没有为 null */
  const coordsOf = async (loc: WxLocal): Promise<Coords | null> => {
    if (loc.place.mode === 'city') return { lat: loc.place.lat, lon: loc.place.lon };
    if ((await deps.perm()) === 'granted') {
      const r = await deps.locate();
      if (r.ok) {
        patch(() => ({ auto: { lat: r.lat, lon: r.lon } }));
        return { lat: r.lat, lon: r.lon };
      }
    }
    return loc.auto;
  };

  const run = async (force: boolean): Promise<void> => {
    const loc = deps.read();
    const { place } = loc;
    if (place.mode === 'off') return set({ kind: 'none' });
    // 手里有上次那个地点能用的就先画上（定位最长要 10 秒，不空着等）
    const last = place.mode === 'city' ? place : loc.auto;
    const guess = last ? usable(loc.cache, last) : null;
    if (guess && view.kind !== 'show') set(show(guess, place, isOld(guess.at)));
    const c = await coordsOf(loc);
    if (!c) return set(nudgeOrNone());
    const cache = usable(deps.read().cache, c);
    if (cache && !force && !isOld(cache.at)) return set(show(cache, place, false));
    const r = await deps.fetch(c.lat, c.lon);
    if (r.ok && packCoversNow(r.value, deps.now())) {
      const fresh: Cached = { lat: c.lat, lon: c.lon, at: deps.now(), pack: r.value };
      patch(() => ({ cache: fresh }));
      return set(show(fresh, place, false));
    }
    // 取不到：同一地点有能用的旧包就显示旧的、标出时间；没有就不出（别的地点的旧包不拿来冒充）
    return set(cache ? show(cache, place, true) : { kind: 'none' });
  };

  /** 跑一次；正在跑就等那一次。force（改了看哪儿）碰上正在跑的：那次跑完接着再跑一次 */
  const load = (force = false): Promise<void> => {
    if (running) {
      again ||= force;
      return running;
    }
    running = (async () => {
      try {
        await run(force);
        while (again) {
          again = false;
          await run(true);
        }
      } finally {
        running = null;
      }
    })();
    return running;
  };

  /** 挂上、回到前台、页面开着过了一刻钟：有天气且没超过 30 分钟就不取 */
  const refreshIfOld = (): void => {
    if (view.kind === 'show' && !isOld(view.at)) return;
    void load();
  };

  return {
    get: (): WxView => view,
    subscribe: (fn: () => void) => changed.subscribe(fn),
    load,
    refreshIfOld,
    /** 设置里点“用当前位置”：这时才问定位。成功：改成自动定位、记下粗坐标、重新取；失败回原因（界面让人手动选城市） */
    async askHere(): Promise<{ ok: true } | { ok: false; why: GeoFail }> {
      patch((loc) => ({ nudge: { ...loc.nudge, first: today() } }));
      const r = await deps.locate();
      if (!r.ok) return r;
      patch(() => ({ place: { mode: 'auto' }, auto: { lat: r.lat, lon: r.lon } }));
      touch();
      await load(true);
      return { ok: true };
    },
    /** 点了“设置城市看天气”去设置页：从今天重新算 7 天 */
    nudgeTapped(): void {
      patch((loc) => ({ nudge: { ...loc.nudge, first: today() } }));
    },
    /** 设置里改看哪儿（手动城市 / 自动定位 / 不看天气），改完重新取 */
    async setPlace(place: WxPlaceMode): Promise<void> {
      patch((loc) => ({ place, nudge: place.mode === 'off' ? { ...loc.nudge, gone: true } : loc.nudge }));
      rlog(`wx place mode=${place.mode}`);
      touch();
      await load(true);
    },
    place: (): WxPlaceMode => deps.read().place,
    /** 回到前台时 refreshIfOld；返回取消函数 */
    watchForeground(): () => void {
      return browserLifecycle.onVisibility((visible) => {
        if (visible) refreshIfOld();
      });
    },
  };
}

/** 设置 › 天气 的城市搜索（经 /wx/v1/geo；回粗坐标） */
export const searchCity = (q: string, lang: 'zh' | 'ko') => searchPlaces(q, lang, () => clock.now());

export type WeatherState = ReturnType<typeof createWeatherState>;

/** App 里只有这一份 */
export const weatherState = createWeatherState();
