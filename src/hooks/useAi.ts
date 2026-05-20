import { useCallback, useState } from "react";
import { produce } from "immer";
import {
  aiExtendNode,
  aiGenerateMindmap,
  aiGenerateNote,
  aiGenerateTitle,
  renameVaultFile,
  writeVaultFile,
  GenResponse,
} from "../api/tauri";
import { toast } from "../lib/toast";
import { MindMapNodeData, OpenDoc, TokenLedger, TokenStats } from "../types";
import { sanitizeFileName, TakenIndex, uniqueName } from "../lib/names";
import { useRaceGuard } from "./useRaceGuard";

// Some error strings (OpenRouter, "Failed to ...") are already
// user-readable; pass them through untouched. Everything else gets a
// generic "Foo failed: …" prefix.
function surfaceError(raw: string, fallback: string) {
  toast.error(
    raw.startsWith("OpenRouter") || raw.startsWith("Failed to")
      ? raw
      : `${fallback}: ${raw || "Unknown error"}`,
  );
}

export interface UseAi {
  isGenerating: boolean;
  generatingNodeId: string | null;
  titleBusy: boolean;
  handleGenerate: (kind: "note" | "mindmap", topic: string) => Promise<void>;
  handleAiExpandNode: (nodeId: string) => Promise<void>;
  handleGenerateTitle: (currentContent: string) => Promise<void>;
}

interface UseAiArgs {
  vaultPath: string | null;
  apiKey: string;
  model: string;
  openDoc: OpenDoc;
  setOpenDoc: React.Dispatch<React.SetStateAction<OpenDoc>>;
  takenRef: React.MutableRefObject<TakenIndex>;
  refreshTree: (vault: string) => Promise<void>;
  flushPendingWrites: (relPath?: string) => Promise<void>;
  addTokens: (relPath: string, delta: TokenStats) => void;
  ledgerRef: React.MutableRefObject<TokenLedger>;
  setLedger: React.Dispatch<React.SetStateAction<TokenLedger>>;
  markLedgerDirty: () => void;
}

export function useAi(args: UseAiArgs): UseAi {
  const {
    vaultPath, apiKey, model, openDoc, setOpenDoc, takenRef,
    refreshTree, flushPendingWrites, addTokens, ledgerRef, setLedger,
    markLedgerDirty,
  } = args;

  const [isGenerating, setIsGenerating] = useState(false);
  const [generatingNodeId, setGeneratingNodeId] = useState<string | null>(null);
  const [titleBusy, setTitleBusy] = useState(false);
  // Race guard: every AI call takes a token, and on settle we verify
  // ours is still the latest. A rapid double-click on Generate won't
  // let the slow first response overwrite the fresh second one (or
  // double-charge the token ledger).
  const inFlight = useRaceGuard();

  const handleGenerate = useCallback(async (kind: "note" | "mindmap", topic: string) => {
    if (!vaultPath) {
      toast.error("Pick a vault folder first.");
      return;
    }
    const key = apiKey.trim();
    if (!key) {
      toast.error("Set your OpenRouter API key in Settings first.");
      return;
    }
    const myGen = inFlight.take();
    setIsGenerating(true);
    try {
      const responseStr = kind === "mindmap"
        ? await aiGenerateMindmap(key, topic, model)
        : await aiGenerateNote(key, topic, model);
      if (!inFlight.isCurrent(myGen)) return;
      const r: GenResponse = JSON.parse(responseStr);

      const safe = sanitizeFileName(topic);
      const ext = kind === "mindmap" ? "mindmap" : "md";
      const name = uniqueName(safe, ext, takenRef.current.names);

      await writeVaultFile(vaultPath, name, r.data);
      if (!inFlight.isCurrent(myGen)) return;
      if (kind === "mindmap") {
        const tree: MindMapNodeData = JSON.parse(r.data);
        setOpenDoc({ kind: "mindmap", relPath: name, tree });
      } else {
        setOpenDoc({ kind: "md", relPath: name, content: r.data });
      }

      addTokens(name, {
        prompt: r.prompt_tokens,
        completion: r.completion_tokens,
        total: r.total_tokens,
      });
      await refreshTree(vaultPath);
    } catch (err: any) {
      if (inFlight.isCurrent(myGen)) {
        surfaceError(String(err?.message || err || ""), "Generation failed");
      }
    } finally {
      if (inFlight.isCurrent(myGen)) setIsGenerating(false);
    }
  }, [vaultPath, apiKey, model, addTokens, refreshTree, takenRef, setOpenDoc]);

  const handleAiExpandNode = useCallback(async (nodeId: string) => {
    if (!openDoc || openDoc.kind !== "mindmap" || !vaultPath) return;
    const key = apiKey.trim();
    if (!key) {
      toast.error("Set your OpenRouter API key in Settings first.");
      return;
    }
    const myGen = inFlight.take();
    setGeneratingNodeId(nodeId);

    // Walk current (immutable) tree once to grab the target's name.
    let targetName = "";
    const find = (n: MindMapNodeData): boolean => {
      if (n.id === nodeId) {
        targetName = n.name;
        return true;
      }
      return !!n.children?.some(find);
    };
    find(openDoc.tree);
    if (!targetName) {
      toast.error("Target node not found.");
      setGeneratingNodeId(null);
      return;
    }

    try {
      const responseStr = await aiExtendNode(key, openDoc.tree.name, targetName, model);
      if (!inFlight.isCurrent(myGen)) return;
      const r: GenResponse = JSON.parse(responseStr);
      const newChildren: MindMapNodeData[] = JSON.parse(r.data);

      // Structural-share clone via immer — only the path from root to
      // the target node allocates; everything else is reused.
      const updated = produce(openDoc.tree, (draft) => {
        const append = (n: MindMapNodeData): boolean => {
          if (n.id === nodeId) {
            if (!n.children) n.children = [];
            const taken = new Set(n.children.map((c) => c.id));
            for (const c of newChildren) {
              if (taken.has(c.id)) {
                c.id = `node-${Math.random().toString(36).slice(2, 11)}`;
              }
              n.children.push(c);
            }
            n.isCollapsed = false;
            return true;
          }
          return !!n.children?.some(append);
        };
        append(draft);
      });
      setOpenDoc({ ...openDoc, tree: updated });
      // Immediate write (not queued) so the next refreshTree picks up
      // the new file content without a race on the debounce timer.
      try {
        await writeVaultFile(vaultPath, openDoc.relPath, JSON.stringify(updated, null, 2));
      } catch (e: any) {
        if (inFlight.isCurrent(myGen)) {
          toast.error(`Failed to save mind map: ${e?.message || e}`);
        }
      }
      if (!inFlight.isCurrent(myGen)) return;
      addTokens(openDoc.relPath, {
        prompt: r.prompt_tokens,
        completion: r.completion_tokens,
        total: r.total_tokens,
      });
    } catch (err: any) {
      if (inFlight.isCurrent(myGen)) {
        surfaceError(String(err?.message || err || ""), "AI expansion failed");
      }
    } finally {
      if (inFlight.isCurrent(myGen)) setGeneratingNodeId(null);
    }
  }, [openDoc, apiKey, model, vaultPath, addTokens, setOpenDoc]);

  const handleGenerateTitle = useCallback(async (currentContent: string) => {
    if (!openDoc || openDoc.kind !== "md" || !vaultPath) return;
    const key = apiKey.trim();
    if (!key) {
      toast.error("Set your OpenRouter API key in Settings first.");
      return;
    }
    if (!currentContent.trim()) {
      toast.error("Note is empty — nothing to title.");
      return;
    }
    const myGen = inFlight.take();
    setTitleBusy(true);
    try {
      const responseStr = await aiGenerateTitle(key, currentContent, model);
      if (!inFlight.isCurrent(myGen)) return;
      const r: GenResponse = JSON.parse(responseStr);
      const rawTitle = r.data.trim();
      const safe = sanitizeFileName(rawTitle);
      if (!safe || safe === "untitled") {
        toast.error("AI returned an unusable title.");
        return;
      }

      // Resolve target filename in the same folder as the current note.
      const slash = openDoc.relPath.lastIndexOf("/");
      const dirPart = slash >= 0 ? openDoc.relPath.slice(0, slash + 1) : "";
      let candidate = `${dirPart}${safe}.md`;
      let n = 2;
      while (candidate !== openDoc.relPath && takenRef.current.paths.has(candidate)) {
        candidate = `${dirPart}${safe} ${n}.md`;
        n++;
      }
      if (candidate !== openDoc.relPath) {
        // Flush any pending buffered content on the current path so the
        // rename actually moves the user's latest keystrokes, not a
        // stale snapshot from before the title generation request.
        await flushPendingWrites(openDoc.relPath);
        await renameVaultFile(vaultPath, openDoc.relPath, candidate);
        if (!inFlight.isCurrent(myGen)) return;
        if (ledgerRef.current.byFile[openDoc.relPath]) {
          markLedgerDirty();
          setLedger((prev) => {
            const { [openDoc.relPath]: stat, ...rest } = prev.byFile;
            return { ...prev, byFile: { ...rest, [candidate]: stat } };
          });
        }
        setOpenDoc({ ...openDoc, relPath: candidate });
        await refreshTree(vaultPath);
      }

      // Account tokens against the (possibly new) path
      addTokens(candidate, {
        prompt: r.prompt_tokens,
        completion: r.completion_tokens,
        total: r.total_tokens,
      });
    } catch (err: any) {
      if (inFlight.isCurrent(myGen)) {
        surfaceError(String(err?.message || err || ""), "Title generation failed");
      }
    } finally {
      if (inFlight.isCurrent(myGen)) setTitleBusy(false);
    }
  }, [
    openDoc, vaultPath, apiKey, model, refreshTree, flushPendingWrites,
    takenRef, addTokens, ledgerRef, setLedger, markLedgerDirty, setOpenDoc,
  ]);

  return {
    isGenerating, generatingNodeId, titleBusy,
    handleGenerate, handleAiExpandNode, handleGenerateTitle,
  };
}
