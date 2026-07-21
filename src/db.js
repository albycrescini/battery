import pg from "pg";
import { config } from "./config.js";
import { decryptSecret, encryptSecret } from "./security.js";

const { Pool } = pg;

const spotifyProvider = "spotify";
const likedSongsSourceType = "liked_songs";
const likedSongsSourceId = "library";
const playlistSourceType = "playlist";

let pool;

export function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: config.databaseUrl,
    });
  }
  return pool;
}

export async function closePool() {
  if (!pool) return;
  await pool.end();
  pool = null;
}

export async function migrate() {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      spotify_user_id TEXT UNIQUE,
      display_name TEXT,
      email TEXT,
      country TEXT,
      product TEXT,
      image_url TEXT,
      access_token TEXT,
      refresh_token TEXT,
      token_expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE users ALTER COLUMN spotify_user_id DROP NOT NULL;

    CREATE TABLE IF NOT EXISTS provider_accounts (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      provider_user_id TEXT NOT NULL,
      display_name TEXT,
      email TEXT,
      country TEXT,
      product TEXT,
      image_url TEXT,
      access_token TEXT,
      refresh_token TEXT,
      token_expires_at TIMESTAMPTZ,
      raw JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (provider, provider_user_id)
    );

    CREATE TABLE IF NOT EXISTS library_sources (
      id BIGSERIAL PRIMARY KEY,
      provider_account_id BIGINT NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
      source_type TEXT NOT NULL,
      provider_source_id TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      raw JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (provider_account_id, source_type, provider_source_id)
    );

    CREATE TABLE IF NOT EXISTS canonical_tracks (
      id BIGSERIAL PRIMARY KEY,
      match_key TEXT NOT NULL UNIQUE,
      isrc TEXT,
      title TEXT NOT NULL,
      artist_names TEXT NOT NULL,
      album_name TEXT,
      duration_ms INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS provider_tracks (
      id BIGSERIAL PRIMARY KEY,
      canonical_track_id BIGINT NOT NULL REFERENCES canonical_tracks(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      external_track_id TEXT NOT NULL,
      title TEXT NOT NULL,
      artist_names TEXT NOT NULL,
      album_name TEXT,
      duration_ms INTEGER,
      popularity INTEGER,
      explicit BOOLEAN,
      preview_url TEXT,
      external_url TEXT,
      provider_uri TEXT,
      image_url TEXT,
      isrc TEXT,
      raw JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (provider, external_track_id)
    );

    DROP TABLE IF EXISTS tracks;

    CREATE TABLE IF NOT EXISTS backup_runs (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider_account_id BIGINT REFERENCES provider_accounts(id) ON DELETE SET NULL,
      library_source_id BIGINT REFERENCES library_sources(id) ON DELETE SET NULL,
      provider TEXT,
      source_type TEXT,
      source TEXT NOT NULL DEFAULT 'spotify:liked_songs',
      status TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ,
      tracks_seen INTEGER NOT NULL DEFAULT 0,
      snapshot_key TEXT,
      error_message TEXT
    );

    ALTER TABLE backup_runs
      ADD COLUMN IF NOT EXISTS provider_account_id BIGINT REFERENCES provider_accounts(id) ON DELETE SET NULL;
    ALTER TABLE backup_runs
      ADD COLUMN IF NOT EXISTS library_source_id BIGINT REFERENCES library_sources(id) ON DELETE SET NULL;
    ALTER TABLE backup_runs
      ADD COLUMN IF NOT EXISTS provider TEXT;
    ALTER TABLE backup_runs
      ADD COLUMN IF NOT EXISTS source_type TEXT;
    ALTER TABLE backup_runs
      ADD COLUMN IF NOT EXISTS snapshot_key TEXT;

    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'backup_run_items'
          AND column_name = 'backup_run_id'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'backup_run_items'
          AND column_name = 'id'
      ) THEN
        DROP TABLE IF EXISTS library_events;
        DROP TABLE IF EXISTS backup_run_items;
      END IF;
    END $$;

    CREATE TABLE IF NOT EXISTS backup_run_items (
      id BIGSERIAL PRIMARY KEY,
      backup_run_id BIGINT NOT NULL REFERENCES backup_runs(id) ON DELETE CASCADE,
      provider_track_id BIGINT NOT NULL REFERENCES provider_tracks(id) ON DELETE CASCADE,
      provider_added_at TIMESTAMPTZ,
      position INTEGER NOT NULL DEFAULT 0,
      raw JSONB NOT NULL DEFAULT '{}'::jsonb,
      observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (backup_run_id, provider_track_id, position)
    );

    CREATE TABLE IF NOT EXISTS library_events (
      id BIGSERIAL PRIMARY KEY,
      library_source_id BIGINT NOT NULL REFERENCES library_sources(id) ON DELETE CASCADE,
      provider_track_id BIGINT NOT NULL REFERENCES provider_tracks(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL CHECK (event_type IN ('added', 'removed')),
      observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      provider_event_at TIMESTAMPTZ,
      backup_run_id BIGINT NOT NULL REFERENCES backup_runs(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (library_source_id, provider_track_id, event_type, backup_run_id)
    );

    CREATE INDEX IF NOT EXISTS idx_backup_runs_user_started_at
      ON backup_runs (user_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_provider_accounts_user_provider
      ON provider_accounts (user_id, provider);
    CREATE INDEX IF NOT EXISTS idx_library_sources_account_type
      ON library_sources (provider_account_id, source_type);
    CREATE INDEX IF NOT EXISTS idx_provider_tracks_canonical
      ON provider_tracks (canonical_track_id);
    CREATE INDEX IF NOT EXISTS idx_backup_runs_source_started_at
      ON backup_runs (library_source_id, started_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_backup_runs_source_snapshot_key
      ON backup_runs (library_source_id, snapshot_key)
      WHERE snapshot_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_backup_run_items_provider_track
      ON backup_run_items (provider_track_id);
    CREATE INDEX IF NOT EXISTS idx_library_events_source_track
      ON library_events (library_source_id, provider_track_id, observed_at DESC);

    INSERT INTO provider_accounts (
      user_id,
      provider,
      provider_user_id,
      display_name,
      email,
      country,
      product,
      image_url,
      access_token,
      refresh_token,
      token_expires_at
    )
    SELECT
      id,
      'spotify',
      spotify_user_id,
      display_name,
      email,
      country,
      product,
      image_url,
      access_token,
      refresh_token,
      token_expires_at
    FROM users
    WHERE spotify_user_id IS NOT NULL
    ON CONFLICT (provider, provider_user_id) DO UPDATE SET
      user_id = EXCLUDED.user_id,
      display_name = EXCLUDED.display_name,
      email = EXCLUDED.email,
      country = EXCLUDED.country,
      product = EXCLUDED.product,
      image_url = EXCLUDED.image_url,
      access_token = COALESCE(EXCLUDED.access_token, provider_accounts.access_token),
      refresh_token = COALESCE(EXCLUDED.refresh_token, provider_accounts.refresh_token),
      token_expires_at = COALESCE(EXCLUDED.token_expires_at, provider_accounts.token_expires_at),
      updated_at = NOW();

    INSERT INTO library_sources (
      provider_account_id,
      source_type,
      provider_source_id,
      name
    )
    SELECT
      id,
      'liked_songs',
      'library',
      'Liked Songs'
    FROM provider_accounts
    WHERE provider = 'spotify'
    ON CONFLICT (provider_account_id, source_type, provider_source_id) DO NOTHING;
  `);
}

function toPublicUser(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    spotifyUserId: row.spotify_user_id,
    displayName: row.display_name,
    email: row.email,
    country: row.country,
    product: row.product,
    imageUrl: row.image_url,
  };
}

export async function upsertUserFromSpotify(profile, tokenSet) {
  const imageUrl = profile.images?.[0]?.url || null;
  const expiresAt = new Date(Date.now() + tokenSet.expires_in * 1000);
  const accessToken = encryptSecret(tokenSet.access_token);
  const refreshToken = encryptSecret(tokenSet.refresh_token);
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `
        INSERT INTO users (
          spotify_user_id,
          display_name,
          email,
          country,
          product,
          image_url,
          access_token,
          refresh_token,
          token_expires_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (spotify_user_id) DO UPDATE SET
          display_name = EXCLUDED.display_name,
          email = EXCLUDED.email,
          country = EXCLUDED.country,
          product = EXCLUDED.product,
          image_url = EXCLUDED.image_url,
          access_token = EXCLUDED.access_token,
          refresh_token = COALESCE(EXCLUDED.refresh_token, users.refresh_token),
          token_expires_at = EXCLUDED.token_expires_at,
          updated_at = NOW()
        RETURNING *
      `,
      [
        profile.id,
        profile.display_name || null,
        profile.email || null,
        profile.country || null,
        profile.product || null,
        imageUrl,
        accessToken,
        refreshToken,
        expiresAt,
      ],
    );

    const user = result.rows[0];
    const providerAccountId = await upsertSpotifyProviderAccount(client, Number(user.id), profile, {
      accessToken,
      refreshToken,
      expiresAt,
    });
    await ensureLibrarySource(client, {
      providerAccountId,
      sourceType: likedSongsSourceType,
      providerSourceId: likedSongsSourceId,
      name: "Liked Songs",
    });

    await client.query("COMMIT");
    return toPublicUser(user);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function upsertSpotifyProviderAccount(client, userId, profile, tokens) {
  const imageUrl = profile.images?.[0]?.url || null;
  const result = await client.query(
    `
      INSERT INTO provider_accounts (
        user_id,
        provider,
        provider_user_id,
        display_name,
        email,
        country,
        product,
        image_url,
        access_token,
        refresh_token,
        token_expires_at,
        raw
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (provider, provider_user_id) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        display_name = EXCLUDED.display_name,
        email = EXCLUDED.email,
        country = EXCLUDED.country,
        product = EXCLUDED.product,
        image_url = EXCLUDED.image_url,
        access_token = EXCLUDED.access_token,
        refresh_token = COALESCE(EXCLUDED.refresh_token, provider_accounts.refresh_token),
        token_expires_at = EXCLUDED.token_expires_at,
        raw = EXCLUDED.raw,
        updated_at = NOW()
      RETURNING id
    `,
    [
      userId,
      spotifyProvider,
      profile.id,
      profile.display_name || null,
      profile.email || null,
      profile.country || null,
      profile.product || null,
      imageUrl,
      tokens.accessToken,
      tokens.refreshToken,
      tokens.expiresAt,
      profile,
    ],
  );

  return Number(result.rows[0].id);
}

async function getSpotifyProviderAccountId(client, userId) {
  const result = await client.query(
    `
      SELECT id
      FROM provider_accounts
      WHERE user_id = $1 AND provider = $2
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `,
    [userId, spotifyProvider],
  );

  return result.rows[0] ? Number(result.rows[0].id) : null;
}

async function ensureSpotifyProviderAccountForUser(client, user) {
  let providerAccountId = await getSpotifyProviderAccountId(client, Number(user.id));

  if (providerAccountId) return providerAccountId;

  if (!user.spotify_user_id) {
    throw new Error("Spotify account metadata is missing. Please reconnect Spotify.");
  }

  const result = await client.query(
    `
      INSERT INTO provider_accounts (
        user_id,
        provider,
        provider_user_id,
        display_name,
        email,
        country,
        product,
        image_url,
        access_token,
        refresh_token,
        token_expires_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (provider, provider_user_id) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        display_name = EXCLUDED.display_name,
        email = EXCLUDED.email,
        country = EXCLUDED.country,
        product = EXCLUDED.product,
        image_url = EXCLUDED.image_url,
        access_token = COALESCE(EXCLUDED.access_token, provider_accounts.access_token),
        refresh_token = COALESCE(EXCLUDED.refresh_token, provider_accounts.refresh_token),
        token_expires_at = COALESCE(EXCLUDED.token_expires_at, provider_accounts.token_expires_at),
        updated_at = NOW()
      RETURNING id
    `,
    [
      Number(user.id),
      spotifyProvider,
      user.spotify_user_id,
      user.display_name || null,
      user.email || null,
      user.country || null,
      user.product || null,
      user.image_url || null,
      user.access_token || null,
      user.refresh_token || null,
      user.token_expires_at || null,
    ],
  );

  return Number(result.rows[0].id);
}

async function ensureLibrarySource(client, source) {
  const result = await client.query(
    `
      INSERT INTO library_sources (
        provider_account_id,
        source_type,
        provider_source_id,
        name,
        raw
      )
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (provider_account_id, source_type, provider_source_id) DO UPDATE SET
        name = EXCLUDED.name,
        raw = EXCLUDED.raw,
        updated_at = NOW()
      RETURNING id
    `,
    [
      source.providerAccountId,
      source.sourceType,
      source.providerSourceId,
      source.name,
      source.raw || {},
    ],
  );

  return Number(result.rows[0].id);
}

export async function getUserById(userId) {
  const result = await getPool().query("SELECT * FROM users WHERE id = $1", [userId]);
  return result.rows[0] || null;
}

export async function getPublicUserById(userId) {
  return toPublicUser(await getUserById(userId));
}

export function decryptUserTokens(user) {
  return {
    accessToken: decryptSecret(user.access_token),
    refreshToken: decryptSecret(user.refresh_token),
    expiresAt: user.token_expires_at ? new Date(user.token_expires_at) : null,
  };
}

export async function ensureSpotifyLibrarySourceForUser(user) {
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");

    const providerAccountId = await ensureSpotifyProviderAccountForUser(client, user);
    const librarySourceId = await ensureLibrarySource(client, {
      providerAccountId,
      sourceType: likedSongsSourceType,
      providerSourceId: likedSongsSourceId,
      name: "Liked Songs",
    });

    await client.query("COMMIT");
    return {
      provider: spotifyProvider,
      sourceType: likedSongsSourceType,
      source: `${spotifyProvider}:${likedSongsSourceType}:${likedSongsSourceId}`,
      providerAccountId,
      librarySourceId,
      providerSourceId: likedSongsSourceId,
      name: "Liked Songs",
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function toPublicLibrarySource(row) {
  if (!row) return null;

  const raw = row.raw || {};
  return {
    id: Number(row.id),
    providerAccountId: Number(row.provider_account_id),
    provider: row.provider,
    providerUserId: row.provider_user_id,
    sourceType: row.source_type,
    providerSourceId: row.provider_source_id,
    name: row.name,
    ownerName: raw.owner?.display_name || raw.owner?.id || null,
    imageUrl: raw.images?.[0]?.url || null,
    trackTotal: raw.tracks?.total ?? null,
    currentTotal: row.current_total ?? 0,
    lastBackupAt: row.last_backup_at || null,
    lastBackupStatus: row.last_backup_status || null,
    lastBackupTracksSeen: row.last_backup_tracks_seen || 0,
    lastBackupError: row.last_backup_error || null,
  };
}

export async function upsertSpotifyPlaylistSourcesForUser(user, playlists) {
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");
    const providerAccountId = await ensureSpotifyProviderAccountForUser(client, user);
    const sources = [];

    for (const playlist of playlists) {
      if (!playlist?.id) continue;
      const librarySourceId = await ensureLibrarySource(client, {
        providerAccountId,
        sourceType: playlistSourceType,
        providerSourceId: playlist.id,
        name: playlist.name || "Untitled playlist",
        raw: playlist,
      });
      sources.push({
        provider: spotifyProvider,
        sourceType: playlistSourceType,
        source: `${spotifyProvider}:${playlistSourceType}:${playlist.id}`,
        providerAccountId,
        librarySourceId,
        providerSourceId: playlist.id,
        name: playlist.name || "Untitled playlist",
      });
    }

    await client.query("COMMIT");
    return sources;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listLibrarySources(userId) {
  const result = await getPool().query(
    `
      SELECT
        library_sources.id,
        library_sources.provider_account_id,
        library_sources.source_type,
        library_sources.provider_source_id,
        library_sources.name,
        library_sources.raw,
        provider_accounts.provider,
        provider_accounts.provider_user_id,
        latest_run.finished_at AS last_backup_at,
        latest_run.status AS last_backup_status,
        latest_run.tracks_seen AS last_backup_tracks_seen,
        latest_run.error_message AS last_backup_error,
        COALESCE(latest_count.current_total, 0)::int AS current_total
      FROM library_sources
      INNER JOIN provider_accounts
        ON provider_accounts.id = library_sources.provider_account_id
      LEFT JOIN LATERAL (
        SELECT id, finished_at, status, tracks_seen, error_message
        FROM backup_runs
        WHERE backup_runs.library_source_id = library_sources.id
        ORDER BY started_at DESC, id DESC
        LIMIT 1
      ) latest_run ON TRUE
      LEFT JOIN LATERAL (
        SELECT id
        FROM backup_runs
        WHERE
          backup_runs.library_source_id = library_sources.id
          AND backup_runs.status = 'succeeded'
        ORDER BY finished_at DESC NULLS LAST, started_at DESC, id DESC
        LIMIT 1
      ) latest_success ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(DISTINCT provider_track_id)::int AS current_total
        FROM backup_run_items
        WHERE backup_run_items.backup_run_id = latest_success.id
      ) latest_count ON TRUE
      WHERE provider_accounts.user_id = $1
      ORDER BY
        provider_accounts.provider ASC,
        CASE library_sources.source_type
          WHEN 'liked_songs' THEN 0
          WHEN 'playlist' THEN 1
          ELSE 2
        END ASC,
        lower(library_sources.name) ASC,
        library_sources.id ASC
    `,
    [userId],
  );

  return result.rows.map(toPublicLibrarySource);
}

export async function getLibrarySourceForUser(userId, librarySourceId = null) {
  const result = await getPool().query(
    `
      SELECT
        library_sources.id,
        library_sources.provider_account_id,
        library_sources.source_type,
        library_sources.provider_source_id,
        library_sources.name,
        library_sources.raw,
        provider_accounts.provider,
        provider_accounts.provider_user_id
      FROM library_sources
      INNER JOIN provider_accounts
        ON provider_accounts.id = library_sources.provider_account_id
      WHERE
        provider_accounts.user_id = $1
        AND ($2::bigint IS NULL OR library_sources.id = $2::bigint)
      ORDER BY
        CASE library_sources.source_type
          WHEN 'liked_songs' THEN 0
          WHEN 'playlist' THEN 1
          ELSE 2
        END ASC,
        lower(library_sources.name) ASC,
        library_sources.id ASC
      LIMIT 1
    `,
    [userId, librarySourceId],
  );

  const source = result.rows[0];
  if (!source) return null;

  return {
    provider: source.provider,
    sourceType: source.source_type,
    source: `${source.provider}:${source.source_type}:${source.provider_source_id}`,
    providerAccountId: Number(source.provider_account_id),
    librarySourceId: Number(source.id),
    providerSourceId: source.provider_source_id,
    name: source.name,
    raw: source.raw || {},
  };
}

export async function updateUserTokens(userId, tokenSet) {
  const expiresAt = new Date(Date.now() + tokenSet.expires_in * 1000);
  const accessToken = encryptSecret(tokenSet.access_token);
  const refreshToken = tokenSet.refresh_token ? encryptSecret(tokenSet.refresh_token) : null;
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");
    await client.query(
      `
        UPDATE users
        SET
          access_token = $2,
          refresh_token = COALESCE($3, refresh_token),
          token_expires_at = $4,
          updated_at = NOW()
        WHERE id = $1
      `,
      [userId, accessToken, refreshToken, expiresAt],
    );
    await client.query(
      `
        UPDATE provider_accounts
        SET
          access_token = $2,
          refresh_token = COALESCE($3, refresh_token),
          token_expires_at = $4,
          updated_at = NOW()
        WHERE user_id = $1 AND provider = $5
      `,
      [userId, accessToken, refreshToken, expiresAt, spotifyProvider],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function createBackupRun(userId, options = {}) {
  const provider = options.provider || spotifyProvider;
  const sourceType = options.sourceType || likedSongsSourceType;
  const source = options.source || `${provider}:${sourceType}`;
  const startedAt = options.startedAt || new Date();
  const result = await getPool().query(
    `
      INSERT INTO backup_runs (
        user_id,
        provider_account_id,
        library_source_id,
        provider,
        source_type,
        source,
        snapshot_key,
        status,
        started_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'running', $8)
      RETURNING id
    `,
    [
      userId,
      options.providerAccountId || null,
      options.librarySourceId || null,
      provider,
      sourceType,
      source,
      options.snapshotKey || null,
      startedAt,
    ],
  );
  return Number(result.rows[0].id);
}

export async function finishBackupRun(runId, status, tracksSeen, errorMessage = null, options = {}) {
  const finishedAt = options.finishedAt || new Date();
  await getPool().query(
    `
      UPDATE backup_runs
      SET status = $2,
          tracks_seen = $3,
          error_message = $4,
          finished_at = $5
      WHERE id = $1
    `,
    [runId, status, tracksSeen, errorMessage, finishedAt],
  );
}

export async function backupRunSnapshotExists(librarySourceId, snapshotKey) {
  const result = await getPool().query(
    `
      SELECT id
      FROM backup_runs
      WHERE
        library_source_id = $1
        AND snapshot_key = $2
        AND status = 'succeeded'
      LIMIT 1
    `,
    [librarySourceId, snapshotKey],
  );

  return Boolean(result.rows[0]);
}

export async function deleteBackupRunBySnapshotKey(librarySourceId, snapshotKey) {
  const result = await getPool().query(
    `
      DELETE FROM backup_runs
      WHERE library_source_id = $1 AND snapshot_key = $2
    `,
    [librarySourceId, snapshotKey],
  );

  return result.rowCount;
}

function normalizeTrack(savedTrack) {
  const track = savedTrack.track;
  if (!track?.id || (track.type && track.type !== "track")) return null;

  const image = track.album?.images?.[0]?.url || null;
  const artists = (track.artists || []).map((artist) => artist.name).join(", ");
  const providerAddedAt = savedTrack.added_at ? new Date(savedTrack.added_at) : null;

  return {
    provider: spotifyProvider,
    externalTrackId: track.id,
    name: track.name,
    artists,
    albumName: track.album?.name || null,
    durationMs: track.duration_ms || null,
    popularity: track.popularity ?? null,
    explicit: track.explicit ?? null,
    previewUrl: track.preview_url || null,
    externalUrl: track.external_urls?.spotify || null,
    providerUri: track.uri || null,
    imageUrl: image,
    isrc: track.external_ids?.isrc || null,
    providerAddedAt,
    raw: savedTrack,
    providerRaw: track,
  };
}

function normalizeIsrc(value) {
  const normalized = value ? String(value).trim().toUpperCase() : "";
  return normalized || null;
}

function normalizeMatchText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function createTrackMatchKey(track) {
  const isrc = normalizeIsrc(track.isrc);
  if (isrc) return `isrc:${isrc}`;

  const durationSeconds = track.durationMs ? Math.round(track.durationMs / 1000) : "";
  return [
    "metadata",
    normalizeMatchText(track.name),
    normalizeMatchText(track.artists),
    durationSeconds,
  ].join(":");
}

async function upsertCanonicalTrack(client, track) {
  const result = await client.query(
    `
      INSERT INTO canonical_tracks (
        match_key,
        isrc,
        title,
        artist_names,
        album_name,
        duration_ms
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (match_key) DO UPDATE SET
        isrc = COALESCE(canonical_tracks.isrc, EXCLUDED.isrc),
        title = EXCLUDED.title,
        artist_names = EXCLUDED.artist_names,
        album_name = EXCLUDED.album_name,
        duration_ms = EXCLUDED.duration_ms,
        updated_at = NOW()
      RETURNING id
    `,
    [
      createTrackMatchKey(track),
      normalizeIsrc(track.isrc),
      track.name,
      track.artists,
      track.albumName,
      track.durationMs,
    ],
  );

  return Number(result.rows[0].id);
}

async function upsertProviderTrack(client, provider, canonicalTrackId, track) {
  const result = await client.query(
    `
      INSERT INTO provider_tracks (
        canonical_track_id,
        provider,
        external_track_id,
        title,
        artist_names,
        album_name,
        duration_ms,
        popularity,
        explicit,
        preview_url,
        external_url,
        provider_uri,
        image_url,
        isrc,
        raw
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      ON CONFLICT (provider, external_track_id) DO UPDATE SET
        canonical_track_id = EXCLUDED.canonical_track_id,
        title = EXCLUDED.title,
        artist_names = EXCLUDED.artist_names,
        album_name = EXCLUDED.album_name,
        duration_ms = EXCLUDED.duration_ms,
        popularity = EXCLUDED.popularity,
        explicit = EXCLUDED.explicit,
        preview_url = EXCLUDED.preview_url,
        external_url = EXCLUDED.external_url,
        provider_uri = EXCLUDED.provider_uri,
        image_url = EXCLUDED.image_url,
        isrc = EXCLUDED.isrc,
        raw = EXCLUDED.raw,
        updated_at = NOW()
      RETURNING id
    `,
    [
      canonicalTrackId,
      provider,
      track.externalTrackId,
      track.name,
      track.artists,
      track.albumName,
      track.durationMs,
      track.popularity,
      track.explicit,
      track.previewUrl,
      track.externalUrl,
      track.providerUri,
      track.imageUrl,
      normalizeIsrc(track.isrc),
      track.providerRaw,
    ],
  );

  return Number(result.rows[0].id);
}

export async function upsertSavedTracks(_userId, savedTracks, options = {}) {
  if (!savedTracks.length) return 0;

  const provider = options.provider || spotifyProvider;
  if (provider !== spotifyProvider) {
    throw new Error(`Unsupported saved-track adapter: ${provider}`);
  }

  const observedAt = options.observedAt || new Date();
  const providerAddedAtOverride = Object.hasOwn(options, "providerAddedAt")
    ? options.providerAddedAt
    : undefined;
  const client = await getPool().connect();
  let saved = 0;

  try {
    await client.query("BEGIN");

    for (const [index, item] of savedTracks.entries()) {
      const track = normalizeTrack(item);
      if (!track) continue;
      const position = options.startPosition !== undefined ? options.startPosition + index : null;
      const providerAddedAt =
        providerAddedAtOverride === undefined ? track.providerAddedAt : providerAddedAtOverride;

      if (options.backupRunId) {
        const canonicalTrackId = await upsertCanonicalTrack(client, track);
        const providerTrackId = await upsertProviderTrack(
          client,
          provider,
          canonicalTrackId,
          track,
        );

        await client.query(
          `
            INSERT INTO backup_run_items (
              backup_run_id,
              provider_track_id,
              provider_added_at,
              position,
              raw,
              observed_at
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (backup_run_id, provider_track_id, position) DO UPDATE SET
              provider_added_at = EXCLUDED.provider_added_at,
              raw = EXCLUDED.raw,
              observed_at = EXCLUDED.observed_at
          `,
          [options.backupRunId, providerTrackId, providerAddedAt, position ?? index, track.raw, observedAt],
        );
      }
      saved += 1;
    }

    await client.query("COMMIT");
    return saved;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function recordLibraryEventsForRun(backupRunId, librarySourceId, options = {}) {
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");

    const currentRun = await client.query(
      `
        SELECT COALESCE(finished_at, started_at) AS sort_at
        FROM backup_runs
        WHERE id = $1 AND library_source_id = $2
      `,
      [backupRunId, librarySourceId],
    );
    if (!currentRun.rows[0]) {
      throw new Error("Backup run was not found for this source.");
    }

    const currentSortAt = currentRun.rows[0].sort_at || new Date();
    const observedAt = options.observedAt || currentSortAt;
    const previousRun = await client.query(
      `
        SELECT id
        FROM backup_runs
        WHERE
          library_source_id = $1
          AND status = 'succeeded'
          AND id <> $2
          AND (COALESCE(finished_at, started_at), id) < ($3::timestamptz, $2::bigint)
        ORDER BY COALESCE(finished_at, started_at) DESC, id DESC
        LIMIT 1
      `,
      [librarySourceId, backupRunId, currentSortAt],
    );
    const previousRunId = previousRun.rows[0] ? Number(previousRun.rows[0].id) : null;

    const addedQuery = previousRunId
      ? `
          INSERT INTO library_events (
            library_source_id,
            provider_track_id,
            event_type,
            observed_at,
            provider_event_at,
            backup_run_id
          )
          SELECT $1, current_items.provider_track_id, 'added', $4,
                 current_items.provider_added_at, $2
          FROM (
            SELECT provider_track_id, MIN(provider_added_at) AS provider_added_at
            FROM backup_run_items
            WHERE backup_run_id = $2
            GROUP BY provider_track_id
          ) current_items
          LEFT JOIN (
            SELECT DISTINCT provider_track_id
            FROM backup_run_items
            WHERE backup_run_id = $3
          ) previous_items
            ON previous_items.provider_track_id = current_items.provider_track_id
          WHERE previous_items.provider_track_id IS NULL
          ON CONFLICT DO NOTHING
          RETURNING id
        `
      : `
          INSERT INTO library_events (
            library_source_id,
            provider_track_id,
            event_type,
            observed_at,
            provider_event_at,
            backup_run_id
          )
          SELECT $1, provider_track_id, 'added', $3, MIN(provider_added_at), $2
          FROM backup_run_items
          WHERE backup_run_id = $2
          GROUP BY provider_track_id
          ON CONFLICT DO NOTHING
          RETURNING id
        `;
    const addedResult = await client.query(
      addedQuery,
      previousRunId
        ? [librarySourceId, backupRunId, previousRunId, observedAt]
        : [librarySourceId, backupRunId, observedAt],
    );

    let removedCount = 0;
    if (previousRunId) {
      const removedResult = await client.query(
        `
          INSERT INTO library_events (
            library_source_id,
            provider_track_id,
            event_type,
            observed_at,
            provider_event_at,
            backup_run_id
          )
          SELECT $1, previous_items.provider_track_id, 'removed', $4, NULL, $2
          FROM (
            SELECT DISTINCT provider_track_id
            FROM backup_run_items
            WHERE backup_run_id = $3
          ) previous_items
          LEFT JOIN (
            SELECT DISTINCT provider_track_id
            FROM backup_run_items
            WHERE backup_run_id = $2
          ) current_items
            ON current_items.provider_track_id = previous_items.provider_track_id
          WHERE current_items.provider_track_id IS NULL
          ON CONFLICT DO NOTHING
          RETURNING id
        `,
        [librarySourceId, backupRunId, previousRunId, observedAt],
      );
      removedCount = removedResult.rowCount;
    }

    await client.query("COMMIT");
    return {
      added: addedResult.rowCount,
      removed: removedCount,
      previousRunId,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function rebuildLibraryEventsForSource(librarySourceId) {
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM library_events WHERE library_source_id = $1", [librarySourceId]);

    const runs = await client.query(
      `
        SELECT id, COALESCE(finished_at, started_at) AS observed_at
        FROM backup_runs
        WHERE library_source_id = $1 AND status = 'succeeded'
        ORDER BY COALESCE(finished_at, started_at) ASC, id ASC
      `,
      [librarySourceId],
    );

    let previousRunId = null;
    let added = 0;
    let removed = 0;

    for (const run of runs.rows) {
      const backupRunId = Number(run.id);
      const observedAt = run.observed_at || new Date();

      if (previousRunId) {
        const addedResult = await client.query(
          `
            INSERT INTO library_events (
              library_source_id,
              provider_track_id,
              event_type,
              observed_at,
              provider_event_at,
              backup_run_id
            )
            SELECT $1, current_items.provider_track_id, 'added', $4,
                   current_items.provider_added_at, $2
            FROM (
              SELECT provider_track_id, MIN(provider_added_at) AS provider_added_at
              FROM backup_run_items
              WHERE backup_run_id = $2
              GROUP BY provider_track_id
            ) current_items
            LEFT JOIN (
              SELECT DISTINCT provider_track_id
              FROM backup_run_items
              WHERE backup_run_id = $3
            ) previous_items
              ON previous_items.provider_track_id = current_items.provider_track_id
            WHERE previous_items.provider_track_id IS NULL
            ON CONFLICT DO NOTHING
            RETURNING id
          `,
          [librarySourceId, backupRunId, previousRunId, observedAt],
        );
        added += addedResult.rowCount;

        const removedResult = await client.query(
          `
            INSERT INTO library_events (
              library_source_id,
              provider_track_id,
              event_type,
              observed_at,
              provider_event_at,
              backup_run_id
            )
            SELECT $1, previous_items.provider_track_id, 'removed', $4, NULL, $2
            FROM (
              SELECT DISTINCT provider_track_id
              FROM backup_run_items
              WHERE backup_run_id = $3
            ) previous_items
            LEFT JOIN (
              SELECT DISTINCT provider_track_id
              FROM backup_run_items
              WHERE backup_run_id = $2
            ) current_items
              ON current_items.provider_track_id = previous_items.provider_track_id
            WHERE current_items.provider_track_id IS NULL
            ON CONFLICT DO NOTHING
            RETURNING id
          `,
          [librarySourceId, backupRunId, previousRunId, observedAt],
        );
        removed += removedResult.rowCount;
      } else {
        const addedResult = await client.query(
          `
            INSERT INTO library_events (
              library_source_id,
              provider_track_id,
              event_type,
              observed_at,
              provider_event_at,
              backup_run_id
            )
            SELECT $1, provider_track_id, 'added', $3, MIN(provider_added_at), $2
            FROM backup_run_items
            WHERE backup_run_id = $2
            GROUP BY provider_track_id
            ON CONFLICT DO NOTHING
            RETURNING id
          `,
          [librarySourceId, backupRunId, observedAt],
        );
        added += addedResult.rowCount;
      }

      previousRunId = backupRunId;
    }

    await client.query("COMMIT");
    return {
      runs: runs.rowCount,
      added,
      removed,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listTracks(userId, librarySourceId = null) {
  const source = await getLibrarySourceForUser(userId, librarySourceId);
  if (!source) return [];

  const result = await getPool().query(
    `
      WITH latest_run AS (
        SELECT id
        FROM backup_runs
        WHERE
          library_source_id = $2
          AND status = 'succeeded'
        ORDER BY finished_at DESC NULLS LAST, started_at DESC, id DESC
        LIMIT 1
      ),
      current_items AS (
        SELECT
          provider_track_id,
          MIN(provider_added_at) AS provider_added_at,
          MIN(position)::int AS position
        FROM backup_run_items
        WHERE backup_run_id = (SELECT id FROM latest_run)
        GROUP BY provider_track_id
      ),
      source_items AS (
        SELECT
          backup_run_items.provider_track_id,
          MIN(backup_run_items.provider_added_at) AS first_provider_added_at,
          MIN(backup_runs.finished_at) AS first_backed_up_at,
          MAX(backup_runs.finished_at) AS last_seen_at
        FROM backup_run_items
        INNER JOIN backup_runs
          ON backup_runs.id = backup_run_items.backup_run_id
        WHERE
          backup_runs.user_id = $1
          AND backup_runs.library_source_id = $2
          AND backup_runs.status = 'succeeded'
        GROUP BY backup_run_items.provider_track_id
      ),
      event_stats AS (
        SELECT
          provider_track_id,
          COUNT(*) FILTER (WHERE event_type = 'added')::int AS add_count,
          COUNT(*) FILTER (WHERE event_type = 'removed')::int AS remove_count,
          MIN(observed_at) FILTER (WHERE event_type = 'added') AS first_added_observed_at,
          MAX(observed_at) FILTER (WHERE event_type = 'added') AS last_added_observed_at,
          MAX(observed_at) FILTER (WHERE event_type = 'removed') AS last_removed_observed_at
        FROM library_events
        WHERE library_source_id = $2
        GROUP BY provider_track_id
      ),
      event_history AS (
        SELECT
          provider_track_id,
          jsonb_agg(
            jsonb_build_object(
              'id', id,
              'type', event_type,
              'observedAt', observed_at,
              'providerEventAt', provider_event_at
            )
            ORDER BY observed_at, id
          ) AS source_events
        FROM library_events
        WHERE library_source_id = $2
        GROUP BY provider_track_id
      )
      SELECT
        provider_tracks.id AS provider_track_db_id,
        provider_tracks.provider,
        provider_tracks.external_track_id,
        provider_tracks.title,
        provider_tracks.artist_names,
        provider_tracks.album_name,
        provider_tracks.duration_ms,
        provider_tracks.popularity,
        provider_tracks.explicit,
        provider_tracks.preview_url,
        provider_tracks.external_url,
        provider_tracks.provider_uri,
        provider_tracks.image_url,
        provider_tracks.isrc,
        provider_tracks.canonical_track_id,
        COALESCE(current_items.provider_added_at, source_items.first_provider_added_at) AS provider_added_at,
        current_items.position,
        source_items.first_backed_up_at,
        source_items.last_seen_at,
        COALESCE(event_stats.add_count, 0) AS add_count,
        COALESCE(event_stats.remove_count, 0) AS remove_count,
        event_stats.first_added_observed_at,
        event_stats.last_added_observed_at,
        event_stats.last_removed_observed_at,
        COALESCE(event_history.source_events, '[]'::jsonb) AS source_events,
        CASE
          WHEN (SELECT id FROM latest_run) IS NULL THEN TRUE
          ELSE current_items.provider_track_id IS NOT NULL
        END AS is_currently_saved
      FROM source_items
      INNER JOIN provider_tracks
        ON provider_tracks.id = source_items.provider_track_id
      LEFT JOIN current_items
        ON current_items.provider_track_id = provider_tracks.id
      LEFT JOIN event_stats
        ON event_stats.provider_track_id = provider_tracks.id
      LEFT JOIN event_history
        ON event_history.provider_track_id = provider_tracks.id
      ORDER BY
        is_currently_saved DESC,
        current_items.position ASC NULLS LAST,
        provider_added_at DESC NULLS LAST,
        provider_tracks.title ASC
      LIMIT 2000
    `,
    [userId, source.librarySourceId],
  );

  return result.rows.map((row) => ({
    id: String(row.provider_track_db_id),
    providerTrackId: String(row.provider_track_db_id),
    providerTrackDbId: Number(row.provider_track_db_id),
    canonicalTrackId: row.canonical_track_id ? Number(row.canonical_track_id) : null,
    provider: row.provider || spotifyProvider,
    externalTrackId: row.external_track_id,
    name: row.title,
    artists: row.artist_names,
    album: row.album_name,
    durationMs: row.duration_ms,
    popularity: row.popularity,
    explicit: row.explicit,
    previewUrl: row.preview_url,
    externalUrl: row.external_url,
    providerUri: row.provider_uri,
    imageUrl: row.image_url,
    isrc: row.isrc,
    providerAddedAt: row.provider_added_at,
    position: row.position,
    firstBackedUpAt: row.first_backed_up_at,
    lastSeenAt: row.last_seen_at,
    sourceAddCount: Math.max(Number(row.add_count || 0), 1),
    sourceRemoveCount: Number(row.remove_count || 0),
    firstAddedObservedAt: row.first_added_observed_at,
    lastAddedObservedAt: row.last_added_observed_at,
    lastRemovedObservedAt: row.last_removed_observed_at,
    sourceEvents: row.source_events || [],
    isCurrentlySaved: row.is_currently_saved,
  }));
}

export async function getLibrarySummary(userId, librarySourceId = null) {
  const source = await getLibrarySourceForUser(userId, librarySourceId);
  if (!source) {
    return {
      total: 0,
      currentTotal: 0,
      totalKnown: 0,
      rediscoveredTracks: 0,
      removedTracks: 0,
      lifecycleEvents: 0,
      lastBackupAt: null,
      lastBackupStatus: null,
      lastBackupTracksSeen: 0,
      lastBackupError: null,
      selectedSource: null,
    };
  }

  const [
    { rows: countRows },
    { rows: currentRows },
    { rows: runRows },
    { rows: eventRows },
  ] = await Promise.all([
    getPool().query(
      `
        SELECT COUNT(DISTINCT backup_run_items.provider_track_id)::int AS count
        FROM backup_run_items
        INNER JOIN backup_runs
          ON backup_runs.id = backup_run_items.backup_run_id
        WHERE
          backup_runs.user_id = $1
          AND backup_runs.library_source_id = $2
          AND backup_runs.status = 'succeeded'
      `,
      [userId, source.librarySourceId],
    ),
    getPool().query(
      `
        WITH latest_run AS (
          SELECT id
          FROM backup_runs
          WHERE
            library_source_id = $1
            AND status = 'succeeded'
          ORDER BY finished_at DESC NULLS LAST, started_at DESC, id DESC
          LIMIT 1
        )
        SELECT
          (SELECT id FROM latest_run) AS run_id,
          (
            SELECT COUNT(DISTINCT provider_track_id)::int
            FROM backup_run_items
            WHERE backup_run_id = (SELECT id FROM latest_run)
          ) AS count
      `,
      [source.librarySourceId],
    ),
    getPool().query(
      `
        SELECT finished_at, tracks_seen, status, error_message
        FROM backup_runs
        WHERE library_source_id = $1
        ORDER BY started_at DESC, id DESC
        LIMIT 1
      `,
      [source.librarySourceId],
    ),
    getPool().query(
      `
        WITH stats AS (
          SELECT
            provider_track_id,
            COUNT(*) FILTER (WHERE event_type = 'added')::int AS add_count,
            COUNT(*) FILTER (WHERE event_type = 'removed')::int AS remove_count
          FROM library_events
          WHERE library_source_id = $1
          GROUP BY provider_track_id
        )
        SELECT
          COUNT(*) FILTER (WHERE add_count > 1)::int AS rediscovered_tracks,
          COUNT(*) FILTER (WHERE remove_count > 0)::int AS removed_tracks,
          COALESCE(SUM(add_count + remove_count), 0)::int AS lifecycle_events
        FROM stats
      `,
      [source.librarySourceId],
    ),
  ]);

  const knownTotal = countRows[0]?.count || 0;
  const currentRunId = currentRows[0]?.run_id || null;
  const currentTotal = currentRunId ? currentRows[0]?.count || 0 : knownTotal;

  return {
    total: currentTotal,
    currentTotal,
    totalKnown: knownTotal,
    rediscoveredTracks: eventRows[0]?.rediscovered_tracks || 0,
    removedTracks: eventRows[0]?.removed_tracks || 0,
    lifecycleEvents: eventRows[0]?.lifecycle_events || 0,
    lastBackupAt: runRows[0]?.finished_at || null,
    lastBackupStatus: runRows[0]?.status || null,
    lastBackupTracksSeen: runRows[0]?.tracks_seen || 0,
    lastBackupError: runRows[0]?.error_message || null,
    selectedSource: {
      id: source.librarySourceId,
      provider: source.provider,
      sourceType: source.sourceType,
      providerSourceId: source.providerSourceId,
      name: source.name,
    },
  };
}
