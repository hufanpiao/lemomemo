// arch-fixture: path=src/features/notes/ui/Bad.tsx expect=jsx-a11y/alt-text rule=T3
// 违规：图片没有 alt
export const Bad = () => <img src="/icon.png" />;
