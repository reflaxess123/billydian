// Lightweight toast store. No React context — a plain pub/sub emitter
// so any module (even non-component code like activateVault catch blocks)
// can push a toast without prop-drilling. `ToastContainer` subscribes
// and renders.

export type ToastKind = "info" | "success" | "error" | "progress";

export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
  /** ms before auto-dismiss; null = persistent until manually dismissed. */
  duration: number | null;
  createdAt: number;
}

type Listener = (toasts: ReadonlyArray<Toast>) => void;

class ToastStore {
  private toasts: Toast[] = [];
  private listeners = new Set<Listener>();
  private timers = new Map<string, number>();
  private counter = 0;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.toasts);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit() {
    const snapshot = this.toasts.slice();
    for (const fn of this.listeners) fn(snapshot);
  }

  private id(): string {
    this.counter += 1;
    return `t${this.counter}`;
  }

  private push(toast: Omit<Toast, "id" | "createdAt">): string {
    const id = this.id();
    const full: Toast = { ...toast, id, createdAt: Date.now() };
    this.toasts = [...this.toasts, full];
    this.emit();
    if (full.duration !== null) {
      this.scheduleDismiss(id, full.duration);
    }
    return id;
  }

  private scheduleDismiss(id: string, ms: number) {
    const prev = this.timers.get(id);
    if (prev !== undefined) window.clearTimeout(prev);
    const t = window.setTimeout(() => {
      this.timers.delete(id);
      this.dismiss(id);
    }, ms);
    this.timers.set(id, t);
  }

  info(message: string, duration = 3000): string {
    return this.push({ kind: "info", message, duration });
  }

  success(message: string, duration = 3500): string {
    return this.push({ kind: "success", message, duration });
  }

  error(message: string, duration = 6500): string {
    return this.push({ kind: "error", message, duration });
  }

  /** Persistent progress toast. Caller dismisses or replaces via
   *  `resolveProgress` once the underlying op finishes. */
  progress(message: string): string {
    return this.push({ kind: "progress", message, duration: null });
  }

  /** Update an existing toast's message (typically for progress
   *  steps). Silently no-ops if the toast was already dismissed. */
  update(id: string, message: string): void {
    const idx = this.toasts.findIndex((t) => t.id === id);
    if (idx < 0) return;
    this.toasts = [
      ...this.toasts.slice(0, idx),
      { ...this.toasts[idx], message },
      ...this.toasts.slice(idx + 1),
    ];
    this.emit();
  }

  /** Convert a persistent progress toast into a final success/error
   *  state with auto-dismiss. Convenience wrapper around dismiss + push. */
  resolveProgress(
    id: string,
    kind: "success" | "error",
    message: string,
  ): string {
    this.dismiss(id);
    return kind === "success" ? this.success(message) : this.error(message);
  }

  dismiss(id: string): void {
    const before = this.toasts.length;
    this.toasts = this.toasts.filter((t) => t.id !== id);
    if (this.toasts.length !== before) {
      const timer = this.timers.get(id);
      if (timer !== undefined) {
        window.clearTimeout(timer);
        this.timers.delete(id);
      }
      this.emit();
    }
  }

  dismissAll(): void {
    if (this.toasts.length === 0) return;
    for (const t of this.timers.values()) window.clearTimeout(t);
    this.timers.clear();
    this.toasts = [];
    this.emit();
  }
}

export const toast = new ToastStore();
