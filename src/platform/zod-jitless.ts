// 关掉 zod 4 的 JIT（allowsEval 探测会 new Function，严格 CSP 下报 eval 违规，K16）
// FA-6 ③：zod 移出首屏以后，入口不再先 import 它；改成 vite.config.ts 把裸的 'zod' 别名到这个文件（ZOD_JITLESS_ALIAS），
// 网页构建里谁 import 'zod' 拿到的都是这里转出的同一份，转出之前已经 z.config({ jitless: true })，保证任何 schema 第一次 parse 之前已经设好。
// 这里自己引 'zod/v4'（不是裸的 'zod'，别名不会再指回自己）；'zod' 和 'zod/v4' 是同一份 v4/classic，全局配置共用一个对象
import { z } from 'zod/v4';

z.config({ jitless: true });

export * from 'zod/v4';
export { z, z as default };
