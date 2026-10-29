// 违规 F3（代码审查有条件通过 6）：package.json 里 signer 是 npm:aws4fetch 的别名，整名和子路径都算
import { AwsV4Signer } from 'signer';
import { x } from 'signer/dist/x.js';
export const s = [AwsV4Signer, x];
