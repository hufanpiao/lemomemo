// F10 违规样例（BE1-S3）：supabase/functions/ 下的 tests/ 目录不放过，这里的文件可能被函数 import 进部署产物
export const ALLOW = ['kong', 'host.docker.internal'];
