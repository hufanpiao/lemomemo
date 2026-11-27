// exe 里调 Rust 命令、订阅 Rust 事件的唯一入口：直接用 Tauri 2 注入的 window.__TAURI_INTERNALS__（不依赖 @tauri-apps/api）。
// 别处不许自己去 window 上取它；env.ts 的 isTauri 只用来分界面，不用来拿 invoke。
// 不在 exe 里：tauriInvoke 返回 undefined；tauriEvents 抛 not_tauri。

/** args 是普通对象（按 JSON 传），或一段字节（原样传，Rust 用 tauri::ipc::Request 的 body 读）；options.headers 跟着请求走（只能放 ASCII） */
export type Invoke = (cmd: string, args?: Record<string, unknown> | Uint8Array, options?: { headers?: Record<string, string> }) => Promise<unknown>;
/** 只传 JSON 参数的调用 */
export type JsonInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/** 订阅事件用到的部分：invoke 加 transformCallback（把回调登记成数字 id 交给 plugin:event|listen） */
export interface TauriInternalsEvents {
  invoke: JsonInvoke;
  transformCallback: (cb: (ev: { payload: unknown }) => void, once?: boolean) => number;
}

function internalsOf(win: unknown): { invoke?: unknown; transformCallback?: unknown; metadata?: { currentWindow?: { label?: unknown } } } | undefined {
  if (typeof win !== 'object' || win === null) return undefined;
  const t = (win as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  return typeof t === 'object' && t !== null ? t : undefined;
}

export function tauriInvoke(win: object = globalThis): Invoke | undefined {
  const invoke = internalsOf(win)?.invoke;
  return typeof invoke === 'function' ? (...a) => (invoke as Invoke)(...a) : undefined;
}

/** 当前窗口的 label；拿不到返回 undefined */
export function tauriWindowLabel(win: unknown = globalThis): string | undefined {
  const label = internalsOf(win)?.metadata?.currentWindow?.label;
  return typeof label === 'string' ? label : undefined;
}

export function tauriEvents(win: object = globalThis): TauriInternalsEvents {
  const t = internalsOf(win);
  if (!t || typeof t.invoke !== 'function' || typeof t.transformCallback !== 'function') throw new Error('not_tauri');
  return t as TauriInternalsEvents;
}
