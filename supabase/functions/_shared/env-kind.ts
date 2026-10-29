// 这个函数跑在哪个环境（K2 安全审查返工、架构 0.38 第 25～32 条）：只按平台注入的 SUPABASE_URL 判断，别的函数也用这一份。
//   preview：主机正好是预览项目的 <ref>.supabase.co；
//   local  ：主机是 127.0.0.1、localhost，或 supabase start 起的 kong（函数容器里看到的是 kong:8000）；
//   prod   ：其余一律算正式——拿不准（没设、解析不了、像预览但多了一截）都按正式，正式的判断不放宽。
// 不读环境变量（调用方传 SUPABASE_URL 进来）、不 import npm 包。

export type EnvKind = 'prod' | 'preview' | 'local';

/** 预览项目的 ref（不是秘密；B0 记录、环境清单里同一个） */
export const PREVIEW_REF = 'yoeqwhygehbaftkppati';

const LOCAL_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', 'kong']);

export function envKind(supabaseUrl: string | undefined | null): EnvKind {
  if (!supabaseUrl) return 'prod';
  let host: string;
  try {
    host = new URL(supabaseUrl).hostname.toLowerCase();
  } catch {
    return 'prod';
  }
  if (host === `${PREVIEW_REF}.supabase.co`) return 'preview';
  if (LOCAL_HOSTS.has(host)) return 'local';
  return 'prod';
}
