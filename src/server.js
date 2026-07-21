import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { parse } from "node:url";
import next from "next";
import { config, rootDir, spotifyIsConfigured } from "./config.js";
import {
  clearCookie,
  getSignedCookie,
  setSignedCookie,
} from "./cookies.js";
import {
  createBackupRun,
  decryptUserTokens,
  ensureSpotifyLibrarySourceForUser,
  finishBackupRun,
  getLibrarySummary,
  getPublicUserById,
  getUserById,
  listTracks,
  migrate,
  recordLibraryEventsForRun,
  updateUserTokens,
  upsertSavedTracks,
  upsertUserFromSpotify,
} from "./db.js";
import {
  createAuthorizationUrl,
  exchangeCodeForToken,
  fetchSavedTracks,
  getCurrentSpotifyUser,
  refreshAccessToken,
} from "./spotify.js";

process.env.NEXT_TELEMETRY_DISABLED ||= "1";

const host = "127.0.0.1";
const nextApp = next({
  dev: process.env.NODE_ENV !== "production",
  dir: rootDir,
  hostname: host,
  port: config.port,
});
const nextRequestHandler = nextApp.getRequestHandler();

let dbReady = false;
let dbStartupError = null;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

async function getSessionUser(req) {
  const userId = getSignedCookie(req, "spotify_backup_session");
  if (!userId) return null;
  await ensureDatabaseReady();
  return getUserById(userId);
}

async function getSessionUserId(req) {
  const userId = getSignedCookie(req, "spotify_backup_session");
  return userId ? Number(userId) : null;
}

const server = createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);

    if (requestUrl.pathname === "/health") {
      return sendJson(res, 200, {
        ok: true,
        databaseReady: dbReady,
        databaseError: dbStartupError?.message || null,
      });
    }

    if (requestUrl.pathname === "/api/session") {
      const userId = await getSessionUserId(req);
      const user = userId ? await getPublicUserByIdAfterDbReady(userId) : null;
      return sendJson(res, 200, {
        authenticated: Boolean(user),
        user,
        spotifyConfigured: spotifyIsConfigured(),
        databaseReady: dbReady,
        databaseError: dbStartupError?.message || null,
      });
    }

    if (requestUrl.pathname === "/api/tracks") {
      const userId = await getSessionUserId(req);
      if (!userId) {
        return sendJson(res, 200, {
          tracks: [],
          total: 0,
          lastBackupAt: null,
          lastBackupStatus: null,
        });
      }

      await ensureDatabaseReady();
      const [tracks, summary] = await Promise.all([
        listTracks(userId),
        getLibrarySummary(userId),
      ]);

      return sendJson(res, 200, { tracks, ...summary });
    }

    if (requestUrl.pathname === "/api/backup/liked-songs" && req.method === "POST") {
      return backupLikedSongs(req, res);
    }

    if (requestUrl.pathname === "/auth/login") {
      return login(req, res);
    }

    if (requestUrl.pathname === "/auth/callback") {
      return authCallback(req, res, requestUrl);
    }

    if (requestUrl.pathname === "/auth/logout") {
      clearCookie(res, "spotify_backup_session");
      return redirect(res, "/");
    }

    if (requestUrl.pathname.startsWith("/api/")) {
      return sendError(res, 404, "Unknown API route");
    }

    return nextRequestHandler(req, res, parse(req.url, true));
  } catch (error) {
    console.error(error);
    return sendError(res, error.status || 500, error.message || "Unexpected server error");
  }
});

async function login(_req, res) {
  if (!spotifyIsConfigured()) {
    return redirect(res, "/?error=spotify_not_configured");
  }

  const state = randomBytes(24).toString("base64url");
  setSignedCookie(res, "spotify_backup_oauth_state", state, {
    maxAge: 60 * 10,
  });
  return redirect(res, createAuthorizationUrl(state));
}

async function authCallback(req, res, requestUrl) {
  const returnedState = requestUrl.searchParams.get("state");
  const expectedState = getSignedCookie(req, "spotify_backup_oauth_state");
  clearCookie(res, "spotify_backup_oauth_state");

  if (requestUrl.searchParams.get("error")) {
    return redirect(res, `/?error=${encodeURIComponent(requestUrl.searchParams.get("error"))}`);
  }

  if (!returnedState || !expectedState || returnedState !== expectedState) {
    return redirect(res, "/?error=state_mismatch");
  }

  const code = requestUrl.searchParams.get("code");
  if (!code) {
    return redirect(res, "/?error=missing_code");
  }

  const tokenSet = await exchangeCodeForToken(code);
  const profile = await getCurrentSpotifyUser(tokenSet.access_token);
  await ensureDatabaseReady();
  const user = await upsertUserFromSpotify(profile, tokenSet);
  setSignedCookie(res, "spotify_backup_session", String(user.id), {
    maxAge: 60 * 60 * 24 * 30,
  });

  return redirect(res, "/?connected=1");
}

async function backupLikedSongs(req, res) {
  const user = await getSessionUser(req);
  if (!user) return sendError(res, 401, "Connect Spotify before backing up songs.");

  const accessToken = await getValidAccessToken(user);
  const source = await ensureSpotifyLibrarySourceForUser(user);
  const backupRunId = await createBackupRun(Number(user.id), source);
  let totalSeen = 0;

  try {
    totalSeen = await fetchSavedTracks(accessToken, async (items, _page, pageStart) => {
      await upsertSavedTracks(Number(user.id), items, {
        backupRunId,
        provider: source.provider,
        startPosition: pageStart,
      });
    });

    await recordLibraryEventsForRun(backupRunId, source.librarySourceId);
    await finishBackupRun(backupRunId, "succeeded", totalSeen);
    const [tracks, summary] = await Promise.all([
      listTracks(Number(user.id)),
      getLibrarySummary(Number(user.id)),
    ]);
    return sendJson(res, 200, { tracks, ...summary });
  } catch (error) {
    await finishBackupRun(backupRunId, "failed", totalSeen, error.message);
    throw error;
  }
}

async function getPublicUserByIdAfterDbReady(userId) {
  await ensureDatabaseReady();
  return getPublicUserById(userId);
}

async function getValidAccessToken(user) {
  const tokens = decryptUserTokens(user);
  const expiresAt = tokens.expiresAt?.getTime() || 0;
  const refreshThreshold = Date.now() + 60 * 1000;

  if (tokens.accessToken && expiresAt > refreshThreshold) {
    return tokens.accessToken;
  }

  if (!tokens.refreshToken) {
    const error = new Error("Spotify refresh token is missing. Please reconnect Spotify.");
    error.status = 401;
    throw error;
  }

  const tokenSet = await refreshAccessToken(tokens.refreshToken);
  await updateUserTokens(Number(user.id), tokenSet);
  return tokenSet.access_token;
}

async function ensureDatabaseReady() {
  if (dbReady) return;

  try {
    await migrate();
    dbReady = true;
    dbStartupError = null;
  } catch (error) {
    dbStartupError = error;
    error.status = 503;
    throw error;
  }
}

await nextApp.prepare();

try {
  await ensureDatabaseReady();
} catch (error) {
  console.warn(`Database is not ready yet: ${error.message}`);
}

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(
      `Port ${config.port} is already in use. Stop the existing server or start with PORT=3001.`,
    );
    process.exit(1);
  }

  throw error;
});

server.listen(config.port, host, () => {
  console.log(`Spotify Backup running at http://${host}:${config.port}`);
});
