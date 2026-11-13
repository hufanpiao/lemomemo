// 功能 attachments：文档附件和预览入口（note_files；预览沙箱本身在 src/preview-frame/）
// 对外唯一入口（架构 2.1、A27）：只导出懒加载的页面、登记项、类型和清单引用；别的功能只能 import 这个文件
// 首屏额度（B4b-1）：这个文件经 app/features.ts 进首屏，所以只许 export … from，并在 vite.config.ts 的 PURE_REEXPORT_RULES 里标成无副作用：
//   首屏只用 routes（routes.ts），懒加载的 NoteAttachments（lazy.ts）只跟引它的随手记编辑器那一块走，懒加载表不进首屏
export { routes } from './routes.ts';
/**
 * 随手记里的附件区（B4b-1，线框 sAtt）：随手记编辑器、电脑抽屉在插图区下面挂。
 * props: { noteId: 这条随手记的 id（新建还没存时 null）; disabled: 只读或已删除; onImages?(files): 拖进来、粘贴进来的图片交回去照插图处理 }
 */
export { NoteAttachments } from './lazy.ts';
