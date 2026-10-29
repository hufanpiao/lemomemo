// 违规 F3（B1 接手清单 S3 返工，审查必改 2）：import map 的键 lib*/ 里的 * 是普通字符，按前缀匹配，lib*/dist/main.js 就是 esm.sh 的 aws4fetch
import 'lib*/dist/main.js';
