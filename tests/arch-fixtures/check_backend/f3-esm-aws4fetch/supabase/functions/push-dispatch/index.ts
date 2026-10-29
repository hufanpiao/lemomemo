// 违规 F3（S3）：从 esm.sh 引 aws4fetch，绕开 npm:aws4fetch 的匹配
import { AwsV4Signer } from 'https://esm.sh/aws4fetch@1.0.20';
export const s = AwsV4Signer;
