// Edge Function 请求体和返回体的 schema 骨架（架构 2.5）
// B0 只放公共部分：错误返回、426 升级提示。各函数的 schema 随对应批次由后端加，前端按同一份推导返回类型
import { z } from 'zod';

/** 函数返回的错误只带错误码，文字由前端翻译（2.4 第 5 条） */
export const apiError = z.object({
  code: z.string().min(1).max(64),
});

/** 转发层和函数在客户端版本过低时回的 426 响应体（0.27 第 1 点） */
export const upgradeRequired = z.object({
  code: z.literal('upgrade_required'),
  min: z.string().regex(/^\d+\.\d+\.\d+$/),
});

export type ApiError = z.infer<typeof apiError>;
export type UpgradeRequired = z.infer<typeof upgradeRequired>;
