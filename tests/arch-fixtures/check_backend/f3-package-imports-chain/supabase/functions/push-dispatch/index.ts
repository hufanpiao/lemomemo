// 违规 F3（B1 接手清单 S3 返工，审查建议 3）：package.json imports 的 #s 指到裸包名 signer，signer 又是 npm:aws4fetch 的依赖别名
import '#s';
