// 功能 ai-provider：设置 › 我的 AI（人人都有）、AI 服务商（只有管理员看得到）两页（方案 设计方案/2026-11-22_AI服务商，管理员页方向二）
// 对外唯一入口：只导出一个懒加载组件和服务商的显示名；别的功能只能 import 这个文件
// 没有自己的页面（routes 空），不在 app/features.ts 登记：只有设置页（本身懒加载）引这个文件，这里的东西都不进首屏
import { lazy } from 'react';

export const routes = [] as const;

/**
 * 设置页里用到的几块，part 区分（服务器函数 ai-provider，契约 shared/schema/ai-provider.ts）：
 * • 'myAiValue'：设置首页“我的 AI”一行右边的值（“柠檬记提供 · 12 / 50”“自己的密钥 · OpenAI”）；行由设置页画
 * • 'adminRow'：设置首页“AI 服务商”整行（不是管理员、还没读到时什么都不画）；props 带 onOpen
 * • 'adminOnly'：只有管理员才画 children（设置首页“邀请朋友”一行；和 'adminRow' 同一个判断）
 * • 'myAi'：“我的 AI”二级页正文
 * • 'admin'：“AI 服务商”二级页正文；props 带 onOpenKey(provider) 进密钥详情
 * • 'adminKey'：密钥详情页正文；props 带 provider（地址里的那一段，认不出就不画）
 */
export const AiProviderSettings = lazy(() => import('./ui/AiProviderSettings.tsx'));

/** 四家服务商和联网搜索三家（Brave、Tavily、Naver）的显示名（设置页给密钥详情页的顶栏标题用；品牌名中韩一样，不进词典） */
export const AI_PROVIDER_LABEL = { gemini: 'Gemini', claude: 'Claude', openai: 'OpenAI', deepseek: 'DeepSeek', brave: 'Brave', tavily: 'Tavily', naver: 'Naver' } as const;
