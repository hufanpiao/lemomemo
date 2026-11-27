// arch-fixture: path=src/features/notes/ui/Bad.tsx expect=react/no-array-index-key rule=T3
// 违规：列表用下标当 key
export const Bad = ({ items }: { items: string[] }) => (
  <ul>
    {items.map((s, i) => (
      <li key={i}>{s}</li>
    ))}
  </ul>
);
