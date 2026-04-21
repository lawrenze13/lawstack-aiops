"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
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

  return (
    <Ctx.Provider value={{ push }}>
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
  const palette: Record<ToastKind, string> = {
    success: "border-green-500/40 bg-green-500/10 text-green-900",
    error: "border-red-500/40 bg-red-500/10 text-red-900",
    warn: "border-amber-500/40 bg-amber-500/10 text-amber-900",
    info: "border-blue-500/40 bg-blue-500/10 text-blue-900",
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
      className={`pointer-events-auto flex w-80 items-start gap-3 rounded-md border px-3 py-2 text-xs shadow-lg ${palette[toast.kind]}`}
    >
      <span className="mt-0.5 text-sm">{icon[toast.kind]}</span>
      <div className="flex-1">
        <div className="font-semibold">{toast.title}</div>
        {toast.body ? <div className="mt-0.5 text-[11px] opacity-90">{toast.body}</div> : null}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="ml-auto text-[10px] opacity-60 hover:opacity-100"
        aria-label="dismiss"
      >
        ✕
      </button>
    </div>
  );
}
