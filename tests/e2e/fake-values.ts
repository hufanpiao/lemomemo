// E2E 假后端的固定假值（tests/e2e/fake-backends.ts、playwright.config.ts、files.spec.ts 共用）。
// 一看就是假的，只给本机用，不是密钥；真的 R2 令牌、FILES_URL_SECRET 只在预览、正式（环境清单第四节）。
export const FAKE_S3_PORT = 9199;
export const FAKE_SUPABASE_PORT = 9198;
export const FAKE_S3_KEY_ID = 'FAKEKEYIDE2EONLY';
export const FAKE_S3_SECRET = 'fake-s3-secret-for-e2e-only';
export const FAKE_ANON_KEY = 'fake-anon-key';
export const FAKE_FILES_URL_SECRET = 'fake-files-url-secret-for-e2e-only-000000';
/** /sb 转发层写给上游的 x-proxy-secret；没有它 functions/sb/[[path]].ts 一律回 500 proxy_misconfigured */
export const FAKE_PROXY_SECRET = 'fake-proxy-secret-for-e2e-only';

/** wrangler pages dev 的 --binding（/files 和 /sb 函数读的环境变量），指向本机假后端；R2_BUCKET_PREFIX 不设（当空字符串） */
export const E2E_BINDINGS: Record<string, string> = {
  SUPABASE_UPSTREAM: `http://127.0.0.1:${FAKE_SUPABASE_PORT}`,
  SUPABASE_ANON_KEY: FAKE_ANON_KEY,
  R2_ENDPOINT: `http://127.0.0.1:${FAKE_S3_PORT}`,
  R2_FILES_ACCESS_KEY_ID: FAKE_S3_KEY_ID,
  R2_FILES_SECRET_ACCESS_KEY: FAKE_S3_SECRET,
  FILES_URL_SECRET: FAKE_FILES_URL_SECRET,
  PROXY_SECRET: FAKE_PROXY_SECRET,
};
