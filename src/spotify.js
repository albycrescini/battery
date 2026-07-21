import { setTimeout as delay } from "node:timers/promises";
import { config } from "./config.js";

const authorizeUrl = "https://accounts.spotify.com/authorize";
const tokenUrl = "https://accounts.spotify.com/api/token";
const apiBaseUrl = "https://api.spotify.com/v1";
const musicBackupScopes = [
  "user-library-read",
  "user-read-email",
  "playlist-read-private",
  "playlist-read-collaborative",
];

function getBasicAuthHeader() {
  return `Basic ${Buffer.from(
    `${config.spotifyClientId}:${config.spotifyClientSecret}`,
  ).toString("base64")}`;
}

function tokenRequestBody(values) {
  return new URLSearchParams(values).toString();
}

export function createAuthorizationUrl(state) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.spotifyClientId,
    scope: musicBackupScopes.join(" "),
    redirect_uri: config.spotifyRedirectUri,
    state,
  });

  return `${authorizeUrl}?${params.toString()}`;
}

export async function exchangeCodeForToken(code) {
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      Authorization: getBasicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: tokenRequestBody({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.spotifyRedirectUri,
    }),
  });

  return parseSpotifyResponse(response, "Spotify token exchange failed");
}

export async function refreshAccessToken(refreshToken) {
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      Authorization: getBasicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: tokenRequestBody({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  return parseSpotifyResponse(response, "Spotify token refresh failed");
}

export async function getCurrentSpotifyUser(accessToken) {
  return spotifyGet(accessToken, "/me");
}

export async function fetchSavedTracks(accessToken, onPage) {
  let nextUrl = `${apiBaseUrl}/me/tracks?limit=50`;
  let totalSeen = 0;

  while (nextUrl) {
    const page = await spotifyGet(accessToken, nextUrl);
    const items = page.items || [];
    const pageStart = totalSeen;
    totalSeen += items.length;
    await onPage(items, page, pageStart);
    nextUrl = page.next;
  }

  return totalSeen;
}

export async function fetchCurrentUserPlaylists(accessToken) {
  let nextUrl = `${apiBaseUrl}/me/playlists?limit=50`;
  const playlists = [];

  while (nextUrl) {
    const page = await spotifyGet(accessToken, nextUrl);
    playlists.push(...(page.items || []).filter((playlist) => playlist?.id));
    nextUrl = page.next;
  }

  return playlists;
}

export async function fetchPlaylistTracks(accessToken, playlistId, onPage) {
  let nextUrl = `${apiBaseUrl}/playlists/${encodeURIComponent(playlistId)}/tracks?limit=100`;
  let totalSeen = 0;

  while (nextUrl) {
    const page = await spotifyGet(accessToken, nextUrl);
    const items = page.items || [];
    const pageStart = totalSeen;
    totalSeen += items.length;
    await onPage(items, page, pageStart);
    nextUrl = page.next;
  }

  return totalSeen;
}

async function spotifyGet(accessToken, pathOrUrl) {
  const url = pathOrUrl.startsWith("https://") ? pathOrUrl : `${apiBaseUrl}${pathOrUrl}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("retry-after") || 1);
    await delay(Math.min(retryAfter, 10) * 1000);
    return spotifyGet(accessToken, pathOrUrl);
  }

  return parseSpotifyResponse(response, `Spotify request failed for ${url}`);
}

async function parseSpotifyResponse(response, fallbackMessage) {
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const message = payload.error_description || payload.error?.message || fallbackMessage;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  return payload;
}
