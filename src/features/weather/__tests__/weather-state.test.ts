// 天气胶囊的状态（data/weather-state.ts）：看哪儿、本机缓存 30 分钟、取不到用旧的标出时刻、“设置城市看天气”7 天没点不再出、不一打开就问定位
import { describe, expect, it, vi } from 'vitest';
import { createWeatherState, NUDGE_DAYS, WX_FRESH_MS, type WxDeps } from '../data/weather-state.ts';
import { emptyWxLocal, type WxLocal } from '../../../platform/weather-store.ts';
import { makePack, NOW } from '../../../../tests/shared/weather/wx-fixture.ts';

vi.mock('../../../platform/run-log-api.ts', () => ({ rlog: () => undefined }));

const DAY = 86_400_000;

function setup(init: Partial<WxLocal> = {}, opts: { perm?: Awaited<ReturnType<WxDeps['perm']>>; fetchOk?: boolean; locateOk?: boolean } = {}) {
  let store: WxLocal = { ...emptyWxLocal(), ...init };
  let now = NOW;
  const pack = makePack();
  const deps: WxDeps = {
    now: () => now,
    tz: () => 'Asia/Seoul',
    read: () => store,
    write: (v) => {
      store = v;
    },
    perm: vi.fn(async () => opts.perm ?? 'prompt'),
    locate: vi.fn(async () => (opts.locateOk === false ? { ok: false as const, why: 'denied' as const } : { ok: true as const, lat: 37.6, lon: 127 })),
    fetch: vi.fn(async () => (opts.fetchOk === false ? { ok: false as const, why: 'offline' as const } : { ok: true as const, value: pack })),
  };
  const s = createWeatherState(deps);
  return { s, deps, pack, store: () => store, tick: (ms: number) => void (now += ms) };
}

describe('看哪儿', () => {
  it('手动城市优先，不问定位', async () => {
    const { s, deps } = setup({ place: { mode: 'city', name: '부산', lat: 35.2, lon: 129.1 } }, { perm: 'granted' });
    await s.load();
    expect(deps.locate).not.toHaveBeenCalled();
    expect(deps.fetch).toHaveBeenCalledWith(35.2, 129.1);
    expect(s.get().kind).toBe('show');
  });
  it('自动定位：权限明确 granted 才当场取位置（不弹框）', async () => {
    const { s, deps, store } = setup({}, { perm: 'granted' });
    await s.load();
    expect(deps.locate).toHaveBeenCalledTimes(1);
    expect(store().auto).toEqual({ lat: 37.6, lon: 127 });
  });
  it('权限是 prompt（iOS 同意后也可能这样回）：不取位置，用上次记下的粗坐标', async () => {
    const { s, deps } = setup({ auto: { lat: 37.5, lon: 126.9 } }, { perm: 'prompt' });
    await s.load();
    expect(deps.locate).not.toHaveBeenCalled();
    expect(deps.fetch).toHaveBeenCalledWith(37.5, 126.9);
  });
  it('没有城市、没有记下的坐标：出“设置城市看天气”，不一打开就问定位', async () => {
    const { s, deps } = setup();
    await s.load();
    expect(deps.locate).not.toHaveBeenCalled();
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(s.get()).toEqual({ kind: 'nudge' });
  });
  it('选了不看天气：什么都不出', async () => {
    const { s, deps } = setup({ place: { mode: 'off' }, auto: { lat: 1, lon: 1 } });
    await s.load();
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(s.get()).toEqual({ kind: 'none' });
  });
});

describe('本机缓存 30 分钟', () => {
  it('同一粗坐标 30 分钟内不再发请求；过了就再取', async () => {
    const { s, deps, tick } = setup({ auto: { lat: 37.6, lon: 127 } });
    await s.load();
    tick(WX_FRESH_MS - 1000);
    await s.load();
    expect(deps.fetch).toHaveBeenCalledTimes(1);
    tick(2000);
    await s.load();
    expect(deps.fetch).toHaveBeenCalledTimes(2);
  });
  it('回到前台：没过 30 分钟不取，过了才取', async () => {
    const { s, deps, tick } = setup({ auto: { lat: 37.6, lon: 127 } });
    await s.load();
    s.refreshIfOld();
    await s.load();
    expect(deps.fetch).toHaveBeenCalledTimes(1);
    tick(WX_FRESH_MS + 1);
    s.refreshIfOld();
    await s.load();
    expect(deps.fetch).toHaveBeenCalledTimes(2);
  });
  it('取不到：有旧的就显示旧的、标 stale 和取到的时刻；没有就不出', async () => {
    const ok = setup({ auto: { lat: 37.6, lon: 127 } });
    await ok.s.load();
    const at = NOW;
    const off = setup({ auto: { lat: 37.6, lon: 127 }, cache: ok.store().cache }, { fetchOk: false });
    off.tick(WX_FRESH_MS + 1);
    await off.s.load();
    expect(off.s.get()).toMatchObject({ kind: 'show', stale: true, at });
    const none = setup({ auto: { lat: 37.6, lon: 127 } }, { fetchOk: false });
    await none.s.load();
    expect(none.s.get()).toEqual({ kind: 'none' });
  });
  it('设置里改城市：写完本机当场换快照通知界面（单选卡、首页那一行不等取天气）', async () => {
    const { s, deps } = setup({ auto: { lat: 37.6, lon: 127 } });
    let release: () => void = () => undefined;
    vi.mocked(deps.fetch).mockImplementationOnce(() => new Promise((ok) => (release = () => ok({ ok: false, why: 'offline' }))));
    const before = s.get();
    const seen: string[] = [];
    const off = s.subscribe(() => seen.push(s.place().mode));
    const done = s.setPlace({ mode: 'city', name: 'X', lat: 35.2, lon: 129.1 });
    expect(seen[0]).toBe('city');
    expect(s.get()).not.toBe(before);
    await vi.waitFor(() => expect(deps.fetch).toHaveBeenCalledWith(35.2, 129.1));
    release();
    await done;
    off();
  });
  it('换了城市不用别处的缓存', async () => {
    const first = setup({ auto: { lat: 37.6, lon: 127 } });
    await first.s.load();
    const moved = setup({ place: { mode: 'city', name: 'X', lat: 35.2, lon: 129.1 }, cache: first.store().cache });
    await moved.s.load();
    expect(moved.deps.fetch).toHaveBeenCalledWith(35.2, 129.1);
  });
  it('同一地点有缓存：先画上旧的，再去定位、取新的（不空着等定位）', async () => {
    const ok = setup({ auto: { lat: 37.6, lon: 127 } });
    await ok.s.load();
    let release: () => void = () => undefined;
    const t = setup({ auto: { lat: 37.6, lon: 127 }, cache: ok.store().cache }, { perm: 'granted' });
    t.tick(WX_FRESH_MS + 1);
    vi.mocked(t.deps.locate).mockImplementationOnce(() => new Promise((r) => (release = () => r({ ok: true, lat: 37.6, lon: 127 }))));
    const p = t.s.load();
    await vi.waitFor(() => expect(t.deps.locate).toHaveBeenCalled());
    expect(t.s.get()).toMatchObject({ kind: 'show', stale: true });
    release();
    await p;
    expect(t.s.get()).toMatchObject({ kind: 'show', stale: false });
  });
  it('自动定位取不到：别的地点（以前手动城市）的旧包不拿来冒充当前位置', async () => {
    const city = setup({ place: { mode: 'city', name: 'X', lat: 35.2, lon: 129.1 } });
    await city.s.load();
    const t = setup({ auto: { lat: 37.6, lon: 127 }, cache: city.store().cache }, { fetchOk: false });
    await t.s.load();
    expect(t.s.get()).toEqual({ kind: 'none' });
  });
  it('有新的天气时再挂上（refreshIfOld）不再定位、不再取', async () => {
    const { s, deps } = setup({}, { perm: 'granted' });
    await s.load();
    s.refreshIfOld();
    s.refreshIfOld();
    await s.load();
    expect(deps.locate).toHaveBeenCalledTimes(2); // 第一次 + 最后那次手动 load；两次 refreshIfOld 没跑
    expect(deps.fetch).toHaveBeenCalledTimes(1);
  });
  it('正在定位时改了城市：那次跑完接着按新城市再取，城市不被旧的那次写回自动定位', async () => {
    let release: () => void = () => undefined;
    const { s, deps, store } = setup({}, { perm: 'granted' });
    vi.mocked(deps.locate).mockImplementationOnce(() => new Promise((r) => (release = () => r({ ok: true, lat: 37.6, lon: 127 }))));
    const first = s.load();
    await vi.waitFor(() => expect(deps.locate).toHaveBeenCalled());
    const city = { mode: 'city', name: '釜山', lat: 35.2, lon: 129.1 } as const;
    const set = s.setPlace(city);
    release();
    await Promise.all([first, set]);
    expect(store().place).toEqual(city);
    expect(store().auto).toEqual({ lat: 37.6, lon: 127 });
    expect(deps.fetch).toHaveBeenLastCalledWith(35.2, 129.1);
    expect(s.get()).toMatchObject({ kind: 'show', place: city });
  });
  it('同时调几次只跑一次', async () => {
    const { s, deps } = setup({ auto: { lat: 37.6, lon: 127 } });
    await Promise.all([s.load(), s.load(), s.load()]);
    expect(deps.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('“设置城市看天气”', () => {
  it('第一次出现记下日子；连续 7 天没点就不再出', async () => {
    const { s, store, tick } = setup();
    await s.load();
    expect(store().nudge.first).not.toBeNull();
    tick((NUDGE_DAYS - 1) * DAY);
    await s.load();
    expect(s.get()).toEqual({ kind: 'nudge' });
    tick(DAY);
    await s.load();
    expect(s.get()).toEqual({ kind: 'none' });
    expect(store().nudge.gone).toBe(true);
  });
  it('点过一次从点的那天重新算', async () => {
    const { s, tick } = setup();
    await s.load();
    tick(5 * DAY);
    s.nudgeTapped();
    tick(5 * DAY);
    await s.load();
    expect(s.get()).toEqual({ kind: 'nudge' });
  });
  it('设置里选“不看天气”：小胶囊也不再出', async () => {
    const { s, store } = setup();
    await s.setPlace({ mode: 'off' });
    expect(store().nudge.gone).toBe(true);
    await s.setPlace({ mode: 'auto' });
    expect(s.get()).toEqual({ kind: 'none' });
  });
});

describe('用当前位置（点了才问）', () => {
  it('同意：改成自动定位、记下粗坐标、取天气', async () => {
    const { s, store, deps } = setup({ place: { mode: 'off' } });
    expect(await s.askHere()).toEqual({ ok: true });
    expect(store().place).toEqual({ mode: 'auto' });
    expect(store().auto).toEqual({ lat: 37.6, lon: 127 });
    expect(deps.fetch).toHaveBeenCalledWith(37.6, 127);
    expect(s.get().kind).toBe('show');
  });
  it('拒绝：回原因，原来的设置不动', async () => {
    const { s, store, deps } = setup({ place: { mode: 'city', name: 'X', lat: 1, lon: 2 } }, { locateOk: false });
    expect(await s.askHere()).toEqual({ ok: false, why: 'denied' });
    expect(store().place).toEqual({ mode: 'city', name: 'X', lat: 1, lon: 2 });
    expect(deps.fetch).not.toHaveBeenCalled();
  });
});
