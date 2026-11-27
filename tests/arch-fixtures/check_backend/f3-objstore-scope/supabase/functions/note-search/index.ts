// 违规 F3：九个函数以外直接 import aws4fetch 自己签 S3 请求
import { AwsClient } from 'npm:aws4fetch@1.0.20';
export const x = AwsClient;
