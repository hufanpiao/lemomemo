// 违规 F3：jsdelivr、esm.sh 别名参数引 aws4fetch
import 'https://cdn.jsdelivr.net/npm/aws4fetch@1/+esm';
import 'https://esm.sh/some-signer?alias=signer:aws4fetch';
