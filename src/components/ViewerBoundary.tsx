import React from "react";
import { AlertTriangle } from "lucide-react";

interface Props {
  /** Resets the boundary's error state when this changes (e.g. file switch). */
  resetKey?: string;
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

// Catches throws from any viewer (NoteEditor's markdown pipeline,
// MindMapCanvas's d3 layout, DocxViewer's mammoth, ImageViewer's blob
// fetch). Without this a single render-time exception in one of them
// nukes the whole window — sidebar, title bar, settings modal, all
// gone. The boundary keeps the chrome alive and lets the user pick a
// different file. `resetKey` (typically openDoc.relPath) auto-recovers
// when the user switches to a healthy file instead of stranding them.
export class ViewerBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("Viewer error:", error, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="viewer-error-boundary">
          <AlertTriangle size={32} />
          <h2>Couldn't display this file</h2>
          <p>{this.state.error.message || String(this.state.error)}</p>
          <p className="viewer-error-hint">
            Pick a different file on the left, or fix the source on disk and reopen.
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}
