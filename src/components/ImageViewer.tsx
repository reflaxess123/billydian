import React, { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ZoomIn, ZoomOut, Maximize2 } from "lucide-react";

interface ImageViewerProps {
  /** Absolute vault path (used to fetch the file via IPC). */
  vaultPath: string;
  /** Vault-relative path of the image. */
  relPath: string;
  /** Basename of the file — used for the alt-text and download fallback. */
  alt: string;
}

const MIN_SCALE = 0.05;
const MAX_SCALE = 16;

function mimeForExt(name: string): string {
  const ext = (name.toLowerCase().match(/\.([^.]+)$/) ?? [, ""])[1];
  switch (ext) {
    case "svg":  return "image/svg+xml";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif":  return "image/gif";
    case "webp": return "image/webp";
    case "avif": return "image/avif";
    case "bmp":  return "image/bmp";
    case "ico":  return "image/x-icon";
    default:     return "image/png";
  }
}

const ImageViewerImpl: React.FC<ImageViewerProps> = ({ vaultPath, relPath, alt }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  // Natural image dimensions, captured once the picture has loaded so
  // we can compute the initial "fit" scale. Stored in a ref AND state:
  // state triggers the auto-fit effect; ref lets the Fit button compute
  // without depending on a fresh render closure.
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const imgSizeRef = useRef<{ w: number; h: number } | null>(null);
  // Blob URL is created from the raw bytes the backend ships via the
  // binary IPC channel. We OWN the URL — it's revoked the moment the
  // viewer unmounts or the user switches file. Without revoking, the
  // WebView retains the decoded image in its cache indefinitely; for
  // image-heavy workflows that's a steady RAM climb across a session.
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Fetch + wrap as blob URL whenever the file changes.
  useEffect(() => {
    let cancelled = false;
    let createdUrl: string | null = null;
    setBlobUrl(null);
    setLoadError(null);
    (async () => {
      try {
        const buf = await invoke<ArrayBuffer>("read_vault_file_blob", {
          vault: vaultPath,
          rel: relPath,
        });
        if (cancelled) return;
        const blob = new Blob([buf], { type: mimeForExt(relPath) });
        const url = URL.createObjectURL(blob);
        createdUrl = url;
        setBlobUrl(url);
      } catch (e: any) {
        if (!cancelled) setLoadError(String(e?.message || e || "Failed to load image"));
      }
    })();
    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [vaultPath, relPath]);

  // Live state mirrors so the mount-only wheel listener can read fresh
  // values without us re-binding on every zoom step.
  const scaleRef = useRef(scale);
  const txRef = useRef(translate.x);
  const tyRef = useRef(translate.y);
  useEffect(() => {
    scaleRef.current = scale;
  }, [scale]);
  useEffect(() => {
    txRef.current = translate.x;
    tyRef.current = translate.y;
  }, [translate]);

  // Reset state when a new image is opened — without this, switching
  // between files would keep the previous pan/zoom.
  useEffect(() => {
    setScale(1);
    setTranslate({ x: 0, y: 0 });
    setImgSize(null);
    imgSizeRef.current = null;
  }, [relPath]);

  // Compute a "fit" scale + reset pan. Pulls dimensions from the img DOM
  // element directly (`naturalWidth`/`naturalHeight`) so we don't depend
  // on the state value — that closure could be stale if the user clicks
  // Fit between the image load and the next render. Also unscales to
  // 100% for tiny pictures (`Math.min(1, …)` caps the upscale).
  const fitToContainer = useCallback(() => {
    const container = containerRef.current;
    const sized = imgSizeRef.current
      ?? (imgRef.current
        ? { w: imgRef.current.naturalWidth, h: imgRef.current.naturalHeight }
        : null);
    if (!container || !sized || sized.w === 0 || sized.h === 0) return;
    const r = container.getBoundingClientRect();
    const margin = 60;
    const sx = (r.width - margin) / sized.w;
    const sy = (r.height - margin) / sized.h;
    const next = Math.min(1, Math.min(sx, sy));
    setScale(next);
    setTranslate({ x: 0, y: 0 });
  }, []);

  useEffect(() => {
    if (imgSize) fitToContainer();
  }, [imgSize, fitToContainer]);

  // Wheel zoom centred on the cursor — registered ONCE at mount, reads
  // live scale/translate via refs. Avoids the addEventListener +
  // removeEventListener churn that happened on the previous setup
  // (where `[scale, translate]` were in deps).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const curScale = scaleRef.current;
      const curTx = txRef.current;
      const curTy = tyRef.current;
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      const nextScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, curScale * factor));
      const r = el.getBoundingClientRect();
      const cx = e.clientX - r.left - r.width / 2;
      const cy = e.clientY - r.top - r.height / 2;
      const k = nextScale / curScale;
      setTranslate({
        x: curTx + (1 - k) * (cx - curTx),
        y: curTy + (1 - k) * (cy - curTy),
      });
      setScale(nextScale);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Drag with any mouse button — image viewers conventionally drag with
  // left-click, but middle-mouse still works because we accept all
  // buttons here. Skip if the click started inside the toolbar (or on
  // any other interactive control): without this guard, mousedown on a
  // Fit/Zoom button enters drag mode and the preventDefault swallows
  // the click before it can fire on the button.
  const onMouseDown = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement | null;
    if (target && target.closest(".image-viewer-toolbar")) return;
    e.preventDefault();
    setDragging(true);
    dragStartRef.current = {
      x: e.clientX - translate.x,
      y: e.clientY - translate.y,
    };
  };

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      setTranslate({
        x: e.clientX - dragStartRef.current.x,
        y: e.clientY - dragStartRef.current.y,
      });
    };
    // Drop the `e.button === 1` guard — any mouseup clears dragging.
    // Otherwise a mouseup of a different button (e.g. tracking mouse
    // jitter) leaves dragging stuck on and the cursor "grabbing."
    const onUp = () => setDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  return (
    <div
      ref={containerRef}
      className={`image-viewer${dragging ? " dragging" : ""}`}
      onMouseDown={onMouseDown}
      onDoubleClick={fitToContainer}
    >
      {loadError ? (
        <div className="image-viewer-error">{loadError}</div>
      ) : blobUrl ? (
        <img
          ref={imgRef}
          src={blobUrl}
          alt={alt}
          draggable={false}
          onLoad={(e) => {
            const t = e.currentTarget;
            const next = { w: t.naturalWidth, h: t.naturalHeight };
            imgSizeRef.current = next;
            setImgSize(next);
          }}
          style={{
            transform: `translate(calc(-50% + ${translate.x}px), calc(-50% + ${translate.y}px)) scale(${scale})`,
          }}
        />
      ) : null}
      <div className="image-viewer-toolbar">
        <button
          onClick={() => setScale((s) => Math.max(MIN_SCALE, s / 1.2))}
          title="Zoom out"
          aria-label="Zoom out"
        >
          <ZoomOut size={14} />
        </button>
        <span className="image-viewer-scale">{Math.round(scale * 100)}%</span>
        <button
          onClick={() => setScale((s) => Math.min(MAX_SCALE, s * 1.2))}
          title="Zoom in"
          aria-label="Zoom in"
        >
          <ZoomIn size={14} />
        </button>
        <button onClick={fitToContainer} title="Fit" aria-label="Fit">
          <Maximize2 size={14} />
        </button>
      </div>
    </div>
  );
};

// Memo'd — image viewer only depends on `vaultPath` + `relPath` + `alt`,
// but App.tsx re-renders constantly (sync ticks, ledger updates).
// Without memo the pan/zoom state would survive but reconcile work was
// wasted on every parent update.
export const ImageViewer = React.memo(ImageViewerImpl);
