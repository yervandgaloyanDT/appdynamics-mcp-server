/**
 * Shared credential loader for the ad-hoc scripts in this directory.
 *
 * Reads the repo-root .env (which is gitignored), with real environment
 * variables taking precedence. Exits with an actionable message if the
 * required variables are missing.
 *
 * NEVER hardcode credentials in these scripts — .env or the environment only.
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const fileEnv = {};
try {
  for (const line of readFileSync(join(repoRoot, ".env"), "utf-8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) fileEnv[m[1]] = m[2].trim();
  }
} catch {
  // .env is optional — the variables may come from the environment instead.
}

const get = (key) => process.env[key] ?? fileEnv[key] ?? "";

export const BASE = get("APPD_URL");
export const CLIENT_NAME = get("APPD_CLIENT_NAME");
export const ACCOUNT_NAME = get("APPD_ACCOUNT_NAME");
export const CLIENT_SECRET = get("APPD_CLIENT_SECRET");

const missing = Object.entries({
  APPD_URL: BASE,
  APPD_CLIENT_NAME: CLIENT_NAME,
  APPD_CLIENT_SECRET: CLIENT_SECRET,
})
  .filter(([, value]) => !value)
  .map(([key]) => key);

if (missing.length > 0) {
  console.error(
    `Missing required credential(s): ${missing.join(", ")}.\n` +
      `Set them in ${join(repoRoot, ".env")} or export them in your shell.`
  );
  process.exit(1);
}

/** OAuth client id — "clientName@accountName" when an account is configured. */
export const CLIENT_ID = ACCOUNT_NAME ? `${CLIENT_NAME}@${ACCOUNT_NAME}` : CLIENT_NAME;

/** URL-encoded body for the OAuth2 client-credentials token request. */
export function tokenFormBody() {
  return new URLSearchParams({
    grant_type: "client_credentials",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  }).toString();
}
