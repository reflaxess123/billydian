import { useCallback } from "react";
import { produce } from "immer";
import { toast } from "../lib/toast";
import { MindMapNodeData, OpenDoc } from "../types";

export interface UseMindmapOps {
  handleToggleCollapse: (id: string) => void;
  handleEditNode: (id: string, newName: string) => void;
  handleDeleteNode: (id: string) => void;
  handleAddChildNode: (parentId: string) => void;
}

interface UseMindmapOpsArgs {
  openDoc: OpenDoc;
  setOpenDoc: React.Dispatch<React.SetStateAction<OpenDoc>>;
  /** Funneled through the write queue so rapid edits don't write the
   *  (50–100KB) serialized tree on every tick. */
  queueWrite: (relPath: string, content: string) => void;
}

// Tree mutations go through immer's `produce`: instead of full
// JSON.parse(JSON.stringify) — ~5-10ms on an 80KB tree — immer
// structurally shares unchanged subtrees and only allocates the
// ancestors of the mutated node. For a 500-node mindmap that's ~10x
// faster per edit and a fraction of the GC pressure.
export function useMindmapOps({
  openDoc, setOpenDoc, queueWrite,
}: UseMindmapOpsArgs): UseMindmapOps {
  const mutateMindmap = useCallback((mutate: (root: MindMapNodeData) => void) => {
    if (!openDoc || openDoc.kind !== "mindmap") return;
    const updated = produce(openDoc.tree, mutate);
    setOpenDoc({ ...openDoc, tree: updated });
    queueWrite(openDoc.relPath, JSON.stringify(updated, null, 2));
  }, [openDoc, queueWrite, setOpenDoc]);

  const handleToggleCollapse = useCallback((id: string) => {
    mutateMindmap((root) => {
      const visit = (n: MindMapNodeData): boolean => {
        if (n.id === id) {
          n.isCollapsed = !n.isCollapsed;
          return true;
        }
        return !!n.children?.some(visit);
      };
      visit(root);
    });
  }, [mutateMindmap]);

  const handleEditNode = useCallback((id: string, newName: string) => {
    mutateMindmap((root) => {
      const visit = (n: MindMapNodeData): boolean => {
        if (n.id === id) {
          n.name = newName;
          return true;
        }
        return !!n.children?.some(visit);
      };
      visit(root);
    });
  }, [mutateMindmap]);

  const handleDeleteNode = useCallback((id: string) => {
    if (!openDoc || openDoc.kind !== "mindmap") return;
    if (openDoc.tree.id === id) {
      toast.error("Root node cannot be deleted.");
      return;
    }
    mutateMindmap((root) => {
      const visit = (n: MindMapNodeData): boolean => {
        if (!n.children) return false;
        const idx = n.children.findIndex((c) => c.id === id);
        if (idx !== -1) {
          n.children.splice(idx, 1);
          return true;
        }
        return n.children.some(visit);
      };
      visit(root);
    });
  }, [openDoc, mutateMindmap]);

  const handleAddChildNode = useCallback((parentId: string) => {
    mutateMindmap((root) => {
      const newId = `node-${Date.now()}`;
      const visit = (n: MindMapNodeData): boolean => {
        if (n.id === parentId) {
          if (!n.children) n.children = [];
          n.children.push({
            id: newId,
            name: "New Subtopic",
            children: [],
            isCollapsed: false,
          });
          n.isCollapsed = false;
          return true;
        }
        return !!n.children?.some(visit);
      };
      visit(root);
    });
  }, [mutateMindmap]);

  return { handleToggleCollapse, handleEditNode, handleDeleteNode, handleAddChildNode };
}
