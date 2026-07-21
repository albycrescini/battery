"use client";

import {
  Activity,
  ArrowUpRight,
  Clock,
  Database,
  Heart,
  History,
  ListMusic,
  LogIn,
  LogOut,
  Music,
  RefreshCw,
  RotateCcw,
  Search,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

const emptySummary = {
  currentTotal: 0,
  total: 0,
  totalKnown: 0,
  lifecycleEvents: 0,
  rediscoveredTracks: 0,
  removedTracks: 0,
  lastBackupAt: null,
};

function formatDate(value) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatShortDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function formatDuration(ms) {
  if (!ms) return "";
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function daysBetween(startValue, endValue) {
  const start = startValue ? new Date(startValue).getTime() : null;
  const end = endValue ? new Date(endValue).getTime() : null;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return Math.max(1, Math.round((end - start) / 86_400_000));
}

function eventDate(event) {
  return event.providerEventAt || event.observedAt;
}

function eventTime(event) {
  const time = new Date(eventDate(event)).getTime();
  return Number.isFinite(time) ? time : null;
}

function lifecycleEvents(track, summary) {
  const events = Array.isArray(track.sourceEvents)
    ? track.sourceEvents
        .filter((event) => event && (event.type === "added" || event.type === "removed"))
        .map((event) => ({ ...event }))
    : [];
  const fallbackAddedAt =
    track.providerAddedAt ||
    track.firstAddedObservedAt ||
    track.firstBackedUpAt ||
    track.lastSeenAt ||
    summary.lastBackupAt ||
    new Date().toISOString();

  if (!events.some((event) => event.type === "added")) {
    events.unshift({
      type: "added",
      observedAt: fallbackAddedAt,
      providerEventAt: track.providerAddedAt || fallbackAddedAt,
    });
  }

  if (!track.isCurrentlySaved && !events.some((event) => event.type === "removed")) {
    events.push({
      type: "removed",
      observedAt: track.lastRemovedObservedAt || track.lastSeenAt || summary.lastBackupAt,
      providerEventAt: null,
    });
  }

  return events
    .filter((event) => eventTime(event) !== null)
    .sort((left, right) => eventTime(left) - eventTime(right));
}

function lifecycleLabel(track) {
  const addCount = Math.max(Number(track.sourceAddCount || 0), 1);
  const removeCount = Number(track.sourceRemoveCount || 0);
  if (addCount > 1) return `Re-added ${addCount - 1}x`;
  if (removeCount > 0) return "Removed once";
  return "Stable";
}

function timelineBounds(track, summary, events) {
  const times = events.map(eventTime).filter((time) => time !== null);
  const latestBackup = summary.lastBackupAt ? new Date(summary.lastBackupAt).getTime() : Date.now();
  const fallback = times[0] || latestBackup;
  let start = Math.min(...times, fallback);
  let end = Math.max(...times, latestBackup, fallback);

  if (end - start < 86_400_000) {
    start -= 43_200_000;
    end += 43_200_000;
  }

  return { start, end };
}

function timelineX(time, bounds, width, pad) {
  const clamped = Math.min(Math.max(time, bounds.start), bounds.end);
  return pad + ((clamped - bounds.start) / (bounds.end - bounds.start)) * (width - pad * 2);
}

function buildTimelineParts(track, summary, options) {
  const events = lifecycleEvents(track, summary);
  const width = options.width;
  const pad = options.pad;
  const laneY = options.laneY;
  const bounds = timelineBounds(track, summary, events);
  const segments = [];
  const markers = [];
  let active = false;
  let cursor = bounds.start;

  for (const event of events) {
    const time = eventTime(event);
    const x = timelineX(time, bounds, width, pad);
    const cursorX = timelineX(cursor, bounds, width, pad);

    if (x > cursorX) {
      segments.push({
        active,
        x1: cursorX,
        x2: x,
      });
    }

    markers.push({
      type: event.type,
      x,
    });
    active = event.type === "added";
    cursor = time;
  }

  const endX = timelineX(bounds.end, bounds, width, pad);
  const cursorX = timelineX(cursor, bounds, width, pad);
  if (endX > cursorX) {
    segments.push({
      active,
      x1: cursorX,
      x2: endX,
    });
  }

  return { bounds, events, markers, segments, laneY };
}

function TimelineLane({ track, summary, detailed = false }) {
  const width = detailed ? 760 : 244;
  const height = detailed ? 86 : 50;
  const pad = detailed ? 20 : 14;
  const laneY = detailed ? 36 : 23;
  const { bounds, markers, segments } = buildTimelineParts(track, summary, {
    width,
    height,
    pad,
    laneY,
  });

  return (
    <svg
      className={`timelineSvg${detailed ? " timelineSvgDetail" : ""}`}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={lifecycleLabel(track)}
      preserveAspectRatio="none"
    >
      <line className="baseSegment" x1={pad} y1={laneY} x2={width - pad} y2={laneY} />
      {segments.map((segment, index) => (
        <line
          key={`segment-${index}`}
          className={segment.active ? "activeSegment" : "awaySegment"}
          x1={segment.x1}
          y1={laneY}
          x2={segment.x2}
          y2={laneY}
        />
      ))}
      {markers.map((marker, index) => (
        <circle
          key={`marker-${index}`}
          className={marker.type === "added" ? "addMarker" : "removeMarker"}
          cx={marker.x}
          cy={laneY}
          r={detailed ? 6.5 : 5.5}
        />
      ))}
      {detailed ? (
        <>
          <text className="timelineDate" x={pad} y={height - 8}>
            {formatShortDate(bounds.start)}
          </text>
          <text className="timelineDate" x={width - pad} y={height - 8} textAnchor="end">
            {formatShortDate(bounds.end)}
          </text>
        </>
      ) : null}
    </svg>
  );
}

function computeAwayDays(events, untilValue) {
  let removedAt = null;
  let total = 0;

  for (const event of events) {
    const date = eventDate(event);
    if (event.type === "removed") {
      removedAt = date;
    } else if (removedAt) {
      total += daysBetween(removedAt, date);
      removedAt = null;
    }
  }

  if (removedAt && untilValue) {
    total += daysBetween(removedAt, untilValue);
  }

  return total;
}

function eventLabel(event, index) {
  if (event.type === "removed") return "Removed";
  return index === 0 ? "Added" : "Re-added";
}

function statusPill(track) {
  return track.isCurrentlySaved ? (
    <span className="statusPill active">Present</span>
  ) : (
    <span className="statusPill removed">Removed</span>
  );
}

function Cover({ track, size = "regular" }) {
  const letter = track?.name?.charAt(0) || "?";
  return (
    <div className={`cover ${size === "large" ? "coverLarge" : ""}`}>
      {track?.imageUrl ? <img src={track.imageUrl} alt="" /> : <span>{letter}</span>}
    </div>
  );
}

function Metric({ icon: Icon, label, value, tone = "plain" }) {
  return (
    <div className={`metric ${tone}`}>
      <Icon size={18} aria-hidden="true" />
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

function DetailPanel({ track, summary, onClose }) {
  if (!track) return null;

  const events = lifecycleEvents(track, summary);
  const addCount = Math.max(Number(track.sourceAddCount || 0), 1);
  const removeCount = Number(track.sourceRemoveCount || 0);
  const lastAdded = [...events].reverse().find((event) => event.type === "added");
  const lastChange = events[events.length - 1];
  const lastBackupAt = summary.lastBackupAt || new Date().toISOString();
  const currentStreak =
    track.isCurrentlySaved && lastAdded
      ? pluralize(daysBetween(eventDate(lastAdded), lastBackupAt), "day")
      : "Inactive";
  const awayDays = computeAwayDays(events, lastBackupAt);

  return (
    <aside className="detailPanel">
      <button className="iconButton detailClose" type="button" onClick={onClose} aria-label="Close details">
        <X size={17} aria-hidden="true" />
      </button>
      <div className="detailTopline">
        <div className="detailSong">
          <Cover track={track} size="large" />
          <div>
            <h3>{track.name}</h3>
            <p>{`${track.artists}${track.album ? ` - ${track.album}` : ""}`}</p>
          </div>
        </div>
        {statusPill(track)}
      </div>

      <div className="detailTimeline">
        <TimelineLane track={track} summary={summary} detailed />
        <ol className="eventList">
          {events.map((event, index) => (
            <li key={`${event.type}-${eventDate(event)}-${index}`}>
              <b>{eventLabel(event, index)}</b>
              <span>{formatShortDate(eventDate(event))}</span>
            </li>
          ))}
        </ol>
      </div>

      <dl className="detailStats">
        <div>
          <dt>Membership periods</dt>
          <dd>{addCount}</dd>
        </div>
        <div>
          <dt>Removals</dt>
          <dd>{removeCount}</dd>
        </div>
        <div>
          <dt>Current stretch</dt>
          <dd>{currentStreak}</dd>
        </div>
        <div>
          <dt>Time absent</dt>
          <dd>{awayDays ? pluralize(awayDays, "day") : "None"}</dd>
        </div>
        <div>
          <dt>Latest change</dt>
          <dd>{lastChange ? formatShortDate(eventDate(lastChange)) : "Unknown"}</dd>
        </div>
      </dl>
    </aside>
  );
}

function getUrlError() {
  const params = new URLSearchParams(window.location.search);
  const error = params.get("error");
  if (!error) return null;

  const messages = {
    spotify_not_configured:
      "Spotify app credentials are missing. Add them to .env, restart the server, then connect again.",
    state_mismatch: "Spotify login state did not match. Try connecting again.",
    missing_code: "Spotify did not return an authorization code. Try connecting again.",
    access_denied: "Spotify access was denied.",
  };

  window.history.replaceState({}, "", "/");
  return messages[error] || error;
}

function sourceTypeLabel(source) {
  if (!source) return "Source";
  if (source.sourceType === "liked_songs") return "Favorites";
  if (source.sourceType === "playlist") return "Playlist";
  return source.sourceType.replaceAll("_", " ");
}

function sourceIcon(source) {
  return source?.sourceType === "playlist" ? ListMusic : Heart;
}

function sourceAddedColumnLabel(source) {
  if (source?.sourceType === "liked_songs") return "Saved on provider";
  if (source?.sourceType === "playlist") return "Added to playlist";
  return "Added to source";
}

export default function HomePage() {
  const [session, setSession] = useState(null);
  const [sources, setSources] = useState([]);
  const [selectedSourceId, setSelectedSourceId] = useState(null);
  const [tracks, setTracks] = useState([]);
  const [summary, setSummary] = useState(emptySummary);
  const [query, setQuery] = useState("");
  const [selectedTrackId, setSelectedTrackId] = useState(null);
  const [notice, setNotice] = useState("");
  const [noticeVariant, setNoticeVariant] = useState("info");
  const [syncing, setSyncing] = useState(false);

  const filteredTracks = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return tracks;
    return tracks.filter((track) =>
      `${track.name} ${track.artists} ${track.album || ""}`.toLowerCase().includes(normalized),
    );
  }, [query, tracks]);

  const selectedTrack = useMemo(
    () => tracks.find((track) => track.id === selectedTrackId) || null,
    [selectedTrackId, tracks],
  );

  const currentTotal = summary.currentTotal ?? summary.total ?? 0;
  const knownTotal = summary.totalKnown ?? currentTotal;
  const authenticated = Boolean(session?.authenticated);
  const currentSource = useMemo(
    () => sources.find((source) => source.id === selectedSourceId) || summary.selectedSource || null,
    [selectedSourceId, sources, summary.selectedSource],
  );
  const connectionLabel = authenticated
    ? session.user?.displayName || session.user?.spotifyUserId
    : "Not connected";

  function setDashboardPayload(library) {
    const nextTracks = library.tracks || [];
    setTracks(nextTracks);
    setSummary({ ...emptySummary, ...library });
    setSelectedTrackId((current) => {
      if (nextTracks.some((track) => track.id === current)) return current;
      const fallback =
        nextTracks.find((track) => Number(track.sourceAddCount || 0) > 1) ||
        nextTracks.find((track) => Number(track.sourceRemoveCount || 0) > 0) ||
        nextTracks[0];
      return fallback?.id || null;
    });
  }

  async function fetchLibraryForSource(sourceId) {
    const suffix = sourceId ? `?sourceId=${encodeURIComponent(sourceId)}` : "";
    const response = await fetch(`/api/tracks${suffix}`);
    const library = await response.json();
    if (!response.ok) throw new Error(library.error || "Could not load source history");
    return library;
  }

  async function loadLibraryForSource(sourceId) {
    const library = await fetchLibraryForSource(sourceId);
    setDashboardPayload(library);
    setSelectedSourceId(library.selectedSource?.id || sourceId || null);
    return library;
  }

  useEffect(() => {
    let cancelled = false;

    async function loadDashboard() {
      const sessionResponse = await fetch("/api/session");
      const nextSession = await sessionResponse.json();
      let nextSources = [];
      let discoveryError = null;

      if (nextSession.authenticated) {
        const sourceResponse = await fetch("/api/library-sources");
        const sourcePayload = await sourceResponse.json();
        if (!sourceResponse.ok) throw new Error(sourcePayload.error || "Could not load sources");
        nextSources = sourcePayload.sources || [];
        discoveryError = sourcePayload.discoveryError || null;
      }

      const initialSourceId = nextSources[0]?.id || null;
      const library = await fetchLibraryForSource(initialSourceId);
      if (cancelled) return;

      setSession(nextSession);
      setSources(nextSources);
      setSelectedSourceId(library.selectedSource?.id || initialSourceId);
      setDashboardPayload(library);

      const setupMessage = !nextSession.databaseReady
        ? "Postgres is not connected. Start the local database container and refresh."
        : !nextSession.spotifyConfigured
          ? "Spotify credentials are not configured for this local server."
          : "";
      const urlError = getUrlError();
      const message =
        urlError ||
        setupMessage ||
        (discoveryError ? `Source discovery failed: ${discoveryError}. Reconnect Spotify if playlist access was added recently.` : "") ||
        (library.lastBackupError ? `Last backup failed: ${library.lastBackupError}` : "");
      setNotice(message);
      setNoticeVariant(message ? "error" : "info");
    }

    loadDashboard().catch((error) => {
      if (!cancelled) {
        setNotice(error.message);
        setNoticeVariant("error");
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  async function selectSource(sourceId) {
    setSelectedSourceId(sourceId);
    setSelectedTrackId(null);
    setQuery("");
    setNotice("");

    try {
      await loadLibraryForSource(sourceId);
    } catch (error) {
      setNotice(error.message);
      setNoticeVariant("error");
    }
  }

  async function backupSelectedSource() {
    if (!selectedSourceId) return;

    setSyncing(true);
    setNotice(`Reading ${currentSource?.name || "selected source"} and saving it locally.`);
    setNoticeVariant("info");

    try {
      const response = await fetch(`/api/backup/source?sourceId=${encodeURIComponent(selectedSourceId)}`, {
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Backup failed");

      if (payload.sources) setSources(payload.sources);
      setSelectedSourceId(payload.selectedSource?.id || selectedSourceId);
      setDashboardPayload(payload);
      setNotice("");
    } catch (error) {
      setNotice(error.message);
      setNoticeVariant("error");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <main className="appShell">
      <section className="topBar">
        <div className="brandLockup">
          <div className="brandMark">
            <Music size={22} aria-hidden="true" />
          </div>
          <div>
            <p>Music Backup</p>
            <span>{connectionLabel}</span>
          </div>
        </div>
        <div className="topActions">
          <button
            className="button secondaryButton"
            type="button"
            onClick={() => {
              window.location.href = "/auth/login";
            }}
            disabled={session && !session.spotifyConfigured}
          >
            <LogIn size={17} aria-hidden="true" />
            <span>{authenticated ? "Switch Spotify" : "Connect Spotify"}</span>
          </button>
          {authenticated ? (
            <button
              className="iconButton"
              type="button"
              onClick={() => {
                window.location.href = "/auth/logout";
              }}
              aria-label="Disconnect"
            >
              <LogOut size={18} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </section>

      <section className="heroBand">
        <div>
          <p className="eyebrow">Library timeline</p>
          <h1>Favorites and playlists, ready for every provider.</h1>
        </div>
        <div className="heroStatus">
          <span>Last backup</span>
          <strong>{formatDate(summary.lastBackupAt)}</strong>
        </div>
      </section>

      <section className="workspace">
        <aside className="sideRail">
          <button
            className="button primaryButton"
            type="button"
            onClick={backupSelectedSource}
            disabled={!authenticated || !selectedSourceId || syncing}
          >
            <RefreshCw className={syncing ? "spin" : ""} size={18} aria-hidden="true" />
            <span>{syncing ? "Backing up" : "Back up selected source"}</span>
          </button>

          <div className="sourcePicker" aria-label="History source">
            <div className="sourcePickerHeader">
              <span>History source</span>
              <strong>{sources.length}</strong>
            </div>
            {sources.length ? (
              sources.map((source) => {
                const Icon = sourceIcon(source);
                const selected = source.id === selectedSourceId;
                return (
                  <button
                    key={source.id}
                    className={`sourceOption${selected ? " selected" : ""}`}
                    type="button"
                    onClick={() => selectSource(source.id)}
                    aria-pressed={selected}
                  >
                    <Icon size={17} aria-hidden="true" />
                    <span>
                      <b>{source.name}</b>
                      <small>
                        {sourceTypeLabel(source)} - {source.provider}
                      </small>
                    </span>
                  </button>
                );
              })
            ) : (
              <p className="sourceEmpty">Connect Spotify to discover favorites and playlists.</p>
            )}
          </div>

          {notice ? <p className={`notice ${noticeVariant}`}>{notice}</p> : null}

          <div className="metricStack">
            <Metric icon={Heart} label="Current in source" value={currentTotal} tone="green" />
            <Metric icon={Database} label="Known in source" value={knownTotal} />
            <Metric icon={Activity} label="Lifecycle events" value={summary.lifecycleEvents || 0} />
            <Metric icon={Clock} label="Last backup" value={formatDate(summary.lastBackupAt)} />
          </div>
        </aside>

        <section className="libraryPane">
          <div className="libraryHeader">
            <div>
              <p className="sectionLabel">Song history</p>
              <h2>{currentSource?.name || "Source lifecycle"}</h2>
              <span className="sourceMeta">
                {currentSource
                  ? `${sourceTypeLabel(currentSource)} - ${currentSource.provider}`
                  : "No source selected"}
              </span>
            </div>
            <label className="searchBox">
              <Search size={17} aria-hidden="true" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                type="search"
                placeholder="Search songs or artists"
              />
            </label>
          </div>

          <div className="insightStrip" aria-live="polite">
            <Metric icon={RotateCcw} label="Re-added" value={summary.rediscoveredTracks || 0} />
            <Metric icon={History} label="Removed" value={summary.removedTracks || 0} tone="amber" />
            <Metric icon={Heart} label="Currently present" value={currentTotal} tone="green" />
          </div>

          <DetailPanel
            track={selectedTrack}
            summary={summary}
            onClose={() => setSelectedTrackId(null)}
          />

          <div className="tableWrap">
            <table>
              <thead>
                <tr>
                  <th>Song</th>
                  <th>Artist</th>
                  <th>Album</th>
                  <th>{sourceAddedColumnLabel(currentSource)}</th>
                  <th>Status</th>
                  <th>Lifecycle</th>
                </tr>
              </thead>
              <tbody>
                {filteredTracks.length ? (
                  filteredTracks.map((track) => (
                    <tr
                      key={track.id}
                      className={track.id === selectedTrackId ? "selected" : ""}
                      onClick={() => setSelectedTrackId(track.id)}
                    >
                      <td>
                        <div className="songCell">
                          <Cover track={track} />
                          <div>
                            {track.externalUrl ? (
                              <a
                                href={track.externalUrl}
                                target="_blank"
                                rel="noreferrer"
                                onClick={(event) => event.stopPropagation()}
                              >
                                <span>{track.name}</span>
                                <ArrowUpRight size={13} aria-hidden="true" />
                              </a>
                            ) : (
                              <strong>{track.name}</strong>
                            )}
                            <div className="meta">{formatDuration(track.durationMs)}</div>
                          </div>
                        </div>
                      </td>
                      <td>{track.artists}</td>
                      <td>{track.album || ""}</td>
                      <td>{track.providerAddedAt ? formatDate(track.providerAddedAt) : ""}</td>
                      <td>{statusPill(track)}</td>
                      <td>
                        <div className="lifecycle">
                          <TimelineLane track={track} summary={summary} />
                          <span>{lifecycleLabel(track)}</span>
                        </div>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={6} className="empty">
                      {tracks.length
                        ? "No matching songs."
                        : "No backup has been saved for this source yet."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </section>
    </main>
  );
}
