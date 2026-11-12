// 按住“＋”的手势对界面层转出（B3 FA-3；界面层不直接引 data，A1）：ui/TypeBar.tsx 从这里转给 app/plus-slot.tsx。
// 单放一个文件、不从 useVoice.ts 转：打字条那一块只带手势判定（data/hold-input.ts），录音器、手机识别、面板留在 RecordHost 那一块按需加载
export { hold } from '../data/hold-input.ts';
