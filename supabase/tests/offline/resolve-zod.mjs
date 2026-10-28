// Node 的模块解析钩子：shared/ 里的 import 'zod' 改从本目录的 node_modules 找
// 根目录的 package.json 归前端 A；合并以后根目录装了 zod，这个钩子可以删
export async function resolve(spec, ctx, next) {
  if (spec === 'zod' || spec.startsWith('zod/')) return next(spec, { ...ctx, parentURL: import.meta.url });
  return next(spec, ctx);
}
