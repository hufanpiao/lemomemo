// 对照：对农历只用 import()，链在这里断开
export async function lazyLunar() {
  const m = await import('./anniv/lunar.ts');
  return m.toLunar('2026-11-04');
}
