// arch-fixture: path=src/features/notes/ui/Bad.tsx expect=react/jsx-no-target-blank rule=T3
// 违规：target="_blank" 没有 rel="noreferrer"
export const Bad = () => (
  <a href="https://example.com" target="_blank" rel="opener">
    x
  </a>
);
