// 违规③：字符串字面量的 import('…')
export async function load(): Promise<unknown> {
  return await import('./helper.test.ts');
}
