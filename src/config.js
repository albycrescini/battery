import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const rootDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
export const publicDir = join(rootDir, "public");

function loadEnvFile() {
  const envPath = join(rootDir, ".env");
  if (!existsSync(envPath)) return;

  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

loadEnvFile();

const port = Number(process.env.PORT || 3000);

export const config = {
  port,
  databaseUrl:
    process.env.DATABASE_URL ||
    "postgres://spotify_backup:spotify_backup@127.0.0.1:5432/spotify_backup",
  spotifyClientId: process.env.SPOTIFY_CLIENT_ID || "",
  spotifyClientSecret: process.env.SPOTIFY_CLIENT_SECRET || "",
  spotifyRedirectUri:
    process.env.SPOTIFY_REDIRECT_URI || `http://127.0.0.1:${port}/auth/callback`,
  sessionSecret: process.env.SESSION_SECRET || "local-dev-session-secret-change-me",
};

export function spotifyIsConfigured() {
  return Boolean(config.spotifyClientId && config.spotifyClientSecret);
}
