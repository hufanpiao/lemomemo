// 铃铛记号（线框 s1b 的 BELL）：整页提醒的类型行、“错过 N 条提醒”一行用；装饰，读屏跳过
export function Bell({ className }: { className?: string | undefined }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M8 1.75a4.25 4.25 0 0 0-4.25 4.25v2.6L2.5 11.1v.65h11v-.65L12.25 8.6V6A4.25 4.25 0 0 0 8 1.75Zm-1.6 11.1a1.6 1.6 0 0 0 3.2 0Z"
        fill="currentColor"
      />
    </svg>
  );
}
