type Props = {
  /** "mark" = icon only; "full" = icon + wordmark */
  variant?: "mark" | "full";
  /** pixel size of the mark (wordmark scales with it) */
  size?: number;
  className?: string;
};

/**
 * Brand mark for LawStack/aiops. A terminal-blinker square with a
 * ">" prompt inside — renders crisp at any size. Stroke uses the
 * signal-room electric-green accent token so it follows light/dark.
 */
export function Brandmark({ variant = "full", size = 28, className }: Props) {
  const stroke = "var(--accent)";
  const fg = "var(--foreground)";

  return (
    <span
      className={className}
      style={{ display: "inline-flex", alignItems: "center", gap: size * 0.32 }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        role="img"
        aria-label="LawStack/aiops"
      >
        {/* terminal frame */}
        <rect
          x="2"
          y="2"
          width="28"
          height="28"
          rx="4"
          fill="none"
          stroke={stroke}
          strokeWidth="2"
        />
        {/* ">" prompt */}
        <path
          d="M9 12 L14 16 L9 20"
          fill="none"
          stroke={stroke}
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* blinking cursor bar */}
        <rect x="17" y="19" width="7" height="2.2" fill={stroke}>
          <animate
            attributeName="opacity"
            values="1;1;0;0;1"
            dur="1.2s"
            repeatCount="indefinite"
          />
        </rect>
      </svg>
      {variant === "full" ? (
        <span
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 600,
            letterSpacing: "-0.01em",
            fontSize: size * 0.56,
            color: fg,
            lineHeight: 1,
          }}
        >
          LawStack<span style={{ opacity: 0.5 }}>/</span>
          <span style={{ color: stroke }}>aiops</span>
        </span>
      ) : null}
    </span>
  );
}
