// 功能 attachments：文档附件和预览入口（note_files；预览沙箱本身在 src/preview-frame/）
// 对外唯一入口（架构 2.1、A27）：只导出懒加载的页面、登记项、类型和清单引用；别的功能只能 import 这个文件
// 附件没有自己的页面（routes 空），不在 app/features.ts 登记：只有随手记编辑器、隐私记编辑器（都是懒加载块）引这个文件，懒加载表不进首屏
import { lazy } from 'react';

export const routes = [] as const;
/**
 * 随手记里的附件区（B4b-1，线框 sAtt）：随手记编辑器、电脑抽屉在插图区下面挂。
 * props: { noteId: 这条随手记的 id（新建还没存时 null）; disabled: 只读或已删除; onImages?(files): 拖进来、粘贴进来的图片交回去照插图处理 }
 */
export const NoteAttachments = lazy(() => import('./ui/NoteAttachments.tsx'));

/**
 * 隐私记里的附件区（B4b-1，架构 5.13 第 11 点）：隐私记编辑器在图片下面挂（这条保存过、有 id 才挂）。
 * props: { noteId; api: VaultFileApi（隐私记功能给的 vault-file 传输，带会话令牌）; disabled }
 */
export const VaultAttachments = lazy(() => import('./ui/VaultAttachments.tsx'));

/**
 * 随手记编辑器里一张图下面的识别状态（B4b-2 识图，线框 sAIst）：识图中 / 没识别 +“重新识别” / 没交给 AI +“去打开” / AI 看到的。
 * props: { id: note_images 的 id }；上传中、没传上的图不挂。行是同步下来的，隐私记的图、删了的、没有可显示状态的不出东西
 */
export const ImageAiStatus = lazy(() => import('./ui/ImageAiStatus.tsx'));

export type { VaultFileApi, VaultFileFail } from './data/vault-att.ts';
