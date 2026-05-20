import React, { useEffect, useState } from "react";
import { CheckCircle2, AlertCircle, Info, Loader2, X } from "lucide-react";
import { toast, Toast } from "../lib/toast";

// Fixed in the top-right corner of the viewport. New toasts push the
// stack down with a slide-in; dismissal collapses with a slide-out.
// The exit animation hooks `onAnimationEnd` so DOM cleanup waits for
// the keyframes to finish — pushing/pulling raw children from `toasts`
// state alone would yank them out before they could animate.

const KIND_ICON: Record<Toast["kind"], React.ReactNode> = {
  info: <Info size={15} />,
  success: <CheckCircle2 size={15} />,
  error: <AlertCircle size={15} />,
  progress: <Loader2 size={15} className="spin" />,
};

interface RowProps {
  t: Toast;
  exiting: boolean;
  onExited: (id: string) => void;
}

const ToastRow: React.FC<RowProps> = ({ t, exiting, onExited }) => {
  return (
    <div
      className={`toast toast-${t.kind}${exiting ? " toast-exit" : ""}`}
      role={t.kind === "error" ? "alert" : "status"}
      onAnimationEnd={(e) => {
        if (exiting && e.animationName === "toastOut") onExited(t.id);
      }}
    >
      <span className="toast-icon">{KIND_ICON[t.kind]}</span>
      <span className="toast-message">{t.message}</span>
      {/* Progress toasts have no close button — they're driven by the
          op that created them. Everything else is user-dismissible. */}
      {t.kind !== "progress" && (
        <button
          type="button"
          className="toast-close"
          onClick={() => toast.dismiss(t.id)}
          aria-label="Dismiss notification"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
};

export const ToastContainer: React.FC = () => {
  // `live` mirrors the store; `exiting` holds IDs whose toast has been
  // dismissed but whose exit animation hasn't finished yet. The DOM
  // keeps both so the slide-out is visible.
  const [live, setLive] = useState<ReadonlyArray<Toast>>([]);
  const [exiting, setExiting] = useState<Map<string, Toast>>(new Map());

  useEffect(() => {
    return toast.subscribe((next) => {
      setLive((prev) => {
        const liveIds = new Set(next.map((t) => t.id));
        const gone = prev.filter((t) => !liveIds.has(t.id));
        if (gone.length > 0) {
          setExiting((cur) => {
            const m = new Map(cur);
            for (const t of gone) m.set(t.id, t);
            return m;
          });
        }
        return next;
      });
    });
  }, []);

  const onExited = (id: string) => {
    setExiting((cur) => {
      if (!cur.has(id)) return cur;
      const m = new Map(cur);
      m.delete(id);
      return m;
    });
  };

  const liveIds = new Set(live.map((t) => t.id));
  // Render order: live toasts first (oldest at top), then exiting
  // toasts that are no longer in `live`. Exiting toasts visually stay
  // in place — they just fade/slide out under their own animation.
  const rows: { t: Toast; exiting: boolean }[] = [
    ...live.map((t) => ({ t, exiting: false })),
    ...[...exiting.values()]
      .filter((t) => !liveIds.has(t.id))
      .map((t) => ({ t, exiting: true })),
  ];

  if (rows.length === 0) return null;
  return (
    <div className="toast-container" aria-live="polite">
      {rows.map(({ t, exiting }) => (
        <ToastRow key={t.id} t={t} exiting={exiting} onExited={onExited} />
      ))}
    </div>
  );
};
