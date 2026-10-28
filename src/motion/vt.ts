// View Transitions 的名字统一在这里生成（架构 17.2 第 3 点）：vt-item-<id>
// 同一时刻页面上不能有两个同名元素：开发版里检查并在控制台报错

export function vtName(kind: 'item' | 'plus' | 'nav', id = ''): string {
  const safe = id.replace(/[^A-Za-z0-9_-]/g, '');
  return safe ? `vt-${kind}-${safe}` : `vt-${kind}`;
}

/** 开发版：找出重名的 view-transition-name（返回重名的名字） */
export function findDuplicateVtNames(root: ParentNode): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const el of root.querySelectorAll<HTMLElement>('[style*="view-transition-name"]')) {
    const n = el.style.getPropertyValue('view-transition-name');
    if (!n || n === 'none') continue;
    if (seen.has(n)) dup.add(n);
    seen.add(n);
  }
  return [...dup];
}
