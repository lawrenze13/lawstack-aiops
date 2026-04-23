import { opsHealth, type ViewerScope } from "@/server/lib/dashboardQueries";

export function OpsHealthTile({ scope }: { scope: ViewerScope }) {
  let data: Awaited<ReturnType<typeof opsHealth>>;
  try {
    data = opsHealth(scope);
  } catch (err) {
    return (
      <TileShell title="ops · health" note="failed to load">
        <p className="text-xs text-red-600">{(err as Error).message}</p>
      </TileShell>
    );
  }

  const { live, stuck, errors24h } = data;
  const healthy = stuck === 0 && errors24h === 0;

  return (
    <TileShell
      title="ops · health"
      note={healthy ? "all green" : "needs attention"}
      tone={healthy ? "ok" : stuck > 0 ? "warn" : "ok"}
    >
      <div className="grid grid-cols-3 gap-4">
        <Stat label="Live" value={String(live)} tone="accent" />
        <Stat label="Stuck" value={String(stuck)} tone={stuck > 0 ? "warn" : "muted"} />
        <Stat
          label="Errors 24h"
          value={String(errors24h)}
          tone={errors24h > 0 ? "danger" : "muted"}
        />
      </div>
    </TileShell>
  );
}

export function TileShell({
  title,
  note,
  tone = "muted",
  children,
}: {
  title: string;
  note?: string;
  tone?: "ok" | "warn" | "danger" | "muted";
  children: React.ReactNode;
}) {
  const noteColor = {
    ok: "text-[color:var(--accent)]",
    warn: "text-amber-600 dark:text-amber-400",
    danger: "text-red-600 dark:text-red-400",
    muted: "text-[color:var(--muted)]",
  }[tone];
  return (
    <section className="rounded-lg border border-[color:var(--border)] bg-[color:var(--surface)]">
      <header className="flex items-center justify-between border-b border-[color:var(--border)] px-4 py-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[color:var(--muted)]">
          {title}
        </span>
        {note ? (
          <span className={`font-mono text-[10px] uppercase tracking-[0.12em] ${noteColor}`}>
            {note}
          </span>
        ) : null}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "accent" | "warn" | "danger" | "muted";
}) {
  const color = {
    accent: "text-[color:var(--accent)]",
    warn: "text-amber-600 dark:text-amber-400",
    danger: "text-red-600 dark:text-red-400",
    muted: "text-[color:var(--foreground)]",
  }[tone];
  return (
    <div>
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-[color:var(--muted)]">
        {label}
      </div>
      <div className={`mt-1 font-mono text-2xl font-semibold ${color}`}>{value}</div>
    </div>
  );
}
