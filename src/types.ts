// Mind-map tree node — persisted as the body of a .mindmap file.
export interface MindMapNodeData {
  id: string;
  name: string;
  children: MindMapNodeData[];
  description?: string;
  isCollapsed?: boolean;
}

export type Theme = "light" | "dark";

// S3 sync settings. Implementation lands in a follow-up phase — the
// fields are persisted and rendered in the modal already so the user
// can fill them in early.
export interface S3Settings {
  endpoint: string;       // e.g. "https://s3.amazonaws.com" or MinIO URL
  region: string;         // e.g. "us-east-1"
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  prefix?: string;        // optional path prefix inside the bucket
}

export type NoteViewMode = "edit" | "view";

export interface AppSettings {
  apiKey: string;
  model: string;
  theme: Theme;
  s3: S3Settings;
  /** Edit vs preview-only mode in the note view. */
  noteMode: NoteViewMode;
  /** Whole-UI zoom factor (1.0 = native). Applied via CSS `zoom`. */
  uiScale: number;
  /** Width (px) of the note card column — title, body, and footer all share. */
  noteWidth: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  apiKey: "",
  model: "google/gemini-2.5-flash",
  theme: "dark",
  s3: {
    endpoint: "",
    region: "",
    accessKeyId: "",
    secretAccessKey: "",
    bucket: "",
    prefix: "",
  },
  noteMode: "view",
  uiScale: 1.0,
  noteWidth: 760,
};

// Token usage tracking. Stored in <vault>/.billydian/tokens.json:
//   { "all": TokenStats, "byFile": { [relPath]: TokenStats } }
// The all-time counter only grows; per-file counters are wiped when
// the file is deleted.
export interface TokenStats {
  prompt: number;
  completion: number;
  total: number;
}

export interface TokenLedger {
  byFile: Record<string, TokenStats>;
}

export const EMPTY_TOKENS: TokenStats = { prompt: 0, completion: 0, total: 0 };

export const EMPTY_LEDGER: TokenLedger = { byFile: {} };

// Recursive folder tree returned from the backend.
export interface VaultEntry {
  path: string;        // vault-relative, "/"-separated
  name: string;
  kind: "dir" | "md" | "mindmap" | "other";
  children?: VaultEntry[] | null;
  modified?: number | null;
}

// Currently open document.
export type OpenDoc =
  | null
  | { kind: "md"; relPath: string; content: string }
  | { kind: "mindmap"; relPath: string; tree: MindMapNodeData };
