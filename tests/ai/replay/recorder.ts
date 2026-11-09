// AI 回放录制器（B3 任务单 BE-6；TC-B0-90 前半）：包住一个 fetch（GeminiProvider 的注入口，_shared/ai/gemini.ts 的 Fetch），
// 把每次调用记成回放条目。记的时候就不碰请求头（只读方法、地址、请求体），地址去掉查询串，请求体和返回正文再按密钥原值和
// 谷歌密钥样子各洗一遍；请求体里的录音（inlineData.data）当场换成占位串，录音不进回放文件（安全审 M1）；
// 存盘走 cassette.ts 的 saveCassette（不干净拒绝存）。
// 真录制要真密钥、花真钱：负责人决定之前不录（BE-6 当前的回放文件都是 handmade）。
import type { Fetch } from '../../../supabase/functions/_shared/ai/gemini.ts';
import { CASSETTE_VERSION, scrub, stripAudio, stripQuery, type Cassette, type CassetteEntry } from './cassette.ts';

const bodyOf = (b: RequestInit['body']): unknown => {
  if (typeof b !== 'string') return null;   // Gemini 请求体一律是 JSON 字符串；别的类型不存
  try {
    return stripAudio(JSON.parse(b));
  } catch {
    return '[non-json body]';   // Gemini 请求体一律是 JSON；不是 JSON 的不存原文
  }
};

export interface Recorder {
  fetch: Fetch;
  entries: CassetteEntry[];
  /** 生成回放文件内容（已洗过；存盘用 saveCassette 再查一遍） */
  cassette(note: string): Cassette;
}

/** secrets：录制时用到的密钥原值（洗掉用），不会写进回放文件 */
export function record(inner: Fetch, secrets: readonly string[]): Recorder {
  // 开录前先查：没传密钥原值就没法洗，录了也存不了盘，直接拒绝、不发请求（免得白花钱；安全复审补）
  if (secrets.filter((k) => k !== '').length === 0) throw new Error('cassette_no_secrets');
  const entries: CassetteEntry[] = [];
  const fetch: Fetch = async (url, init) => {
    const req = scrub({ method: init.method ?? 'GET', url: stripQuery(url), body: bodyOf(init.body) }, secrets);
    try {
      const res = await inner(url, init);
      const text = await res.text();
      entries.push({ req, res: { kind: 'http', status: res.status, body: scrub(text, secrets) } });
      // 原样还给调用方（只把正文读出来过一遍，返回头不记）
      return new Response(text, { status: res.status, headers: res.headers });
    } catch (e) {
      if (init.signal?.aborted) entries.push({ req, res: { kind: 'timeout' } });
      throw e;
    }
  };
  return { fetch, entries, cassette: (note) => ({ v: CASSETTE_VERSION, provider: 'gemini', origin: 'recorded', note, entries: scrub(entries, secrets) }) };
}
