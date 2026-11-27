// 违规 R2：platform 里直接用 S3 签名库（第 2 行，动态 import 在第 4 行）
import { AwsClient } from 'aws4fetch';
export const c = AwsClient;
export const lazy = () => import('aws4fetch');
