// 违规④：不是字面量的动态 import( )，看不出引的是什么，F7 ⑥ 一律报
const name = './helper' + '.test.ts';
export async function load(): Promise<unknown> {
  return await import(name);
}
