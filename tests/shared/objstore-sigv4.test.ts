// shared/objstore.ts 的 signS3：用 AWS 官方文档公布的 SigV4 样例向量核对（运维 10-28 要求：替身 LocalStack 默认不验签名，
// 不能只靠替身证明签得对）。来源：AWS S3 API Reference「Signature Calculations for the Authorization Header:
// Transferring Payload in a Single Chunk」和「Authenticating Requests: Using the Authorization Header」里的例子。
// 下面的密钥是 AWS 文档里公开的示例值（AKIAIOSFODNN7EXAMPLE），不是真密钥。
// Node（vitest）和 Deno 跑同一组。
import { describe, expect, it } from 'vitest';
import { signS3 } from '../../shared/objstore.ts';

const AWS_DOC_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
const AWS_DOC_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const CRED = `Credential=${AWS_DOC_KEY_ID}/20130524/us-east-1/s3/aws4_request`;
// aws4fetch 的格式：逗号后带一个空格（AWS 文档里两种都认，签名本身不受影响）

function base(method: string, url: string, headers: Record<string, string>) {
  return {
    method,
    url,
    headers,
    accessKeyId: AWS_DOC_KEY_ID,
    secretAccessKey: AWS_DOC_SECRET,
    region: 'us-east-1',
    datetime: '20130524T000000Z',
  };
}

describe('signS3：AWS 官方样例向量', () => {
  it('GET Bucket lifecycle（?lifecycle）', async () => {
    const s = await signS3(base('GET', 'https://examplebucket.s3.amazonaws.com/?lifecycle', { 'x-amz-content-sha256': EMPTY_SHA256 }));
    expect(s.authorization).toBe(
      `AWS4-HMAC-SHA256 ${CRED}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, ` +
        'Signature=fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543',
    );
  });

  it('GET Bucket（列对象，?max-keys=2&prefix=J）', async () => {
    const s = await signS3(base('GET', 'https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J', { 'x-amz-content-sha256': EMPTY_SHA256 }));
    expect(s.authorization).toBe(
      `AWS4-HMAC-SHA256 ${CRED}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, ` +
        'Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7',
    );
  });

  // aws4fetch 默认不签 range、content-type 等头（UNSIGNABLE_HEADERS）；这个向量签了 range，用 allHeaders 核对规范请求的算法
  it('GET Object（带 Range，allHeaders）', async () => {
    const s = await signS3({
      ...base('GET', 'https://examplebucket.s3.amazonaws.com/test.txt', { range: 'bytes=0-9', 'x-amz-content-sha256': EMPTY_SHA256 }),
      allHeaders: true,
    });
    expect(s.authorization).toBe(
      `AWS4-HMAC-SHA256 ${CRED}, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ` +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('PUT Object（路径里有 $，带 Date 和 x-amz-storage-class）', async () => {
    const s = await signS3(
      base('PUT', 'https://examplebucket.s3.amazonaws.com/test$file.text', {
        date: 'Fri, 24 May 2013 00:00:00 GMT',
        'x-amz-storage-class': 'REDUCED_REDUNDANCY',
        'x-amz-content-sha256': '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072',
      }),
    );
    expect(s.authorization).toBe(
      `AWS4-HMAC-SHA256 ${CRED}, SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, ` +
        'Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd',
    );
  });

  it('改一个字节签名就变（防止上面的断言写成恒真）', async () => {
    const s = await signS3({
      ...base('GET', 'https://examplebucket.s3.amazonaws.com/?lifecycle', { 'x-amz-content-sha256': EMPTY_SHA256 }),
      secretAccessKey: AWS_DOC_SECRET.replace('EXAMPLEKEY', 'EXAMPLEKEZ'),
    });
    expect(s.authorization).not.toContain('fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543');
  });

  it('不带 x-amz-content-sha256 时用 UNSIGNED-PAYLOAD（流式上传），并带上 x-amz-date；content-type 不进签名（aws4fetch 默认）', async () => {
    const s = await signS3(base('PUT', 'https://acct.r2.cloudflarestorage.com/files/a.pdf', { 'content-type': 'application/pdf' }));
    expect(s.headers.get('x-amz-content-sha256')).toBe('UNSIGNED-PAYLOAD');
    expect(s.headers.get('x-amz-date')).toBe('20130524T000000Z');
    expect(s.authorization).toContain('SignedHeaders=host;x-amz-content-sha256;x-amz-date, ');
  });
});
