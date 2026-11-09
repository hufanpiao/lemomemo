// AI 回放录制器（B3 任务单 BE-6；TC-B0-90）：存盘前去掉全部请求头和密钥、录音只留占位（安全审 M1）、GCP 项目标识洗掉、
// secrets 必传；gitleaks 扫得到 tests/ 里漏了假密钥的回放文件。回放桩那一半在 ai-replay.test.ts。
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GEMINI_BASE, GeminiProvider, toBase64, type Fetch } from '../../supabase/functions/_shared/ai/gemini.ts';
import { AUDIO_PLACEHOLDER_RE, audioPlaceholder, leftovers, loadCassette, REDACTED, saveCassette, type Cassette } from '../ai/replay/cassette.ts';
import { record } from '../ai/replay/recorder.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const CASSETTES = join(ROOT, 'tests', 'ai', 'replay', 'cassettes');

/** 脚本造的、明显是假的谷歌密钥格式串（源码里不出现整串，免得 gitleaks 扫到本文件） */
function fakeGoogleKey(): string {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  return ['AI', 'za', ...[...randomBytes(35)].map((b) => abc[b % 64])].join('');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('TC-B0-90 前半：录制器存盘前去掉全部请求头和密钥', () => {
  it('包住真 GeminiProvider 录一段：请求头一个不存（含 x-goog-api-key），地址去查询串，正文里回显的密钥换成 [REDACTED]', async () => {
    const key = fakeGoogleKey();
    const seen: Headers[] = [];
    const inner: Fetch = async (_url, init) => {
      seen.push(new Headers(init.headers));
      // 假装服务商把密钥回显在正文里，看录制器洗不洗
      const text = JSON.stringify({ items: [{ kind: 'todo', title: `回显 ${key}`, due: null, date_basis: null }] });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200, headers: { 'x-goog-api-key': key, 'set-cookie': 'a=b' } });
    };
    const rec = record(inner, [key]);
    const p = new GeminiProvider('gemini-x', key, (url, init) => rec.fetch(`${url}?key=${key}`, init));
    const r = await p.generate({ system: 's', parts: [{ text: '买牛奶' }], schema: {}, params: { temperature: 0, candidateCount: 1 }, timeoutMs: 5000 });
    expect(r.ok).toBe(true);   // 调用方拿到的是原样的返回
    expect(seen[0]?.get('x-goog-api-key')).toBe(key);   // 确实带着密钥发出去了

    const c = rec.cassette('单测');
    const text = JSON.stringify(c);
    expect(text).not.toContain(key);
    expect(text).not.toMatch(/x-goog-api-key|set-cookie|"headers"/i);
    expect(c.entries[0]?.req.url).toBe(`${GEMINI_BASE}gemini-x:generateContent`);
    expect(Object.keys(c.entries[0]?.req ?? {}).sort()).toEqual(['body', 'method', 'url']);
    expect(c.entries[0]?.res).toMatchObject({ kind: 'http', status: 200 });
    expect(text).toContain(REDACTED);
    expect(leftovers(c, [key])).toEqual([]);

    const dir = mkdtempSync(join(tmpdir(), 'lemo-cassette-'));
    try {
      saveCassette(join(dir, 'ok.json'), c, [key]);
      expect(readFileSync(join(dir, 'ok.json'), 'utf8')).not.toContain(key);
      // 有人手改回放文件、塞进一串像密钥的东西：拒绝存盘，什么都不写
      const dirty: Cassette = { ...c, note: `手改 ${fakeGoogleKey()}` };
      expect(() => saveCassette(join(dir, 'dirty.json'), dirty, [key])).toThrow(/cassette_not_clean:.*google_key_like/);
      const withHeaders = { ...c, entries: [{ ...c.entries[0], req: { ...c.entries[0]?.req, headers: { 'x-goog-api-key': 'x' } } }] } as unknown as Cassette;
      expect(() => saveCassette(join(dir, 'h.json'), withHeaders, [key])).toThrow(/headers/);
      expect(existsSync(join(dir, 'dirty.json')) || existsSync(join(dir, 'h.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('安全审 M1：录语音请求，录音（inlineData.data）当场换成占位串（只留长度和 SHA-256），存盘结果里没有 base64 音频；漏进来的拒绝存盘', async () => {
    const key = fakeGoogleKey();
    const audio = new Uint8Array(randomBytes(3000));
    const b64 = toBase64(audio);
    const inner: Fetch = async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"transcript":"x","items":[]}' }] } }] }), { status: 200 });
    const rec = record(inner, [key]);
    const p = new GeminiProvider('gemini-x', key, rec.fetch);
    await p.generate({ system: 's', parts: [{ inlineData: { mimeType: 'audio/webm', data: audio } }], schema: {}, params: { temperature: 0, candidateCount: 1 }, timeoutMs: 5000 });
    const c = rec.cassette('语音');
    const text = JSON.stringify(c);
    expect(text.includes(b64)).toBe(false);
    expect(text.includes(b64.slice(0, 64))).toBe(false);
    const inline = (c.entries[0]?.req.body as { contents: { parts: { inlineData: { mimeType: string; data: string } }[] }[] }).contents[0]?.parts[0]?.inlineData;
    expect(inline?.mimeType).toBe('audio/webm');
    expect(inline?.data).toBe(audioPlaceholder(b64));
    expect(AUDIO_PLACEHOLDER_RE.test(inline?.data ?? '')).toBe(true);
    expect(inline?.data?.startsWith(`[AUDIO len=${b64.length} sha256=`)).toBe(true);
    expect(leftovers(c, [key])).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), 'lemo-cassette-'));
    try {
      saveCassette(join(dir, 'voice.json'), c, [key]);
      expect(readFileSync(join(dir, 'voice.json'), 'utf8').includes(b64.slice(0, 64))).toBe(false);
      // 绕过录制器、录音原样塞进回放文件：leftovers 报 audio，拒绝存盘
      const leaked = JSON.parse(text.replace(audioPlaceholder(b64), b64)) as Cassette;
      expect(leftovers(leaked, [key])).toContain('audio');
      expect(() => saveCassette(join(dir, 'leaked.json'), leaked, [key])).toThrow(/cassette_not_clean:.*audio/);
      expect(existsSync(join(dir, 'leaked.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('安全审建议 1：录制器录的回放不传 secrets（空）直接拒绝存盘', async () => {
    const rec = record(async () => new Response('{}', { status: 500 }), ['k']);
    await rec.fetch(`${GEMINI_BASE}gemini-x:generateContent`, { method: 'POST', body: '{}' });
    const dir = mkdtempSync(join(tmpdir(), 'lemo-cassette-'));
    try {
      expect(() => saveCassette(join(dir, 'a.json'), rec.cassette('x'), [])).toThrow('cassette_no_secrets');
      expect(() => saveCassette(join(dir, 'a.json'), rec.cassette('x'), [''])).toThrow('cassette_no_secrets');
      expect(existsSync(join(dir, 'a.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('安全复审补：开录前就查 secrets，为空或全是空串直接抛 cassette_no_secrets，一次请求都不发', () => {
    let sent = 0;
    const inner: Fetch = async () => {
      sent++;
      return new Response('{}', { status: 200 });
    };
    expect(() => record(inner, [])).toThrow('cassette_no_secrets');
    expect(() => record(inner, ['', ''])).toThrow('cassette_no_secrets');
    expect(sent).toBe(0);
  });

  it('安全审建议 2：谷歌错误正文里的 projects/<编号>、project_number:<编号>、控制台链接的 project=<ID> 存盘前洗掉；漏进来的拒绝存盘', async () => {
    const key = fakeGoogleKey();
    const err = JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'Generative Language API has not been used in project_number:123456789012 before', details: [{ metadata: { consumer: 'projects/123456789012', activationUrl: 'https://console.developers.google.com/apis/api/generativelanguage.googleapis.com/overview?project=123456789012&x=1' } }] } });
    const rec = record(async () => new Response(err, { status: 403 }), [key]);
    const p = new GeminiProvider('gemini-x', key, rec.fetch);
    expect(await p.generate({ system: 's', parts: [{ text: 'x' }], schema: {}, params: { temperature: 0, candidateCount: 1 }, timeoutMs: 5000 })).toMatchObject({ ok: false, status: 403 });
    const c = rec.cassette('403');
    const text = JSON.stringify(c);
    expect(text.includes('123456789012')).toBe(false);
    expect(text).toContain(`projects/${REDACTED}`);
    expect(text).toContain(`?project=${REDACTED}&x=1`);
    expect(text).toContain(`project_number:${REDACTED}`);
    expect(leftovers(c, [key])).toEqual([]);
    for (const note of ['consumer projects/987654321098', 'used in project_number:987654321098 before', 'see ?project=987654321098']) {
      const leaked: Cassette = { ...c, note };
      expect(leftovers(leaked, [key]), note).toContain('project_id');
      const dir = mkdtempSync(join(tmpdir(), 'lemo-cassette-'));
      try {
        expect(() => saveCassette(join(dir, 'p.json'), leaked, [key])).toThrow(/cassette_not_clean:.*project_id/);
        expect(existsSync(join(dir, 'p.json'))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('录到超时：记成 timeout 条目，不存请求头', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const key = fakeGoogleKey();
    const hang: Fetch = (_u, init) => new Promise((_, rej) => init.signal?.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' }))));
    const rec = record(hang, [key]);
    const p = new GeminiProvider('gemini-x', key, rec.fetch);
    const pending = p.generate({ system: 's', parts: [{ text: 'x' }], schema: {}, params: { temperature: 0, candidateCount: 1 }, timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({ ok: false, reason: 'timeout' });
    expect(rec.cassette('t').entries.map((e) => e.res)).toEqual([{ kind: 'timeout' }]);
  });

  it('仓库里的回放文件都干净：没有请求头、没有像谷歌密钥的串，格式能读', () => {
    const files = readdirSync(CASSETTES).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(8);
    for (const f of files) {
      const c = loadCassette(join(CASSETTES, f));
      expect(leftovers(c, []), f).toEqual([]);
      expect(c.entries.length, f).toBeGreaterThan(0);
    }
  });
});

describe('TC-B0-90 后半：gitleaks 扫得到 tests/ 里的回放文件', () => {
  it('CI 的 secrets-scan 用默认规则扫全部历史，不带 --config、不按路径放行；没有 .gitleaks.toml；.gitleaksignore 不放行 tests/ai', () => {
    const yml = readFileSync(join(ROOT, '.github', 'workflows', 'unit.yml'), 'utf8');
    const line = yml.split('\n').find((l) => /run: gitleaks /.test(l)) ?? '';
    expect(line).toMatch(/gitleaks git .*--exit-code 1 .*--log-opts="--all" \.$/);
    expect(line).not.toMatch(/--config|-c |--baseline|--ignore/);
    expect(existsSync(join(ROOT, '.gitleaks.toml'))).toBe(false);
    expect(existsSync(join(ROOT, 'gitleaks.toml'))).toBe(false);
    expect(readFileSync(join(ROOT, '.gitleaksignore'), 'utf8')).not.toMatch(/tests\/ai|tests\/edge\/ai-replay/);
    expect(readFileSync(join(ROOT, '.githooks', 'pre-commit'), 'utf8')).toMatch(/gitleaks/);
    // 安全审建议 3：secrets-scan 任务里有行为证明那一步（临时回放文件带假密钥，gitleaks 必须报退出码 1）
    const job = yml.slice(yml.indexOf('secrets-scan:'), yml.indexOf('supply-chain:'));
    expect(job).toMatch(/gitleaks dir --redact --no-banner --exit-code 1 "\$d"/);
    expect(job).toMatch(/if \[ "\$rc" -ne 1 \]; then/);
  });

  const hasGitleaks = spawnSync('gitleaks', ['version'], { encoding: 'utf8' }).status === 0;
  // 本机装了 gitleaks（.githooks/pre-commit 本来就要求装）才跑；CI 的 unit 任务不装它，那里由 secrets-scan 任务整仓扫
  it.skipIf(!hasGitleaks)('本机 gitleaks：回放文件里放一个脚本造的假密钥 → 报（退出码 1）；仓库里的回放目录 → 不报', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lemo-gl-'));
    try {
      const c = loadCassette(join(CASSETTES, 'parse-ok.json'));
      // 绕过 saveCassette 直接写，模拟“录制器被改坏、密钥漏进回放文件”
      writeFileSync(join(dir, 'leaked.json'), JSON.stringify({ ...c, note: fakeGoogleKey() }, null, 2));
      const bad = spawnSync('gitleaks', ['dir', '--no-banner', '--redact', '--exit-code', '1', dir], { encoding: 'utf8' });
      expect(bad.status).toBe(1);
      const good = spawnSync('gitleaks', ['dir', '--no-banner', '--redact', '--exit-code', '1', join(ROOT, 'tests', 'ai')], { encoding: 'utf8' });
      expect(good.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
