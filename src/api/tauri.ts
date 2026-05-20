// One module for every Tauri `invoke` call. Centralising them does
// three things:
//   1. Each command appears exactly once with its expected payload
//      shape — easier to keep aligned with the Rust side.
//   2. Callers get typed Promises without each one writing
//      `invoke<string>("...", { ... })` and remembering the keys.
//   3. If we ever swap Tauri for something else (web wrapper, mock for
//      tests), it's one file to rewrite.
import { invoke } from "@tauri-apps/api/core";
import type { S3Settings, SyncReport, VaultEntry } from "../types";

export interface GenResponse {
  data: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface KnownVaultsResponse {
  vaults: string[];
  active: string | null;
}

// ─── Vault pointer / known vaults ────────────────────────────────────
export const setVaultPath = (path: string) =>
  invoke<void>("set_vault_path", { path });

export const getKnownVaults = () =>
  invoke<KnownVaultsResponse>("get_known_vaults");

export const removeVaultIPC = (path: string) =>
  invoke<KnownVaultsResponse>("remove_vault", { path });

// ─── Vault file ops ──────────────────────────────────────────────────
export const listVaultTree = (vault: string) =>
  invoke<VaultEntry[]>("list_vault_tree", { vault });

export const readVaultFile = (vault: string, rel: string) =>
  invoke<string>("read_vault_file", { vault, rel });

export const writeVaultFile = (vault: string, rel: string, content: string) =>
  invoke<void>("write_vault_file", { vault, rel, content });

export const deleteVaultFile = (vault: string, rel: string) =>
  invoke<void>("delete_vault_file", { vault, rel });

export const renameVaultFile = (vault: string, from: string, to: string) =>
  invoke<void>("rename_vault_file", { vault, from, to });

/** Read; returns null if the file doesn't exist. Used for optional
 *  config files where missing == "use defaults". */
export async function readOptional(
  vault: string,
  rel: string,
): Promise<string | null> {
  try {
    return await readVaultFile(vault, rel);
  } catch {
    return null;
  }
}

// ─── Device-local secrets (live outside vault) ──────────────────────
export const readSecrets = () => invoke<string>("read_secrets");
export const writeSecrets = (content: string) =>
  invoke<void>("write_secrets", { content });

// ─── OpenRouter AI calls ────────────────────────────────────────────
export const aiGenerateMindmap = (apiKey: string, topic: string, model: string) =>
  invoke<string>("generate_mindmap", { apiKey, topic, model });

export const aiGenerateNote = (apiKey: string, topic: string, model: string) =>
  invoke<string>("generate_note", { apiKey, topic, model });

export const aiGenerateTitle = (apiKey: string, content: string, model: string) =>
  invoke<string>("generate_title", { apiKey, content, model });

export const aiExtendNode = (
  apiKey: string,
  topicContext: string,
  nodeLabel: string,
  model: string,
) =>
  invoke<string>("extend_node", { apiKey, topicContext, nodeLabel, model });

// ─── S3 sync ────────────────────────────────────────────────────────
export const syncVaultIPC = (vault: string, s3: S3Settings) =>
  invoke<SyncReport>("sync_vault", { vault, s3 });
