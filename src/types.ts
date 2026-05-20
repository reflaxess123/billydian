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
// `modified` used to live here but the UI never read it, and fetching
// mtime per file is a full stat syscall — dropping it halved tree load
// time on large monorepos.
export interface VaultEntry {
  path: string;        // vault-relative, "/"-separated
  name: string;
  kind: "dir" | "md" | "mindmap" | "image" | "docx" | "other";
  children?: VaultEntry[] | null;
}

// Currently open document.
// `image` carries only the relPath — `ImageViewer` reads the bytes via
// the binary IPC channel and owns the blob URL lifecycle. Avoids pinning
// a 5-20MB base64 string in React state for every opened picture.
// `docx` is the same shape — `DocxViewer` reads + converts on its own
// and the heavy mammoth/turndown libs are dynamically imported when a
// `.docx` is opened, so they never appear in the initial bundle.
export type OpenDoc =
  | null
  | { kind: "md"; relPath: string; content: string }
  | { kind: "mindmap"; relPath: string; tree: MindMapNodeData }
  | { kind: "image"; relPath: string }
  | { kind: "docx"; relPath: string };

// Device-local secrets — stored in the OS app config dir (Windows:
// AppData\Roaming\Billydian\secrets.json), never inside the vault.
// `read_secrets` / `write_secrets` are the IPC bridges.
export interface DeviceSecrets {
  apiKey: string;
  s3: S3Settings;
}

export const EMPTY_SECRETS: DeviceSecrets = {
  apiKey: "",
  s3: {
    endpoint: "",
    region: "",
    accessKeyId: "",
    secretAccessKey: "",
    bucket: "",
    prefix: "",
  },
};
