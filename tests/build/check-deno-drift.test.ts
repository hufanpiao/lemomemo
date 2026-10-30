// build/ci/check_deno_drift.mjs：服务器函数部署前查 npm 漂移（架构 0.33 第 7 条方案 C，验收清单 D2）
// 用真的 supabase/functions/deno.lock 加假 registry（注入取数函数；另有一条起本机 http 测真 fetch 那条路），不联网、不起子进程。
// 覆盖：全一致；间接依赖范围内出了新版 → 报漂移（包、范围、锁版本、npm 最高、谁引用）；直接依赖是精确版本，出新版也不受影响；
//   预发布不算；registry 失败（抛错、非 200、超时、缺 versions）判失败；锁和 npm 的依赖名单对不上判失败；范围写法逐条核对。
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkDrift, maxSatisfying, parseLock, registryFetcher, report } from '../../build/ci/check_deno_drift.mjs';

const LOCK = readFileSync(join(resolve(import.meta.dirname, '../..'), 'supabase', 'functions', 'deno.lock'), 'utf8');

type Doc = { versions: Record<string, { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; deprecated?: string }> };

/** 照锁造一份“和锁完全一致”的 npm：每个包只有锁里那一版，依赖范围照 npm 上的真实写法（10-31 读的） */
function fakeNpm(): Record<string, Doc> {
  const ranges: Record<string, Record<string, string>> = {
    '@supabase/auth-js': { tslib: '2.8.1' },
    '@supabase/functions-js': { tslib: '2.8.1' },
    '@supabase/postgrest-js': { tslib: '2.8.1' },
    '@supabase/realtime-js': { tslib: '2.8.1', '@supabase/phoenix': '0.4.5' },
    '@supabase/storage-js': { tslib: '2.8.1', 'iceberg-js': '^0.8.1' },
    '@supabase/supabase-js': {
      '@supabase/auth-js': '2.118.0', '@supabase/storage-js': '2.118.0', '@supabase/realtime-js': '2.118.0',
      '@supabase/functions-js': '2.118.0', '@supabase/postgrest-js': '2.118.0',
    },
  };
  const npm: Record<string, Doc> = {};
  for (const p of parseLock(LOCK).pkgs.values()) {
    const r = ranges[p.name];
    npm[p.name] = { versions: { [p.version]: r ? { dependencies: r } : {} } };
  }
  return npm;
}

const from = (npm: Record<string, Doc>) => async (name: string) => {
  const d = npm[name];
  if (!d) throw new Error(`假 registry 没有 ${name}`);
  return d;
};
const addVersions = (npm: Record<string, Doc>, name: string, ...vs: string[]) => {
  for (const v of vs) (npm[name] as Doc).versions[v] = {};
};

describe('check_deno_drift：锁和 npm 比', () => {
  it('全一致：没有漂移、没有问题，报告写“通过”', async () => {
    const r = await checkDrift(LOCK, from(fakeNpm()));
    expect(r).toEqual({ drifts: [], problems: [] });
    expect(report(r, 12)).toEqual(['npm 漂移检查通过：锁里的版本就是线上打包现在会取到的版本（12 个包）']);
  });

  it('间接依赖范围内出了新版（iceberg-js ^0.8.1 → 0.8.2）：报漂移，写明包、范围、锁版本、npm 最高、谁引用', async () => {
    const npm = fakeNpm();
    addVersions(npm, 'iceberg-js', '0.8.2', '0.9.0', '1.0.0');   // 0.9.0、1.0.0 不在 ^0.8.1 里
    const r = await checkDrift(LOCK, from(npm));
    expect(r.problems).toEqual([]);
    expect(r.drifts).toEqual([{ name: 'iceberg-js', range: '^0.8.1', locked: '0.8.1', latest: '0.8.2', by: '@supabase/storage-js@2.118.0' }]);
    expect(report(r)).toEqual(['漂移：iceberg-js，范围 ^0.8.1（@supabase/storage-js@2.118.0 引用），锁里 0.8.1，npm 范围内最高 0.8.2']);
  });

  it('直接依赖是精确版本：zod、supabase-js 出了新版也不算漂移；只在范围外有新版的间接依赖也不算', async () => {
    const npm = fakeNpm();
    addVersions(npm, 'zod', '4.6.8', '5.0.0');
    addVersions(npm, '@supabase/supabase-js', '2.119.0');
    addVersions(npm, 'tslib', '2.8.2');        // 父包写的是精确的 2.8.1
    addVersions(npm, 'iceberg-js', '1.0.0');   // 现在 npm 上就是这样：1.0.0 不在 ^0.8.1 里
    expect(await checkDrift(LOCK, from(npm))).toEqual({ drifts: [], problems: [] });
  });

  it('预发布不算：范围内只多了 0.8.2-beta.1、0.8.2-rc.0+build 时没有漂移', async () => {
    const npm = fakeNpm();
    addVersions(npm, 'iceberg-js', '0.8.2-beta.1', '0.8.2-rc.0+build');
    expect(await checkDrift(LOCK, from(npm))).toEqual({ drifts: [], problems: [] });
  });

  it('标了 deprecated 的新版照样算漂移（打包取不取它不确定，宁可多报）', async () => {
    const npm = fakeNpm();
    (npm['iceberg-js'] as Doc).versions['0.8.3'] = { deprecated: 'x' };
    expect((await checkDrift(LOCK, from(npm))).drifts.map((d) => d.latest)).toEqual(['0.8.3']);
  });

  it('registry 失败判失败、不放行：取某个包抛错 → 记问题，不出“通过”', async () => {
    const npm = fakeNpm();
    delete npm['iceberg-js'];
    const r = await checkDrift(LOCK, from(npm));
    expect(r.drifts).toEqual([]);
    expect(r.problems).toEqual(['假 registry 没有 iceberg-js']);
    expect(report(r)).toEqual(['查不了：假 registry 没有 iceberg-js']);
  });

  it('锁和 npm 对不上判失败：锁里的版本 npm 上没有、npm 上多了一个锁里没有的依赖、锁里记的依赖 npm 上没写', async () => {
    const gone = fakeNpm();
    (gone['tslib'] as Doc).versions = { '2.8.2': {} };
    expect((await checkDrift(LOCK, from(gone))).problems).toContain('锁里的 tslib@2.8.1 在 npm 上没有这个版本');
    const extra = fakeNpm();
    ((extra['aws4fetch'] as Doc).versions['1.0.20'] as { dependencies?: Record<string, string> }).dependencies = { 'left-pad': '^1.0.0' };
    expect((await checkDrift(LOCK, from(extra))).problems).toEqual(['npm 上 aws4fetch@1.0.20 依赖 left-pad@^1.0.0，锁里没有这一条（锁和 npm 对不上，重新生成锁再评审）']);
    const missing = fakeNpm();
    ((missing['@supabase/storage-js'] as Doc).versions['2.118.0'] as { dependencies?: Record<string, string> }).dependencies = { tslib: '2.8.1' };
    expect((await checkDrift(LOCK, from(missing))).problems).toEqual(['锁里记着 @supabase/storage-js@2.118.0 依赖 iceberg-js，npm 上 @supabase/storage-js@2.118.0 的 package.json 没写']);
  });

  it('安全审查 S1：npm 上的可选依赖、没标 optional 的 peer 锁里没有 → 判失败；标了 optional 的 peer 不比', async () => {
    const setMeta = (npm: Record<string, Doc>, meta: Record<string, unknown>) => {
      (npm['aws4fetch'] as Doc).versions['1.0.20'] = meta;
    };
    const opt = fakeNpm();
    setMeta(opt, { optionalDependencies: { fsevents: '^2.0.0' } });
    expect((await checkDrift(LOCK, from(opt))).problems).toEqual(['npm 上 aws4fetch@1.0.20 依赖 fsevents@^2.0.0，锁里没有这一条（锁和 npm 对不上，重新生成锁再评审）']);
    const peer = fakeNpm();
    setMeta(peer, { peerDependencies: { react: '>=18' } });
    expect((await checkDrift(LOCK, from(peer))).problems).toEqual(['npm 上 aws4fetch@1.0.20 依赖 react@>=18，锁里没有这一条（锁和 npm 对不上，重新生成锁再评审）']);
    const optPeer = fakeNpm();
    setMeta(optPeer, { peerDependencies: { '@opentelemetry/api': '>=1.0.0' }, peerDependenciesMeta: { '@opentelemetry/api': { optional: true } } });
    expect(await checkDrift(LOCK, from(optPeer))).toEqual({ drifts: [], problems: [] });
  });

  it('锁格式不是 v5、有 npm 以外的依赖：直接抛错（调用处退出码 1）', () => {
    expect(() => parseLock(LOCK.replace('"version": "5"', '"version": "6"'))).toThrow('只认 "5"');
    expect(() => parseLock(JSON.stringify({ version: '5', specifiers: { 'jsr:@std/path@1.0.0': '1.0.0' }, npm: {} }))).toThrow('npm 以外的依赖');
  });
});

describe('check_deno_drift：取元数据（registryFetcher）', () => {
  it('本机 http 假 registry：带缩略元数据的 Accept、scope 包名编码成 %2f；回 500、缺 versions 都抛错', async () => {
    const seen: { url: string; headers: IncomingHttpHeaders }[] = [];
    const server = createServer((req, res) => {
      seen.push({ url: req.url ?? '', headers: req.headers });
      if (req.url === '/broken') { res.statusCode = 500; res.end('x'); return; }
      res.setHeader('content-type', 'application/json');
      res.end(req.url === '/empty' ? '{}' : JSON.stringify({ versions: { '1.0.0': {} } }));
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
      const get = registryFetcher(base);
      expect(await get('@supabase/storage-js')).toEqual({ versions: { '1.0.0': {} } });
      expect(seen[0]?.url).toBe('/@supabase%2fstorage-js');
      expect(seen[0]?.headers.accept).toBe('application/vnd.npm.install-v1+json');
      await expect(get('broken')).rejects.toThrow('回 HTTP 500');
      await expect(get('empty')).rejects.toThrow('元数据里没有 versions');
    } finally {
      await new Promise((ok) => server.close(ok));
    }
  });

  it('网络错误、超时：抛错并写明是哪个包、哪个地址', async () => {
    const boom = registryFetcher('https://registry.example', () => Promise.reject(new Error('The operation was aborted due to timeout')));
    await expect(boom('iceberg-js')).rejects.toThrow('取 iceberg-js 的元数据失败：https://registry.example/iceberg-js（The operation was aborted due to timeout）');
  });
});

describe('check_deno_drift：版本范围（maxSatisfying）', () => {
  const vs = ['0.0.3', '0.0.4', '0.1.0', '0.8.0', '0.8.1', '0.8.9', '0.9.0', '1.0.0', '1.2.3', '1.2.9', '1.3.0', '1.9.9', '2.0.0', '2.0.1-beta.1'];
  it.each([
    ['^0.8.1', '0.8.9'], ['^1.2.3', '1.9.9'], ['^0.0.3', '0.0.3'], ['^0.0', '0.0.4'], ['^0', '0.9.0'], ['^1.x', '1.9.9'],
    ['~1.2.3', '1.2.9'], ['~1.2', '1.2.9'], ['~1', '1.9.9'], ['~0.8.0', '0.8.9'],
    ['1.2.3', '1.2.3'], ['=1.2.3', '1.2.3'], ['v1.2.3', '1.2.3'], ['1.2', '1.2.9'], ['1.x', '1.9.9'], ['1.2.*', '1.2.9'], ['*', '2.0.0'], ['', '2.0.0'],
    ['>=1.0.0', '2.0.0'], ['>1.9.9', '2.0.0'], ['>1.2', '2.0.0'], ['<1.0.0', '0.9.0'], ['<=1.2', '1.2.9'], ['>=1.2.3 <1.3.0', '1.2.9'],
    ['<0.1.0 || ^1.2.0', '1.9.9'], ['1.2.3 - 1.3', '1.3.0'], ['0.8.0 - 0.8.1', '0.8.1'], ['>=3.0.0', undefined],
    // 安全审查 M1：运算符和版本之间有空格（对照值按 npm semver 的 maxSatisfying）
    ['>= 1.2.3', '2.0.0'], ['^ 1.2.3', '1.9.9'], ['~ 1.2.3', '1.2.9'], ['> 1.2.3', '2.0.0'], ['>=  1.2.3 <  1.3.0', '1.2.9'],
  ])('%s → %s（预发布 2.0.1-beta.1 永远不选）', (range, want) => {
    expect(maxSatisfying(vs, range)).toBe(want);
  });

  it('不认识的写法抛错（不猜）：带预发布的范围、npm: 别名、标签、git 地址', () => {
    for (const r of ['^1.0.0-beta', 'npm:other@1.0.0', 'latest', 'github:a/b', '1.2.3.4', '>=', '1.2.3 <', '^']) {
      expect(() => maxSatisfying(vs, r), r).toThrow('不认识的范围');
    }
  });

  it('范围写法不认识时 checkDrift 判失败', async () => {
    const npm = fakeNpm();
    ((npm['@supabase/storage-js'] as Doc).versions['2.118.0'] as { dependencies?: Record<string, string> }).dependencies = { tslib: '2.8.1', 'iceberg-js': 'latest' };
    expect((await checkDrift(LOCK, from(npm))).problems).toEqual(['@supabase/storage-js@2.118.0 → iceberg-js：不认识的范围（不支持预发布或别的写法）：latest']);
  });
});
