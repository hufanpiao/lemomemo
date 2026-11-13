// 界面要用的纯函数和类型（A1：ui 不直接碰 data，经 hooks 转出；照 reminders/hooks/remind-view.ts）：都在 ../data 里实现、有单测
export { FILTERS, type AnnivFilter, type AnnivItem } from '../data/anniv-model.ts';
export { defaultsWrites, leapOf, maxDay, NAME_MAX, NOTE_MAX, offsetsKey, offsetsList, recOf, yearRange, type AnnivForm } from '../data/anniv-edit.ts';
export { clearAvatar, encodeAvatar, setAvatar, type AvatarResult, type Crop } from '../data/avatar.ts';
export { annivLib, type AnnivLib } from '../../../core/anniv-lib.ts';
export { useAnnivLib } from '../../../kit/hooks/useAnnivLib.ts';
