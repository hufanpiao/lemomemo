// 违规 F3（B1 接手清单 S3 返工，审查建议 5）：仓库根 package.json 的依赖别名 s3 → npm:aws4fetch 也作用于服务器函数
import 's3';
