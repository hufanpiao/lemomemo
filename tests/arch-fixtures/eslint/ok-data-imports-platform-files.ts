// arch-fixture: path=src/features/notes/data/images.ts expect=none
// 对照（应通过）：功能的 data 层用 platform/files.ts 上传、签名、取字节；ui 照旧可以用 platform 的其他文件
import { fetchBlob, sign, upload } from '../../../platform/files.ts';
export const api = { fetchBlob, sign, upload };
