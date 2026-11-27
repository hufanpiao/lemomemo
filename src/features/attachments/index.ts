// 功能 attachments：文档附件和预览入口（note_files；预览沙箱本身在 src/preview-frame/）
// 对外唯一入口：只导出懒加载的页面、登记项、类型和清单引用；别的功能只能 import 这个文件
// 附件没有自己的页面（routes 空），不在 app/features.ts 登记：只有随手记编辑器、隐私记编辑器（都是懒加载块）引这个文件，懒加载表不进首屏
import { lazy } from 'react';

export const routes = [] as const;
/**
 * 随手记里的附件区：随手记编辑器、电脑抽屉在插图区下面挂。
 * props: { noteId: 这条随手记的 id（新建还没存时 null）; disabled: 只读或已删除; onImages?(files): 拖进来、粘贴进来的图片交回去照插图处理 }
 */
export const NoteAttachments = lazy(() => import('./ui/NoteAttachments.tsx'));

/**
 * 隐私记里的附件区：隐私记编辑器在图片下面挂（这条保存过、有 id 才挂）。
 * props: { noteId; api: VaultFileApi（隐私记功能给的 vault-file 传输，带会话令牌）; disabled }
 */
export const VaultAttachments = lazy(() => import('./ui/VaultAttachments.tsx'));

/**
 * 手机、窄窗口的“文档请在电脑上加。/ 手机上可以看、预览、下载。”（两行，电脑布局不出东西）：随手记、隐私记手机编辑页底部工具条右侧挂。
 * 和 NoteAttachments 是同一个懒加载块（同一个模块，带 hint 时只画提示），不另占分包。props: { hint: true; className: 外观由挂它的地方给 }
 */
export const AttPhoneHint = lazy(() => import('./ui/NoteAttachments.tsx'));

/**
 * 随手记编辑器里一张图下面的识别状态：识图中 / 没识别 +“重新识别” / 没交给 AI +“去打开”；识别好了不出东西。
 * props: { id: note_images 的 id }；上传中、没传上的图不挂。行是同步下来的，隐私记的图、删了的、没有可显示状态的不出东西
 */
export const ImageAiStatus = lazy(() => import('./ui/ImageAiStatus.tsx'));

/**
 * 看图页（电脑是看图浮层）：点随手记里的插图打开。顶上“✕ 关闭 · 第几张 / 共几张”，中间大图（左右滑、左右键换张），
 * 底部这张识别好了才出“AI 看到的”。props: { ids: 图的 id 按顺序; start: 先看第几张; render(i): 画第 i 张大图; back: 打开它的元素; onClose }
 */
export const ImageViewer = lazy(() => import('./ui/ImageViewer.tsx'));

export type { VaultFileApi, VaultFileFail } from './data/vault-att.ts';
