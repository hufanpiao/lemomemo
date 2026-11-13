// 功能 attachments 懒加载的组件（index.ts 转出；单独一个文件，只跟引它的块走，不进首屏，见 index.ts 文件头）
import { lazy } from 'react';

export const NoteAttachments = lazy(() => import('./ui/NoteAttachments.tsx'));
