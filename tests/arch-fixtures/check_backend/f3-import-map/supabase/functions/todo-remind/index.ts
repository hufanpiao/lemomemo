// 违规 F3：config.toml 的 import_map 指的文件里（scopes）别名 r2 指到 objstore
import { createObjStore } from 'r2';
export const x = createObjStore;
