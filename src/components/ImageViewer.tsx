import React, { useEffect, useRef, useState } from "react";
import { ZoomIn, ZoomOut, Maximize2 } from "lucide-react";

interface ImageViewerProps {
  /** data: URL (`data:image/...;base64,...`) produced by App.tsx. */
  src: string;
  /** Basename of the file — used for the alt-text and download fallback. */
  alt: string;
}

const MIN_SCALE = 0.05;
const MAX_SCALE = 16;

export const ImageViewer: React.FC<ImageViewerProps> = ({ src, alt }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  // Natural image dimensions, captured once the picture has loaded so
  // we can compute the initial "fit" scale.
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);

  // Reset state when a new image is opened — without this, switching
  // between files would keep the previous pan/zoom.
  useEffect(() => {
    setScale(1);
    setTranslate({ x: 0, y: 0 });
    setImgSize(null);
  }, [src]);

  // Once the natural size is known, fit the image into the container so
  // huge pictures don't open at 100% off-screen.
  const fitToContainer = () => {
    if (!containerRef.current || !imgSize) return;
    const r = containerRef.current.getBoundingClientRect();
    const margin = 60;
    const sx = (r.width - margin) / imgSize.w;
    const sy = (r.height - margin) / imgSize.h;
    const next = Math.min(1, Math.min(sx, sy));
    setScale(next);
    setTranslate({ x: 0, y: 0 });
  };

  useEffect(() => {
    if (imgSize) fitToContainer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imgSize]);

  // Mouse wheel zoom centred on the cursor — same idiom as the
  // mind-map canvas, just operating on one image instead of a tree.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      const nextScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale * factor));
      // Keep the world-space point under the cursor fixed.
      const r = el.getBoundingClientRect();
      const cx = e.clientX - r.left - r.width / 2;
      const cy = e.clientY - r.top - r.height / 2;
      const k = nextScale / scale;
      setTranslate({
        x: translate.x + (1 - k) * (cx - translate.x),
        y: translate.y + (1 - k) * (cy - translate.y),
      });
      setScale(nextScale);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [scale, translate]);

  // Drag with any mouse button — image viewers conventionally drag with
  // left-click, but middle-mouse still works because we accept all
  // buttons here.
  const onMouseDown = (e: React.MouseEvent) => {
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
      <img
        src={src}
        alt={alt}
        draggable={false}
        onLoad={(e) => {
          const t = e.currentTarget;
          setImgSize({ w: t.naturalWidth, h: t.naturalHeight });
        }}
        style={{
          transform: `translate(calc(-50% + ${translate.x}px), calc(-50% + ${translate.y}px)) scale(${scale})`,
        }}
      />
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
