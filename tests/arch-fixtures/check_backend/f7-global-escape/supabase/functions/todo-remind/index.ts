// 对照：globalThis.标识符、名字里只是带 eval / Deno / process 字样的不报
export const t = globalThis.setTimeout;
export const s = ['Denote', 'evaluate', 'processing'];
export const o = { evaluate: 1, required: true };
