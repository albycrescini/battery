import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const rootDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
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
  amazonMusicClientId: process.env.AMAZON_MUSIC_CLIENT_ID || "",
  amazonMusicClientSecret: process.env.AMAZON_MUSIC_CLIENT_SECRET || "",
  amazonMusicSecurityProfileId: process.env.AMAZON_MUSIC_SECURITY_PROFILE_ID || "",
  amazonMusicRedirectUri:
    process.env.AMAZON_MUSIC_REDIRECT_URI ||
    `http://127.0.0.1:${port}/auth/amazon-music/callback`,
  amazonMusicAuthorizeUrl:
    process.env.AMAZON_MUSIC_AUTHORIZE_URL || "https://www.amazon.com/ap/oa",
  amazonMusicTokenUrl:
    process.env.AMAZON_MUSIC_TOKEN_URL || "https://api.amazon.com/auth/o2/token",
  amazonMusicApiBaseUrl:
    process.env.AMAZON_MUSIC_API_BASE_URL || "https://api.music.amazon.dev",
  amazonMusicScopes: (
    process.env.AMAZON_MUSIC_SCOPES ||
    "music::profile music::library music::catalog music::favorites"
  )
    .split(/\s+/)
    .filter(Boolean),
  sessionSecret: process.env.SESSION_SECRET || "local-dev-session-secret-change-me",
};

export function spotifyIsConfigured() {
  return Boolean(config.spotifyClientId && config.spotifyClientSecret);
}

export function amazonMusicIsConfigured() {
  return Boolean(
    config.amazonMusicClientId &&
      config.amazonMusicClientSecret &&
      config.amazonMusicSecurityProfileId,
  );
}
