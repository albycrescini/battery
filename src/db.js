import pg from "pg";
import { config } from "./config.js";
import { decryptSecret, encryptSecret } from "./security.js";

const { Pool } = pg;

const spotifyProvider = "spotify";
const likedSongsSourceType = "liked_songs";
const likedSongsSourceId = "library";

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

    CREATE TABLE IF NOT EXISTS tracks (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      spotify_track_id TEXT NOT NULL,
      name TEXT NOT NULL,
      artists TEXT NOT NULL,
      album_name TEXT,
      duration_ms INTEGER,
      popularity INTEGER,
      explicit BOOLEAN,
      preview_url TEXT,
      external_url TEXT,
      spotify_uri TEXT,
      image_url TEXT,
      isrc TEXT,
      spotify_added_at TIMESTAMPTZ,
      first_backed_up_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      raw JSONB NOT NULL,
      UNIQUE (user_id, spotify_track_id)
    );

    CREATE TABLE IF NOT EXISTS backup_runs (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider_account_id BIGINT REFERENCES provider_accounts(id) ON DELETE SET NULL,
      library_source_id BIGINT REFERENCES library_sources(id) ON DELETE SET NULL,
      provider TEXT,
      source_type TEXT,
      source TEXT NOT NULL DEFAULT 'spotify-liked-songs',
      status TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ,
      tracks_seen INTEGER NOT NULL DEFAULT 0,
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

    CREATE TABLE IF NOT EXISTS backup_run_items (
      backup_run_id BIGINT NOT NULL REFERENCES backup_runs(id) ON DELETE CASCADE,
      provider_track_id BIGINT NOT NULL REFERENCES provider_tracks(id) ON DELETE CASCADE,
      provider_added_at TIMESTAMPTZ,
      position INTEGER,
      raw JSONB NOT NULL DEFAULT '{}'::jsonb,
      observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (backup_run_id, provider_track_id)
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

    CREATE INDEX IF NOT EXISTS idx_tracks_user_saved_at
      ON tracks (user_id, spotify_added_at DESC NULLS LAST);
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

    let providerAccountId = await getSpotifyProviderAccountId(client, Number(user.id));

    if (!providerAccountId) {
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
            token_expires_at = COALESCE(
              EXCLUDED.token_expires_at,
              provider_accounts.token_expires_at
            ),
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
      providerAccountId = Number(result.rows[0].id);
    }

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
      source: "spotify-liked-songs",
      providerAccountId,
      librarySourceId,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
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
  const result = await getPool().query(
    `
      INSERT INTO backup_runs (
        user_id,
        provider_account_id,
        library_source_id,
        provider,
        source_type,
        source,
        status
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'running')
      RETURNING id
    `,
    [
      userId,
      options.providerAccountId || null,
      options.librarySourceId || null,
      provider,
      sourceType,
      source,
    ],
  );
  return Number(result.rows[0].id);
}

export async function finishBackupRun(runId, status, tracksSeen, errorMessage = null) {
  await getPool().query(
    `
      UPDATE backup_runs
      SET status = $2,
          tracks_seen = $3,
          error_message = $4,
          finished_at = NOW()
      WHERE id = $1
    `,
    [runId, status, tracksSeen, errorMessage],
  );
}

function normalizeTrack(savedTrack) {
  const track = savedTrack.track;
  const image = track.album?.images?.[0]?.url || null;
  const artists = (track.artists || []).map((artist) => artist.name).join(", ");

  return {
    provider: spotifyProvider,
    externalTrackId: track.id,
    spotifyTrackId: track.id,
    name: track.name,
    artists,
    albumName: track.album?.name || null,
    durationMs: track.duration_ms || null,
    popularity: track.popularity ?? null,
    explicit: track.explicit ?? null,
    previewUrl: track.preview_url || null,
    externalUrl: track.external_urls?.spotify || null,
    spotifyUri: track.uri || null,
    imageUrl: image,
    isrc: track.external_ids?.isrc || null,
    spotifyAddedAt: savedTrack.added_at ? new Date(savedTrack.added_at) : null,
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
      track.spotifyUri,
      track.imageUrl,
      normalizeIsrc(track.isrc),
      track.providerRaw,
    ],
  );

  return Number(result.rows[0].id);
}

async function upsertLegacySpotifyTrack(client, userId, track) {
  await client.query(
    `
      INSERT INTO tracks (
        user_id,
        spotify_track_id,
        name,
        artists,
        album_name,
        duration_ms,
        popularity,
        explicit,
        preview_url,
        external_url,
        spotify_uri,
        image_url,
        isrc,
        spotify_added_at,
        raw
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      ON CONFLICT (user_id, spotify_track_id) DO UPDATE SET
        name = EXCLUDED.name,
        artists = EXCLUDED.artists,
        album_name = EXCLUDED.album_name,
        duration_ms = EXCLUDED.duration_ms,
        popularity = EXCLUDED.popularity,
        explicit = EXCLUDED.explicit,
        preview_url = EXCLUDED.preview_url,
        external_url = EXCLUDED.external_url,
        spotify_uri = EXCLUDED.spotify_uri,
        image_url = EXCLUDED.image_url,
        isrc = EXCLUDED.isrc,
        spotify_added_at = EXCLUDED.spotify_added_at,
        raw = EXCLUDED.raw,
        last_seen_at = NOW()
    `,
    [
      userId,
      track.spotifyTrackId,
      track.name,
      track.artists,
      track.albumName,
      track.durationMs,
      track.popularity,
      track.explicit,
      track.previewUrl,
      track.externalUrl,
      track.spotifyUri,
      track.imageUrl,
      track.isrc,
      track.spotifyAddedAt,
      track.raw,
    ],
  );
}

export async function upsertSavedTracks(userId, savedTracks, options = {}) {
  if (!savedTracks.length) return 0;

  const provider = options.provider || spotifyProvider;
  if (provider !== spotifyProvider) {
    throw new Error(`Unsupported saved-track adapter: ${provider}`);
  }

  const client = await getPool().connect();
  let saved = 0;

  try {
    await client.query("BEGIN");

    for (const [index, item] of savedTracks.entries()) {
      if (!item.track?.id) continue;
      const track = normalizeTrack(item);
      const position = options.startPosition !== undefined ? options.startPosition + index : null;

      await upsertLegacySpotifyTrack(client, userId, track);

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
              raw
            )
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (backup_run_id, provider_track_id) DO UPDATE SET
              provider_added_at = EXCLUDED.provider_added_at,
              position = EXCLUDED.position,
              raw = EXCLUDED.raw,
              observed_at = NOW()
          `,
          [options.backupRunId, providerTrackId, track.spotifyAddedAt, position, track.raw],
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

export async function recordLibraryEventsForRun(backupRunId, librarySourceId) {
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");

    const previousRun = await client.query(
      `
        SELECT id
        FROM backup_runs
        WHERE
          library_source_id = $1
          AND status = 'succeeded'
          AND id <> $2
        ORDER BY finished_at DESC NULLS LAST, started_at DESC, id DESC
        LIMIT 1
      `,
      [librarySourceId, backupRunId],
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
          SELECT $1, current_items.provider_track_id, 'added', NOW(),
                 current_items.provider_added_at, $2
          FROM backup_run_items current_items
          LEFT JOIN backup_run_items previous_items
            ON previous_items.backup_run_id = $3
           AND previous_items.provider_track_id = current_items.provider_track_id
          WHERE current_items.backup_run_id = $2
            AND previous_items.provider_track_id IS NULL
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
          SELECT $1, provider_track_id, 'added', NOW(), provider_added_at, $2
          FROM backup_run_items
          WHERE backup_run_id = $2
          ON CONFLICT DO NOTHING
          RETURNING id
        `;
    const addedResult = await client.query(
      addedQuery,
      previousRunId ? [librarySourceId, backupRunId, previousRunId] : [librarySourceId, backupRunId],
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
          SELECT $1, previous_items.provider_track_id, 'removed', NOW(), NULL, $2
          FROM backup_run_items previous_items
          LEFT JOIN backup_run_items current_items
            ON current_items.backup_run_id = $2
           AND current_items.provider_track_id = previous_items.provider_track_id
          WHERE previous_items.backup_run_id = $3
            AND current_items.provider_track_id IS NULL
          ON CONFLICT DO NOTHING
          RETURNING id
        `,
        [librarySourceId, backupRunId, previousRunId],
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

export async function listTracks(userId) {
  const result = await getPool().query(
    `
      WITH latest_run AS (
        SELECT id
        FROM backup_runs
        WHERE
          user_id = $1
          AND provider = 'spotify'
          AND source_type = 'liked_songs'
          AND status = 'succeeded'
        ORDER BY finished_at DESC NULLS LAST, started_at DESC, id DESC
        LIMIT 1
      ),
      current_items AS (
        SELECT provider_track_id
        FROM backup_run_items
        WHERE backup_run_id = (SELECT id FROM latest_run)
      ),
      event_stats AS (
        SELECT
          library_events.provider_track_id,
          COUNT(*) FILTER (WHERE event_type = 'added')::int AS favorite_add_count,
          COUNT(*) FILTER (WHERE event_type = 'removed')::int AS favorite_remove_count,
          MIN(observed_at) FILTER (WHERE event_type = 'added') AS first_favorited_observed_at,
          MAX(observed_at) FILTER (WHERE event_type = 'added') AS last_favorited_observed_at,
          MAX(observed_at) FILTER (WHERE event_type = 'removed') AS last_removed_observed_at
        FROM library_events
        INNER JOIN backup_runs
          ON backup_runs.id = library_events.backup_run_id
        WHERE
          backup_runs.user_id = $1
          AND backup_runs.provider = 'spotify'
          AND backup_runs.source_type = 'liked_songs'
        GROUP BY library_events.provider_track_id
      ),
      event_history AS (
        SELECT
          library_events.provider_track_id,
          jsonb_agg(
            jsonb_build_object(
              'id', library_events.id,
              'type', library_events.event_type,
              'observedAt', library_events.observed_at,
              'providerEventAt', library_events.provider_event_at
            )
            ORDER BY library_events.observed_at, library_events.id
          ) AS favorite_events
        FROM library_events
        INNER JOIN backup_runs
          ON backup_runs.id = library_events.backup_run_id
        WHERE
          backup_runs.user_id = $1
          AND backup_runs.provider = 'spotify'
          AND backup_runs.source_type = 'liked_songs'
        GROUP BY library_events.provider_track_id
      )
      SELECT
        tracks.spotify_track_id,
        tracks.name,
        tracks.artists,
        tracks.album_name,
        tracks.duration_ms,
        tracks.popularity,
        tracks.explicit,
        tracks.preview_url,
        tracks.external_url,
        tracks.spotify_uri,
        tracks.image_url,
        tracks.isrc,
        tracks.spotify_added_at,
        tracks.first_backed_up_at,
        tracks.last_seen_at,
        provider_tracks.provider,
        provider_tracks.id AS provider_track_db_id,
        provider_tracks.canonical_track_id,
        COALESCE(event_stats.favorite_add_count, 0) AS favorite_add_count,
        COALESCE(event_stats.favorite_remove_count, 0) AS favorite_remove_count,
        event_stats.first_favorited_observed_at,
        event_stats.last_favorited_observed_at,
        event_stats.last_removed_observed_at,
        COALESCE(event_history.favorite_events, '[]'::jsonb) AS favorite_events,
        CASE
          WHEN (SELECT id FROM latest_run) IS NULL THEN TRUE
          ELSE current_items.provider_track_id IS NOT NULL
        END AS is_currently_saved
      FROM tracks
      LEFT JOIN provider_tracks
        ON provider_tracks.provider = 'spotify'
       AND provider_tracks.external_track_id = tracks.spotify_track_id
      LEFT JOIN current_items
        ON current_items.provider_track_id = provider_tracks.id
      LEFT JOIN event_stats
        ON event_stats.provider_track_id = provider_tracks.id
      LEFT JOIN event_history
        ON event_history.provider_track_id = provider_tracks.id
      WHERE tracks.user_id = $1
      ORDER BY is_currently_saved DESC, tracks.spotify_added_at DESC NULLS LAST, tracks.name ASC
      LIMIT 2000
    `,
    [userId],
  );

  return result.rows.map((row) => ({
    spotifyTrackId: row.spotify_track_id,
    name: row.name,
    artists: row.artists,
    album: row.album_name,
    durationMs: row.duration_ms,
    popularity: row.popularity,
    explicit: row.explicit,
    previewUrl: row.preview_url,
    externalUrl: row.external_url,
    spotifyUri: row.spotify_uri,
    imageUrl: row.image_url,
    isrc: row.isrc,
    spotifyAddedAt: row.spotify_added_at,
    firstBackedUpAt: row.first_backed_up_at,
    lastSeenAt: row.last_seen_at,
    provider: row.provider || spotifyProvider,
    providerTrackDbId: row.provider_track_db_id ? Number(row.provider_track_db_id) : null,
    canonicalTrackId: row.canonical_track_id ? Number(row.canonical_track_id) : null,
    favoriteAddCount: Math.max(Number(row.favorite_add_count || 0), 1),
    favoriteRemoveCount: Number(row.favorite_remove_count || 0),
    firstFavoritedObservedAt: row.first_favorited_observed_at,
    lastFavoritedObservedAt: row.last_favorited_observed_at,
    lastRemovedObservedAt: row.last_removed_observed_at,
    favoriteEvents: row.favorite_events || [],
    isCurrentlySaved: row.is_currently_saved,
  }));
}

export async function getLibrarySummary(userId) {
  const [
    { rows: countRows },
    { rows: currentRows },
    { rows: runRows },
    { rows: eventRows },
  ] = await Promise.all([
    getPool().query("SELECT COUNT(*)::int AS count FROM tracks WHERE user_id = $1", [userId]),
    getPool().query(
      `
        WITH latest_run AS (
          SELECT id
          FROM backup_runs
          WHERE
            user_id = $1
            AND provider = 'spotify'
            AND source_type = 'liked_songs'
            AND status = 'succeeded'
          ORDER BY finished_at DESC NULLS LAST, started_at DESC, id DESC
          LIMIT 1
        )
        SELECT
          (SELECT id FROM latest_run) AS run_id,
          (
            SELECT COUNT(*)::int
            FROM backup_run_items
            WHERE backup_run_id = (SELECT id FROM latest_run)
          ) AS count
      `,
      [userId],
    ),
    getPool().query(
      `
        SELECT finished_at, tracks_seen, status, error_message
        FROM backup_runs
        WHERE user_id = $1
        ORDER BY started_at DESC
        LIMIT 1
      `,
      [userId],
    ),
    getPool().query(
      `
        WITH stats AS (
          SELECT
            library_events.provider_track_id,
            COUNT(*) FILTER (WHERE event_type = 'added')::int AS add_count,
            COUNT(*) FILTER (WHERE event_type = 'removed')::int AS remove_count
          FROM library_events
          INNER JOIN backup_runs
            ON backup_runs.id = library_events.backup_run_id
          WHERE backup_runs.user_id = $1
          GROUP BY library_events.provider_track_id
        )
        SELECT
          COUNT(*) FILTER (WHERE add_count > 1)::int AS rediscovered_tracks,
          COUNT(*) FILTER (WHERE remove_count > 0)::int AS removed_tracks,
          COALESCE(SUM(add_count + remove_count), 0)::int AS lifecycle_events
        FROM stats
      `,
      [userId],
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
  };
}
