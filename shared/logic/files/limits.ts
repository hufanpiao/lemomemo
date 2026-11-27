// 附件的大小上限，只在这里写一次（架构 5.13 第 1 点“单个文件 ≤ 10 MB”）：清单 attachments.ts 的 files 桶 fileSizeLimit、
// 客户端加附件前本机判（features/attachments/data/file-prep.ts）、服务器 file-check 复查都引这一个。
// 不引 zod 和清单（file-check 的 core.ts 要在 Vitest 的 tsc 下编译，gen 下带 npm: 说明符的模块它解析不了）。

/** 单个附件原文件最多 10 MB */
export const FILE_MAX_BYTES = 10_485_760;
