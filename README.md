# Music Backup

Local MVP for backing up music collections into Postgres and viewing source
membership history in a Next.js web UI. Spotify is the first implemented
provider, with support for Favorites and playlists.

## What Works

- Spotify OAuth login using the Authorization Code flow.
- `user-library-read`, `playlist-read-private`, and
  `playlist-read-collaborative` access for the current user's Spotify sources.
- Source discovery for Spotify Favorites and current-user playlists.
- On-demand backup of a selected source from `GET /v1/me/tracks` or
  `GET /v1/playlists/{playlist_id}/tracks`.
- Postgres persistence for users, provider accounts, encrypted Spotify tokens,
  provider-neutral track identity, backup snapshots, and lifecycle events.
- A modern Next.js dashboard for connection status, sync status, track count,
  source selection, last backup, lifecycle timelines, search, album, artist, and
  source-added metadata.

Scheduled backups and export/import to other platforms are intentionally left for
the next iteration.

## Multi-Provider Backup Plan

The storage layer is now designed around provider-agnostic snapshots:

- `provider_accounts` stores credentials and profile metadata per connected
  platform.
- `library_sources` identifies the backed-up collection, such as Favorites or a
  playlist, under a provider account.
- `canonical_tracks` stores cross-provider song identity. ISRC is preferred, with
  normalized metadata as a fallback match key.
- `provider_tracks` stores provider-specific IDs, URLs, artwork, and raw
  provider metadata for a canonical track.
- `backup_runs` records each snapshot attempt for a library source.
- `backup_run_items` records exact membership for a run.
- `library_events` stores derived `added` and `removed` observations by diffing a
  successful run against the previous successful run for the same source.

That model supports the lifecycle UI: stable source membership has one add
event, removed songs have remove events, and re-added songs have multiple add
events. It also creates the base for future transfer workflows because Spotify,
Apple Music, YouTube Music, or other provider IDs can map to the same canonical
track.

To add a provider, implement an adapter that:

1. Authenticates the account and writes `provider_accounts`.
2. Creates one or more `library_sources`.
3. Normalizes provider track payloads into canonical metadata plus a provider
   track ID.
4. Writes each backup into `backup_runs` and `backup_run_items`.
5. Calls the lifecycle diff step after a successful snapshot.

## Prerequisites

- Node.js 20 or newer.
- pnpm, npm, or another Node package manager.
- Docker with Docker Compose.
- A Spotify developer app.

## Local Setup

1. Install dependencies.

   ```bash
   pnpm install
   ```

2. Create a local environment file.

   ```bash
   cp .env.example .env
   ```

3. Create a Spotify app at <https://developer.spotify.com/dashboard> and add
   this redirect URI in the app settings:

   ```text
   http://127.0.0.1:3000/auth/callback
   ```

   Spotify requires redirect URIs to match exactly. For local development, use
   the loopback IP form (`127.0.0.1`) rather than `localhost`.

4. Fill these values in `.env`.

   ```text
   SPOTIFY_CLIENT_ID=
   SPOTIFY_CLIENT_SECRET=
   SESSION_SECRET=
   ```

5. Start Postgres.

   ```bash
   pnpm run db:up
   ```

6. Run the migration.

   ```bash
   pnpm run db:migrate
   ```

7. Start the app.

   ```bash
   pnpm run dev
   ```

8. Open <http://127.0.0.1:3000>.

## Useful Commands

```bash
docker compose ps
docker compose logs db
pnpm run db:up
pnpm run db:migrate
pnpm run dev
pnpm run build
```

## Notes

- Tokens are encrypted at rest with `SESSION_SECRET`. Changing that value will
  invalidate stored token ciphertext, so users will need to reconnect Spotify.
- The server retries database setup lazily. If the web UI starts before Postgres,
  start the container and refresh the page.
- The default Postgres credentials are local-development only.
