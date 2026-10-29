// 对照：引 node:crypto、npm 包、相对路径不报
import { createHash } from 'node:crypto';
import { z } from 'npm:zod@4.6.7';
export const b = [createHash, z];
