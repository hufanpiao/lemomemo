// 违规 F3：别名 s3sign 指到 esm.sh 的 aws4fetch
import { AwsV4Signer } from 's3sign';
export const x = AwsV4Signer;
