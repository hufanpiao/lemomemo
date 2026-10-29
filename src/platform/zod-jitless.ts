// 关掉 zod 4 的 JIT（allowsEval 探测会 new Function，严格 CSP 下报 eval 违规，K16）
// 只有副作用：入口第一个 import 它，保证任何 schema 第一次 parse 之前已经设好
import { z } from 'zod';

z.config({ jitless: true });
