// OpenAI、DeepSeek 适配（R-494 AI 助手第 4 段；两家的 Chat Completions 写法一样，DeepSeek 官方文档写明和 OpenAI 兼容，只是地址不同）。
// • 地址：OpenAI https://api.openai.com/v1/chat/completions；DeepSeek https://api.deepseek.com/chat/completions。密钥只放 Authorization 请求头。
// • generate（“＋”整理、总结、分类等要回 JSON 的）：
//   OpenAI 用 response_format json_schema（strict 关着：我们的 schema 里有可选键、可空，严格模式要求全部 required）；
//   DeepSeek 只有 json_object 模式（官方要求提示里出现 json 字样、给出格式样例），把 JSON Schema 接在系统提示后面。
//   只收文字：带音频（录音）的请求直接回 error，不发（录音转文字只给能收音频的那家，router 按 caps 拦着，这里再兜一层）。
// • chat（AI 助手对话）：tools 是 function 类型，tool_choice auto / none；同一轮里模型回的 assistant 消息原样（带 tool_calls 的 id）记进 turn.state，
//   下一次接在历史后面发回去，再跟每个结果一条 role tool 的消息（tool_call_id 对上）。
//   看图（负责人 11-27 选“接上”）：只有能力表里 imageIn 的那家（DeepSeek）发图——用户这一句的图接在最后一条 user 的 content 数组里，
//   工具结果的图放进跟在 tool 消息后面的一条 user 消息；格式照 DeepSeek 官方 https://api-docs.deepseek.com/guides/vision/ （image_url 的 data URL）。OpenAI 照旧只发文字。
// • 生成参数：gpt-5、o 系列推理模型只认默认 temperature，带了会 400，所以这类模型不带 temperature；其余照 params.ts。
// • 失败归类、超时、不带正文进日志见 compat.ts。
import { isObj } from '../obj.ts';
import { jsonSchemaOf, MODEL_RE, parseJsonText, post, type Fetch } from './compat.ts';
import { toBase64 } from './gemini.ts';
import { capsOf, type AiRequest, type AiResult, type AIProvider, type ChatImage, type ChatProvider, type ChatRequest, type ChatResult, type ProviderCaps, type ToolCall } from './provider.ts';

export const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
export const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

/** 只认默认 temperature 的推理模型（o1、o3、o4-mini、gpt-5 系列） */
const NO_TEMP = /^(o\d|gpt-5)/i;

type Msg = Record<string, unknown>;
interface OaTurn {
  extra: Msg[];
}
const isOaTurn = (v: unknown): v is OaTurn => isObj(v) && Array.isArray(v['extra']);

export class OpenAiCompatProvider implements AIProvider, ChatProvider {
  readonly caps: ProviderCaps;
  readonly name: 'openai' | 'deepseek';
  readonly model: string;
  private readonly url: string;
  private readonly key: string;
  private readonly fetchFn: Fetch;
  constructor(name: 'openai' | 'deepseek', model: string, key: string, fetchFn: Fetch) {
    if (!MODEL_RE.test(model)) throw new Error('bad_model');
    if (!key) throw new Error('no_key');
    this.name = name;
    this.caps = capsOf(name);
    this.model = model;
    this.url = name === 'openai' ? OPENAI_URL : DEEPSEEK_URL;
    this.key = key;
    this.fetchFn = fetchFn;
  }

  private temp(t: number): Record<string, unknown> {
    return NO_TEMP.test(this.model) ? {} : { temperature: t };
  }

  /** generate 的请求体（单测核对）；带音频回 null */
  body(req: AiRequest): Record<string, unknown> | null {
    if (req.parts.some((p) => !('text' in p))) return null;
    const user = req.parts.map((p) => ('text' in p ? p.text : '')).join('\n');
    const schema = jsonSchemaOf(req.schema);
    const system = this.name === 'deepseek'
      ? `${req.system}\n\nOutput only one JSON object that matches this JSON Schema:\n${JSON.stringify(schema)}`
      : req.system;
    return {
      model: this.model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      ...this.temp(req.params.temperature),
      response_format: this.name === 'deepseek' ? { type: 'json_object' } : { type: 'json_schema', json_schema: { name: 'out', schema, strict: false } },
    };
  }

  async generate(req: AiRequest): Promise<AiResult> {
    const b = this.body(req);
    if (b === null) return { ok: false, reason: 'error', errName: 'no_audio' };
    const r = await post(this.fetchFn, this.url, { authorization: `Bearer ${this.key}` }, b, req.timeoutMs);
    if (!r.ok) return r;
    const text = messageOf(r.body)?.['content'];
    if (typeof text !== 'string' || text === '') return { ok: false, reason: 'error', status: r.status };
    const json = parseJsonText(text);
    return json === null ? { ok: false, reason: 'error', status: r.status } : { ok: true, json, raw: text };
  }

  /** chat 的请求体（单测核对）：extra 是这一轮已有的往返 */
  chatBody(req: ChatRequest, extra: readonly Msg[]): Record<string, unknown> {
    const last = req.messages.length - 1;
    const pics = this.caps.imageIn ? (req.images ?? []) : [];
    return {
      model: this.model,
      messages: [
        { role: 'system', content: req.system },
        // 用户这一句带的图接在这一句文字后面（只在最后一条 user；历史里没有图）
        ...req.messages.map((m, i) => ({ role: m.role, content: i === last && m.role === 'user' && pics.length > 0 ? withImages(m.text, pics) : m.text })),
        ...extra,
      ],
      ...this.temp(req.params.temperature),
      ...(req.tools.length > 0 ? {
        tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
        tool_choice: req.toolChoice,
      } : {}),
    };
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    let extra: Msg[] = [];
    if (req.resume) {
      const st = req.resume.turn.state;
      if (req.resume.turn.provider !== this.name || !isOaTurn(st)) return { ok: false, reason: 'error', errName: 'bad_turn' };
      extra = [...st.extra, ...req.resume.results.map((x) => ({ role: 'tool', tool_call_id: x.id, content: JSON.stringify(x.result) }))];
      // 工具结果带的图（看随手记的图）：按结果顺序放进跟在全部 tool 消息后面的一条 user 消息（user 里带图各家都认）
      const pics = this.caps.imageIn ? req.resume.results.flatMap((x) => x.images ?? []) : [];
      if (pics.length > 0) extra.push({ role: 'user', content: withImages('上面工具结果附带的图，按结果顺序排列', pics) });
    }
    const r = await post(this.fetchFn, this.url, { authorization: `Bearer ${this.key}` }, this.chatBody(req, extra), req.timeoutMs);
    if (!r.ok) return r;
    const m = messageOf(r.body);
    if (!m) return { ok: false, reason: 'error', status: r.status };
    const text = typeof m['content'] === 'string' ? m['content'] : '';
    const calls: ToolCall[] = [];
    const raw = Array.isArray(m['tool_calls']) ? m['tool_calls'].filter(isObj) : [];
    for (const c of raw) {
      const f = c['function'];
      if (!isObj(f) || typeof f['name'] !== 'string' || typeof c['id'] !== 'string') continue;
      const args = typeof f['arguments'] === 'string' ? parseJsonText(f['arguments']) : null;
      calls.push({ id: c['id'], name: f['name'], args: isObj(args) ? args : {} });
    }
    if (text === '' && calls.length === 0) return { ok: false, reason: 'error', status: r.status };
    // 原样回传只留 role、content、tool_calls 三个键（别的键服务商下一次不一定认）
    const echo: Msg = { role: 'assistant', content: text === '' ? null : text, ...(raw.length > 0 ? { tool_calls: raw } : {}) };
    return { ok: true, text, toolCalls: calls, turn: { provider: this.name, state: { extra: [...extra, echo] } satisfies OaTurn } };
  }
}

/** 文字加图 → content 数组（DeepSeek 官方看图格式：image_url 的 data URL，base64） */
function withImages(text: string, pics: readonly ChatImage[]): Msg[] {
  return [{ type: 'text', text }, ...pics.map((im) => ({ type: 'image_url', image_url: { url: `data:${im.mimeType};base64,${toBase64(im.data)}` } }))];
}

/** choices[0].message；没有回 null */
function messageOf(body: unknown): Record<string, unknown> | null {
  const ch = isObj(body) && Array.isArray(body['choices']) ? body['choices'][0] : null;
  const m = isObj(ch) ? ch['message'] : null;
  return isObj(m) ? m : null;
}
