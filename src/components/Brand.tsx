export function HermesMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="7.1" stroke="currentColor" strokeWidth="1.35" />
      <path d="M5.2 11.7c2.1-1.2 4.8-2.1 9.7-2.5M6.1 8.9l2.4-2.5M6.1 13.4l2.4 2.1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="12.7" cy="9.3" r="1.15" fill="currentColor" />
    </svg>
  );
}
