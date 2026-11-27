// 麦克风记号（线框 s10 MICCARD 卡顶的 .mic2：胶囊 + 下面的 U 形托 + 短柄，放大 1.4 倍）：说明卡两张都用；装饰，读屏跳过
// 同 reminders/ui/Bell.tsx 的写法：内联 SVG、currentColor，不引图标库
export function MicGlyph({ className }: { className?: string | undefined }) {
  return (
    <svg className={className} width="32" height="40" viewBox="0 0 32 40" aria-hidden="true" focusable="false" data-testid="mic-glyph">
      <g fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
        <rect x="9.5" y="1.5" width="13" height="22" rx="6.5" />
        <path d="M4 17.5a12 12 0 0 0 24 0" />
        <path d="M16 29.5v8" />
      </g>
    </svg>
  );
}
