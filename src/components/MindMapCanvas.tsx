import React, { useState, useRef, useEffect, useMemo } from "react";
import * as d3 from "d3-hierarchy";
import { MindMapNodeData, TokenStats } from "../types";
import { MindMapNode } from "./MindMapNode";
// no toolbar — pan via middle-mouse, zoom via wheel

interface MindMapCanvasProps {
  data: MindMapNodeData;
  onToggleCollapse: (id: string) => void;
  onEdit: (id: string, newName: string) => void;
  onDelete: (id: string) => void;
  onAddChild: (id: string) => void;
  onAiExpand: (id: string) => void;
  generatingNodeId: string | null;
  /** Per-file token spend; null if this map never used the AI. */
  fileTokens?: TokenStats | null;
}

const MindMapCanvasImpl: React.FC<MindMapCanvasProps> = ({
  data,
  onToggleCollapse,
  onEdit,
  onDelete,
  onAddChild,
  onAiExpand,
  generatingNodeId,
  fileTokens,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef({ x: 0, y: 0 });

  const [scale, setScale] = useState(1);
  const [translateX, setTranslateX] = useState(250);
  const [translateY, setTranslateY] = useState(300);
  const [isDragging, setIsDragging] = useState(false);

  // Mirror the latest scale/translate into refs so the wheel handler
  // can read fresh values without us having to re-bind the listener on
  // every zoom step. The old setup kept `[scale, translateX, translateY]`
  // in the effect deps → addEventListener + removeEventListener fired
  // for every wheel tick (10-60 times per gesture), churning React +
  // DOM bookkeeping for no reason.
  const scaleRef = useRef(scale);
  const txRef = useRef(translateX);
  const tyRef = useRef(translateY);
  useEffect(() => {
    scaleRef.current = scale;
  }, [scale]);
  useEffect(() => {
    txRef.current = translateX;
  }, [translateX]);
  useEffect(() => {
    tyRef.current = translateY;
  }, [translateY]);

  // Set initial coordinates centered in the workspace
  useEffect(() => {
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      setTranslateX(150); // Margin on the left
      setTranslateY(rect.height / 2 - 30); // Centered vertically
    }
  }, []);

  // Wheel zoom — registered ONCE at mount, reads live state via refs.
  // `{ passive: false }` is required to call preventDefault inside.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const curScale = scaleRef.current;
      const curTx = txRef.current;
      const curTy = tyRef.current;

      const zoomIntensity = 0.08;
      const scaleFactor = e.deltaY < 0 ? 1 + zoomIntensity : 1 - zoomIntensity;
      const newScale = Math.min(Math.max(curScale * scaleFactor, 0.15), 3.0);

      const rect = container.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      // Translate canvas so the mouse point stays fixed.
      const contentX = (mouseX - curTx) / curScale;
      const contentY = (mouseY - curTy) / curScale;

      setScale(newScale);
      setTranslateX(mouseX - contentX * newScale);
      setTranslateY(mouseY - contentY * newScale);
    };

    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      container.removeEventListener("wheel", handleWheel);
    };
  }, []);

  // Mouse drag-to-pan using the Middle Mouse Button (wheel click, e.button === 1).
  // Drag does NOT go through React state — every mouse-move at 60-120 Hz
  // would otherwise re-render the whole canvas (and reconcile 500 nodes).
  // Instead: write the new transform directly to canvasRef via rAF, then
  // commit a single setState on mouseup so wheel-zoom etc. still see
  // fresh values via the live `tx/tyRef`s.
  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button === 1) {
      e.preventDefault();
      setIsDragging(true);
      dragStart.current = { x: e.clientX - txRef.current, y: e.clientY - tyRef.current };
      if (containerRef.current) {
        containerRef.current.style.cursor = "grabbing";
      }
    }
  };

  useEffect(() => {
    if (!isDragging) return;
    let raf = 0;
    let pendingX = txRef.current;
    let pendingY = tyRef.current;

    const apply = () => {
      raf = 0;
      txRef.current = pendingX;
      tyRef.current = pendingY;
      const el = canvasRef.current;
      if (el) {
        el.style.transform = `translate(${pendingX}px, ${pendingY}px) scale(${scaleRef.current})`;
      }
    };

    const onMove = (e: MouseEvent) => {
      pendingX = e.clientX - dragStart.current.x;
      pendingY = e.clientY - dragStart.current.y;
      if (raf === 0) raf = requestAnimationFrame(apply);
    };

    const onUp = (e: MouseEvent) => {
      if (e.button !== 1) return;
      if (raf) cancelAnimationFrame(raf);
      // Single commit so React state and refs end up in sync — JSX
      // re-renders triggered by unrelated data changes won't snap the
      // canvas back to a stale position.
      setTranslateX(pendingX);
      setTranslateY(pendingY);
      setIsDragging(false);
      if (containerRef.current) containerRef.current.style.cursor = "default";
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [isDragging]);

  // Compute Left-to-Right tree layout using d3-hierarchy.
  // Memoized so React can diff stable [x,y] pairs and the CSS `left/top`
  // transitions actually fire instead of replacing the layout every render.
  const { nodes, links } = useMemo(() => {
    const root = d3.hierarchy<MindMapNodeData>(data, (d) =>
      d.isCollapsed ? [] : d.children,
    );
    // nodeSize: [vertical spacing, horizontal spacing]
    // Cards are 184×~46. 96px vertical / 300px horizontal gives the
    // canvas air to breathe even with three siblings.
    const treeLayout = d3.tree<MindMapNodeData>().nodeSize([96, 300]);
    const pointRoot = treeLayout(root) as d3.HierarchyPointNode<MindMapNodeData>;
    return {
      nodes: pointRoot.descendants(),
      links: pointRoot.links(),
    };
  }, [data]);

  // ── Exit animation for nodes that vanished from the layout ────────────
  // d3 simply omits collapsed descendants, but we want them to fade out
  // instead of snapping. We snapshot the previous render's nodes, diff IDs
  // against the current set, and keep the missing ones around for 320ms
  // with an `exiting` class so the CSS can animate them out.
  type ExitingNode = {
    id: string;
    x: number;
    y: number;
    depth: number;
    data: MindMapNodeData;
  };
  const prevNodesRef = useRef<Map<string, ExitingNode>>(new Map());
  const [exitingNodes, setExitingNodes] = useState<ExitingNode[]>([]);

  // File-switch reset: this canvas is mounted at the same JSX position
  // whether we're viewing map A, B, or C. The `data` prop swaps but the
  // component instance — and `prevNodesRef.current` along with it —
  // survives. Without this reset, opening B after A would briefly paint
  // any A-ids that don't exist in B as "exiting ghosts" on first frame.
  // Keyed on the root id which is stable per file.
  useEffect(() => {
    prevNodesRef.current = new Map();
    setExitingNodes([]);
  }, [data.id]);

  useEffect(() => {
    // Single-pass diff: walk the new `nodes` building the next snapshot,
    // and mark each id as "kept" in the previous map. Anything still
    // unmarked when we're done is stale (its ancestor just collapsed
    // or the node was deleted) → schedule it for the exit animation.
    const prev = prevNodesRef.current;
    const kept = new Set<string>();
    const nextMap = new Map<string, ExitingNode>();
    for (const n of nodes) {
      const id = n.data.id;
      kept.add(id);
      nextMap.set(id, { id, x: n.x, y: n.y, depth: n.depth, data: n.data });
    }
    const stale: ExitingNode[] = [];
    prev.forEach((p, id) => {
      if (!kept.has(id)) stale.push(p);
    });
    prevNodesRef.current = nextMap;

    if (stale.length === 0) {
      if (exitingNodes.length > 0) setExitingNodes([]);
      return;
    }
    setExitingNodes(stale);
    const t = setTimeout(() => setExitingNodes([]), 320);
    return () => clearTimeout(t);
    // We intentionally exclude exitingNodes from deps so we don't loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes]);

  // Single accent color for every link; opacity declines with depth so
  // the root → first-level branches read as strongest and the leaves
  // fade out. Black-on-black bug came from a stale CSS variable
  // (--accent-root etc.) that no longer exists in the new token set.
  const getDepthOpacity = (depth: number) => {
    if (depth === 0) return 0.95;
    if (depth === 1) return 0.75;
    if (depth === 2) return 0.55;
    return 0.4;
  };

  // Memoise the entire SVG path array so unrelated re-renders (drag
  // commit, exit-animation tick, fileTokens swap, isDragging cursor
  // change) skip the 500-link bezier-string allocation pass entirely.
  // Only rebuilds when the d3 layout output (`links`) actually changes.
  const linkElements = useMemo(() => {
    const cardWidth = 184; // matches .mindmap-node width
    return links.map((link) => {
      const source = link.source;
      const target = link.target;
      const sourceId = source.data.id;
      const targetId = target.data.id;
      const startX = source.y + cardWidth;
      const startY = source.x;
      const endX = target.y;
      const endY = target.x;
      const cpX = startX + (endX - startX) / 2;
      const pathData = `M ${startX} ${startY} C ${cpX} ${startY}, ${cpX} ${endY}, ${endX} ${endY}`;
      return (
        <path
          key={`link-${sourceId}-${targetId}`}
          d={pathData}
          fill="none"
          stroke="var(--accent)"
          strokeOpacity={getDepthOpacity(target.depth)}
          strokeWidth={2}
          strokeLinecap="round"
          className="link-path"
        />
      );
    });
  }, [links]);

  return (
    <div
      ref={containerRef}
      className="canvas-container"
      onMouseDown={handleMouseDown}
    >
      {/* Drawing Space with Zoom and Translate transforms */}
      <div
        ref={canvasRef}
        className="canvas-transform-layer"
        style={{
          transform: `translate(${translateX}px, ${translateY}px) scale(${scale})`,
          transformOrigin: "0 0",
        }}
      >
        {/* SVG Links Container */}
        <svg className="mindmap-svg" style={{ overflow: "visible" }}>
          {linkElements}
        </svg>

        {/* Nodes Container */}
        <div className="nodes-container" style={{ position: "absolute", top: 0, left: 0 }}>
          {nodes.map((node) => (
            <MindMapNode
              key={node.data.id}
              node={node}
              onToggleCollapse={onToggleCollapse}
              onEdit={onEdit}
              onDelete={onDelete}
              onAddChild={onAddChild}
              onAiExpand={onAiExpand}
              generatingNodeId={generatingNodeId}
            />
          ))}
          {/* Ghost copies of nodes whose ancestor just collapsed.
              They fade out for ~320ms. Same transform-based positioning
              as the live nodes so they stay anchored. */}
          {exitingNodes.map((node) => (
            <div
              key={`exit-${node.id}`}
              className={`mindmap-node exiting ${
                node.depth === 0
                  ? "glow-root"
                  : node.depth === 1
                  ? "glow-depth-1"
                  : node.depth === 2
                  ? "glow-depth-2"
                  : "glow-depth-3"
              }`}
              style={{
                transform: `translate3d(${node.y}px, ${node.x}px, 0) translateY(-50%)`,
              }}
            >
              <div className="node-body">
                <div className="node-text-container">
                  <span className="node-text">{node.data.name}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Tiny floating token readout — visible only when this map has
          consumed AI calls. Bottom-right, doesn't compete with content. */}
      {fileTokens && fileTokens.total > 0 && (
        <div className="canvas-tokens" title="Tokens spent on this mind map">
          <span className="ct-pair">
            <span className="ct-key">in</span>
            <span className="ct-val">{fileTokens.prompt.toLocaleString()}</span>
          </span>
          <span className="ct-pair">
            <span className="ct-key">out</span>
            <span className="ct-val">{fileTokens.completion.toLocaleString()}</span>
          </span>
          <span className="ct-pair total">
            <span className="ct-key">all</span>
            <span className="ct-val">{fileTokens.total.toLocaleString()}</span>
          </span>
        </div>
      )}
    </div>
  );
};

// Memoised: the canvas + its d3 layout only need to recompute when
// `data` changes. All other props are stable callbacks from App.tsx
// (already wrapped in useCallback), so default shallow-equal is enough.
export const MindMapCanvas = React.memo(MindMapCanvasImpl);
