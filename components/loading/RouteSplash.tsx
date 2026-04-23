type Props = {
  /** Mono uppercase section label shown above the pulse (e.g., "dashboard"). */
  label?: string;
  /** Short plain-language hint shown below. */
  hint?: string;
};

/**
 * Shared loading splash used by every loading.tsx boundary. Signal-room
 * aesthetic: scanning accent bar + mono status label. Renders inside
 * whichever layout it lives under, so the sidebar + header stay visible
 * while the content area reloads.
 */
export function RouteSplash({
  label = "loading",
  hint = "reticulating swimlanes…",
}: Props) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="w-full max-w-sm">
        {/* Faux terminal card matches sign-in/setup styling */}
        <div className="overflow-hidden rounded-lg border border-[color:var(--border)] bg-[color:var(--surface)]">
          <div className="flex items-center gap-2 border-b border-[color:var(--border)] bg-[color:var(--surface-secondary)]/60 px-3 py-2">
            <span className="h-2.5 w-2.5 rounded-full bg-[color:var(--border)]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[color:var(--border)]" />
            <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-[color:var(--accent)]/70" />
            <span className="ml-2 font-mono text-[11px] text-[color:var(--muted)]">
              ~/aiops — {label}
            </span>
          </div>

          <div className="p-6">
            <div className="mb-3 font-mono text-[10px] uppercase tracking-[0.18em] text-[color:var(--muted)]">
              status · loading
            </div>

            {/* Scanning bar — a thin line that sweeps L→R using CSS keyframes. */}
            <div className="relative h-1 overflow-hidden rounded-full bg-[color:var(--surface-secondary)]">
              <div className="absolute inset-y-0 left-0 w-1/3 animate-[scan_1.2s_ease-in-out_infinite] bg-[color:var(--accent)]" />
            </div>

            <p className="mt-4 font-mono text-[11px] text-[color:var(--muted)]">
              {hint}
            </p>

            {/* Three-dot pulse for a bit of life. */}
            <div className="mt-4 flex items-center gap-1.5">
              <Dot delay="0s" />
              <Dot delay="0.15s" />
              <Dot delay="0.3s" />
            </div>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes scan {
          0%   { transform: translateX(-100%); }
          50%  { transform: translateX(200%); }
          100% { transform: translateX(200%); }
        }
      `}</style>
    </div>
  );
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="h-1.5 w-1.5 animate-pulse rounded-full bg-[color:var(--accent)]/70"
      style={{ animationDelay: delay, animationDuration: "0.9s" }}
    />
  );
}
