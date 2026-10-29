// 对照：九个函数里的 file-check 从 esm.sh 引 aws4fetch 不报；名字只是带 aws4fetch 字样的别的包也不报
import { AwsV4Signer } from 'https://esm.sh/aws4fetch@1.0.20';
import 'https://esm.sh/not-aws4fetchx@1';
export const s = AwsV4Signer;
