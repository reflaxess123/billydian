import { AppSettings, DeviceSecrets, VaultLocalSettings } from "../types";

export const CONFIG_FILE = ".billydian/config.json";
export const TOKENS_FILE = ".billydian/tokens.json";

// Carve AppSettings into a vault-local half (theme, scale, model,
// noteMode, noteWidth, …) and a device-local half (apiKey + S3 creds).
// They persist to separate files — config.json lives in the vault and
// rides along on every S3 sync; secrets.json lives in the OS app
// config dir and never leaves the machine.
export function splitSettings(merged: AppSettings): {
  vaultLocal: VaultLocalSettings;
  deviceSecrets: DeviceSecrets;
} {
  const { apiKey, s3, ...rest } = merged;
  return { vaultLocal: rest, deviceSecrets: { apiKey, s3 } };
}
