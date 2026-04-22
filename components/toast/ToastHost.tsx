"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type ToastKind = "success" | "error" | "warn" | "info";

type Toast = {
  id: number;
  kind: ToastKind;
  title: string;
  body?: string;
  ts: number;
};

type ToastCtx = {
  push: (t: Omit<Toast, "id" | "ts">) => void;
};

const Ctx = createContext<ToastCtx | null>(null);

const MAX_VISIBLE = 5;
const TTL_MS = 6_000;

/**
 * Mount in the root layout. Child components use useToast() to push toasts.
 * Also drives a document.title badge "(N)" when the tab is hidden and a
 * new toast arrives, cleared on focus.
 */
export function ToastHost({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const titleRef = useRef<string | null>(null);
  const unreadRef = useRef(0);

  const push = useCallback((t: Omit<Toast, "id" | "ts">) => {
    const id = nextId.current++;
    const entry: Toast = { ...t, id, ts: Date.now() };
    setToasts((prev) => [...prev.slice(-(MAX_VISIBLE - 1)), entry]);

    // If the tab is hidden, bump the unread counter in the title.
    if (typeof document !== "undefined" && document.hidden) {
      unreadRef.current += 1;
      if (titleRef.current === null) titleRef.current = document.title;
      document.title = `(${unreadRef.current}) ${titleRef.current}`;
    }

    // Auto-dismiss.
    setTimeout(() => {
      setToasts((prev) => prev.filter((x) => x.id !== id));
    }, TTL_MS);
  }, []);

  // Clear unread badge when the tab regains focus.
  useEffect(() => {
    const onVisibility = () => {
      if (!document.hidden && titleRef.current !== null) {
        document.title = titleRef.current;
        titleRef.current = null;
        unreadRef.current = 0;
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onVisibility);
    };
  }, []);

  // Memo the context value so consumers' useEffect deps (e.g. the refresh
  // scheduler in RunLog) don't re-run whenever a toast fires. Without
  // this, pushing a toast triggers a ToastHost re-render → new {push}
  // object → every useEffect depending on `toast` re-runs → their
  // cleanups cancel whatever they'd scheduled.
  const ctxValue = useMemo(() => ({ push }), [push]);

  return (
    <Ctx.Provider value={ctxValue}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <ToastCard key={t.id} toast={t} onDismiss={() => setToasts((p) => p.filter((x) => x.id !== t.id))} />
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastCtx {
  const ctx = useContext(Ctx);
  if (!ctx) {
    // Permit callers without a provider — they still function but toasts are silently dropped.
    return { push: () => {} };
  }
  return ctx;
}

function ToastCard({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: () => void;
}) {
  // Solid backgrounds + left accent border per kind. Text resolves through
  // our theme vars so dark mode keeps high contrast.
  const accent: Record<ToastKind, string> = {
    success: "border-l-green-500",
    error: "border-l-red-500",
    warn: "border-l-amber-500",
    info: "border-l-blue-500",
  };
  const iconColor: Record<ToastKind, string> = {
    success: "text-green-600",
    error: "text-red-600",
    warn: "text-amber-600",
    info: "text-blue-600",
  };
  const icon: Record<ToastKind, string> = {
    success: "✓",
    error: "✘",
    warn: "⚠",
    info: "ℹ",
  };
  return (
    <div
      role="status"
      className={`pointer-events-auto flex w-80 items-start gap-3 rounded-md border border-l-4 bg-[color:var(--surface)] px-3 py-2.5 text-xs text-[color:var(--foreground)] shadow-xl border-[color:var(--border)] ${accent[toast.kind]}`}
    >
      <span className={`mt-0.5 text-sm font-bold ${iconColor[toast.kind]}`}>
        {icon[toast.kind]}
      </span>
      <div className="flex-1">
        <div className="font-semibold">{toast.title}</div>
        {toast.body ? (
          <div className="mt-0.5 text-[11px] text-[color:var(--muted)]">
            {toast.body}
          </div>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="ml-auto text-[color:var(--muted)] hover:text-[color:var(--foreground)]"
        aria-label="dismiss"
      >
        ✕
      </button>
    </div>
  );
}
