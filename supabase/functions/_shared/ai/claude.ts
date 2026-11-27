// Claude 适配（R-494 AI 助手第 4 段；Anthropic Messages API）。
// • 地址 https://api.anthropic.com/v1/messages；密钥只放 x-api-key 请求头，另带 anthropic-version: 2023-06-01。
// • generate（要回 JSON 的）：Claude 没有 responseSchema，用“强制调一个工具”的写法——给一个叫 emit 的工具，input_schema 就是我们的 schema，
//   tool_choice 指定它，模型交回的 tool_use.input 就是结果 JSON（官方文档推荐的结构化输出写法）。只收文字，带音频直接回 error（Claude 不收音频）。
// • chat：tools 照 Anthropic 的 {name, description, input_schema}，tool_choice auto / none；同一轮里模型回的 content 块原样（带 tool_use 的 id）
//   记进 turn.state，下一次接在历史后面发回去，再跟一条 role user、每个结果一块 tool_result（tool_use_id 对上）。
// • 历史第一条必须是 user：前面的 assistant 丢掉。max_tokens 必填，给 CLAUDE_MAX_TOKENS。
// • 失败归类、超时、不带正文进日志见 compat.ts（Claude 过载 529 当 error）。
import { isObj } from '../obj.ts';
import { jsonSchemaOf, MODEL_RE, post, type Fetch } from './compat.ts';
import { PROVIDER_CAPS, type AiRequest, type AiResult, type AIProvider, type ChatProvider, type ChatRequest, type ChatResult, type ProviderCaps, type ToolCall } from './provider.ts';

export const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
export const CLAUDE_VERSION = '2023-06-01';
/** 一次最多出多少 token（对话回答 1200 字以内、整理的 JSON 也不长） */
export const CLAUDE_MAX_TOKENS = 4096;
const EMIT = 'emit';

type Block = Record<string, unknown>;
type Msg = { role: 'user' | 'assistant'; content: string | Block[] };
interface ClaudeTurn {
  extra: Msg[];
}
const isClaudeTurn = (v: unknown): v is ClaudeTurn => isObj(v) && Array.isArray(v['extra']);

export class ClaudeProvider implements AIProvider, ChatProvider {
  readonly name = 'claude';
  /** Claude：工具调用有；不收音频、没有向量（方案第 5 节查过官方文档） */
  readonly caps: ProviderCaps = PROVIDER_CAPS.claude;
  readonly model: string;
  private readonly key: string;
  private readonly fetchFn: Fetch;
  constructor(model: string, key: string, fetchFn: Fetch) {
    if (!MODEL_RE.test(model)) throw new Error('bad_model');
    if (!key) throw new Error('no_key');
    this.model = model;
    this.key = key;
    this.fetchFn = fetchFn;
  }

  private headers(): Record<string, string> {
    return { 'x-api-key': this.key, 'anthropic-version': CLAUDE_VERSION };
  }

  /** generate 的请求体（单测核对）；带音频回 null */
  body(req: AiRequest): Record<string, unknown> | null {
    if (req.parts.some((p) => !('text' in p))) return null;
    return {
      model: this.model,
      max_tokens: CLAUDE_MAX_TOKENS,
      system: req.system,
      temperature: req.params.temperature,
      messages: [{ role: 'user', content: req.parts.map((p) => ('text' in p ? p.text : '')).join('\n') }],
      tools: [{ name: EMIT, description: 'Return the result.', input_schema: jsonSchemaOf(req.schema) }],
      tool_choice: { type: 'tool', name: EMIT },
    };
  }

  async generate(req: AiRequest): Promise<AiResult> {
    const b = this.body(req);
    if (b === null) return { ok: false, reason: 'error', errName: 'no_audio' };
    const r = await post(this.fetchFn, CLAUDE_URL, this.headers(), b, req.timeoutMs);
    if (!r.ok) return r;
    const use = blocksOf(r.body).find((x) => x['type'] === 'tool_use' && x['name'] === EMIT);
    const input = use?.['input'];
    if (!isObj(input)) return { ok: false, reason: 'error', status: r.status };
    return { ok: true, json: input, raw: JSON.stringify(input) };
  }

  /** chat 的请求体（单测核对）：extra 是这一轮已有的往返 */
  chatBody(req: ChatRequest, extra: readonly Msg[]): Record<string, unknown> {
    const hist: Msg[] = req.messages.map((m) => ({ role: m.role, content: m.text }));
    while (hist.length > 0 && hist[0]?.role !== 'user') hist.shift();
    return {
      model: this.model,
      max_tokens: CLAUDE_MAX_TOKENS,
      system: req.system,
      temperature: req.params.temperature,
      messages: [...hist, ...extra],
      ...(req.tools.length > 0 ? {
        tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
        tool_choice: { type: req.toolChoice },
      } : {}),
    };
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    let extra: Msg[] = [];
    if (req.resume) {
      const st = req.resume.turn.state;
      if (req.resume.turn.provider !== this.name || !isClaudeTurn(st)) return { ok: false, reason: 'error', errName: 'bad_turn' };
      extra = [...st.extra, {
        role: 'user',
        content: req.resume.results.map((x) => ({ type: 'tool_result', tool_use_id: x.id, content: JSON.stringify(x.result) })),
      }];
    }
    const r = await post(this.fetchFn, CLAUDE_URL, this.headers(), this.chatBody(req, extra), req.timeoutMs);
    if (!r.ok) return r;
    const blocks = blocksOf(r.body);
    let text = '';
    const calls: ToolCall[] = [];
    for (const b of blocks) {
      if (b['type'] === 'text' && typeof b['text'] === 'string') text += b['text'];
      if (b['type'] === 'tool_use' && typeof b['id'] === 'string' && typeof b['name'] === 'string') {
        calls.push({ id: b['id'], name: b['name'], args: isObj(b['input']) ? b['input'] : {} });
      }
    }
    if (text === '' && calls.length === 0) return { ok: false, reason: 'error', status: r.status };
    const next: ClaudeTurn = { extra: [...extra, { role: 'assistant', content: blocks }] };
    return { ok: true, text, toolCalls: calls, turn: { provider: this.name, state: next } };
  }
}

/** 回复的 content 块；没有回空数组 */
function blocksOf(body: unknown): Block[] {
  const c = isObj(body) ? body['content'] : null;
  return Array.isArray(c) ? c.filter(isObj) : [];
}
