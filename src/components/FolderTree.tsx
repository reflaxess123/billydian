import React, { useCallback, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ChevronRight,
  Folder,
  FolderOpen,
  FileText,
  FileType2,
  Network,
  File as FileIcon,
  Trash2,
} from "lucide-react";
import { VaultEntry } from "../types";

interface FolderTreeProps {
  entries: VaultEntry[];
  activePath: string | null;
  onOpen: (entry: VaultEntry) => void;
  onDelete: (entry: VaultEntry) => void;
}

// Each row we'll feed into the virtualizer. We flatten the recursive
// vault tree into a 1D list of visible rows (respecting the user's
// expand/collapse state), then ask react-virtual to render only the
// rows inside the viewport. On a 5000-file monorepo that's ~30-50 DOM
// nodes instead of 5000, taking the sidebar from sluggish to instant.
type Row = {
  entry: VaultEntry;
  depth: number;
  isExpandedDir: boolean;
};

const ROW_HEIGHT = 26; // matches the CSS `.tree-row` line-height

// Flatten only the *expanded* subtrees into a 1D list. Unopened folders
// contribute themselves but not their children, so the rendered DOM
// stays bounded by what the user has actually drilled into.
function flatten(
  entries: VaultEntry[],
  expanded: Set<string>,
  depth: number,
  out: Row[],
): void {
  for (const e of entries) {
    if (e.kind === "dir") {
      const isOpen = expanded.has(e.path);
      out.push({ entry: e, depth, isExpandedDir: isOpen });
      if (isOpen && e.children && e.children.length > 0) {
        flatten(e.children, expanded, depth + 1, out);
      }
    } else {
      out.push({ entry: e, depth, isExpandedDir: false });
    }
  }
}

export const FolderTree: React.FC<FolderTreeProps> = ({
  entries,
  activePath,
  onOpen,
  onDelete,
}) => {
  // Expanded set sits in the parent, not in each row, so virtualisation
  // can throw rows away without losing their open/closed state.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  // Stable callbacks for the row renderer — without these the per-row
  // closures would have fresh identity each render, defeating the
  // browser's diff fast-paths for unchanged rows.
  const onOpenRef = useRef(onOpen);
  const onDeleteRef = useRef(onDelete);
  onOpenRef.current = onOpen;
  onDeleteRef.current = onDelete;

  const handleRowClick = useCallback((row: Row) => {
    const e = row.entry;
    if (e.kind === "dir") {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(e.path)) next.delete(e.path);
        else next.add(e.path);
        return next;
      });
    } else {
      onOpenRef.current(e);
    }
  }, []);

  const handleRowDelete = useCallback((e: VaultEntry) => {
    onDeleteRef.current(e);
  }, []);

  const rows = useMemo(() => {
    const out: Row[] = [];
    flatten(entries, expanded, 0, out);
    return out;
  }, [entries, expanded]);

  const parentRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    // Stable keys mean react-virtual reuses the same DOM nodes across
    // expands/collapses, keeping the GPU's compositor layers warm.
    getItemKey: (i) => rows[i].entry.path,
  });

  const items = virtualizer.getVirtualItems();

  return (
    <div ref={parentRef} className="vault-tree-scroll">
      <div
        className="vault-tree-inner"
        style={{ height: virtualizer.getTotalSize(), position: "relative" }}
      >
        {items.map((vItem) => {
          const row = rows[vItem.index];
          return (
            <VirtualRow
              key={vItem.key}
              row={row}
              translateY={vItem.start}
              activePath={activePath}
              onClick={handleRowClick}
              onDelete={handleRowDelete}
            />
          );
        })}
      </div>
    </div>
  );
};

interface VirtualRowProps {
  row: Row;
  translateY: number;
  activePath: string | null;
  onClick: (row: Row) => void;
  onDelete: (e: VaultEntry) => void;
}

const VirtualRowImpl: React.FC<VirtualRowProps> = ({
  row,
  translateY,
  activePath,
  onClick,
  onDelete,
}) => {
  const { entry, depth, isExpandedDir } = row;
  const isActive = activePath === entry.path && entry.kind !== "dir";

  // Monochrome icons — colour comes from the compact row label state,
  // not the icon itself, so the sidebar stays calm.
  const icon = (() => {
    if (entry.kind === "dir") {
      return isExpandedDir ? <FolderOpen size={14} /> : <Folder size={14} />;
    }
    if (entry.kind === "md") return <FileText size={14} />;
    if (entry.kind === "mindmap") return <Network size={14} />;
    if (entry.kind === "docx") return <FileType2 size={14} />;
    return <FileIcon size={14} />;
  })();

  return (
    <div
      className={`tree-row${entry.kind !== "dir" ? " tree-row--file" : ""}${
        isActive ? " active" : ""
      }${
        entry.name.startsWith(".") ? " dotted" : ""
      }`}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        transform: `translateY(${translateY}px)`,
        height: ROW_HEIGHT,
        paddingLeft: 8 + depth * 14,
      }}
      onClick={() => onClick(row)}
    >
      {entry.kind === "dir" && (
        <ChevronRight
          size={12}
          className={`tree-chev${isExpandedDir ? " open" : ""}`}
        />
      )}
      {entry.kind !== "dir" && <span className="tree-chev-spacer" />}
      <span className="tree-entry-pill">
        <span className="tree-icon">{icon}</span>
        <span className="tree-name">{entry.name}</span>
      </span>
      {entry.kind !== "dir" && (
        <button
          className="tree-delete"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(entry);
          }}
          title="Delete"
          aria-label="Delete"
        >
          <Trash2 size={11} />
        </button>
      )}
    </div>
  );
};

// Custom comparator: only re-render when the row's own properties change.
// activePath flips one row at a time, so each row should re-render only
// when its own active state toggles — the rest stay still.
const VirtualRow = React.memo(VirtualRowImpl, (prev, next) => {
  if (prev.row !== next.row) return false;
  if (prev.translateY !== next.translateY) return false;
  if (prev.onClick !== next.onClick) return false;
  if (prev.onDelete !== next.onDelete) return false;
  const wasActive =
    prev.activePath === prev.row.entry.path && prev.row.entry.kind !== "dir";
  const isActive =
    next.activePath === next.row.entry.path && next.row.entry.kind !== "dir";
  return wasActive === isActive;
});
