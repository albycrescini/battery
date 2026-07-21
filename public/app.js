const state = {
  tracks: [],
  filteredTracks: [],
  summary: {},
  selectedTrackId: null,
};

const elements = {
  connectionStatus: document.querySelector("#connectionStatus"),
  loginButton: document.querySelector("#loginButton"),
  syncButton: document.querySelector("#syncButton"),
  logoutButton: document.querySelector("#logoutButton"),
  notice: document.querySelector("#notice"),
  trackCount: document.querySelector("#trackCount"),
  knownTrackCount: document.querySelector("#knownTrackCount"),
  lifecycleEventCount: document.querySelector("#lifecycleEventCount"),
  rediscoveredCount: document.querySelector("#rediscoveredCount"),
  removedTrackCount: document.querySelector("#removedTrackCount"),
  currentTrackCount: document.querySelector("#currentTrackCount"),
  lastBackup: document.querySelector("#lastBackup"),
  librarySubhead: document.querySelector("#librarySubhead"),
  trackDetail: document.querySelector("#trackDetail"),
  detailClose: document.querySelector("#detailClose"),
  detailCover: document.querySelector("#detailCover"),
  detailTitle: document.querySelector("#detailTitle"),
  detailMeta: document.querySelector("#detailMeta"),
  detailStatus: document.querySelector("#detailStatus"),
  detailTimeline: document.querySelector("#detailTimeline"),
  detailStats: document.querySelector("#detailStats"),
  trackTable: document.querySelector("#trackTable"),
  searchInput: document.querySelector("#searchInput"),
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

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showNotice(message, variant = "info") {
  elements.notice.textContent = message;
  elements.notice.hidden = !message;
  elements.notice.classList.toggle("error", variant === "error");
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

function renderSummary(summary = {}) {
  const currentTotal = summary.currentTotal ?? summary.total ?? 0;
  const knownTotal = summary.totalKnown ?? currentTotal;
  const lifecycleEvents = summary.lifecycleEvents ?? 0;
  const rediscoveredTracks = summary.rediscoveredTracks ?? 0;
  const removedTracks = summary.removedTracks ?? 0;

  elements.trackCount.textContent = String(currentTotal);
  elements.knownTrackCount.textContent = String(knownTotal);
  elements.lifecycleEventCount.textContent = String(lifecycleEvents);
  elements.rediscoveredCount.textContent = String(rediscoveredTracks);
  elements.removedTrackCount.textContent = String(removedTracks);
  elements.currentTrackCount.textContent = String(currentTotal);
}

function eventDate(event) {
  return event.providerEventAt || event.observedAt;
}

function eventTime(event) {
  const time = new Date(eventDate(event)).getTime();
  return Number.isFinite(time) ? time : null;
}

function lifecycleEvents(track) {
  const events = Array.isArray(track.favoriteEvents)
    ? track.favoriteEvents
        .filter((event) => event && (event.type === "added" || event.type === "removed"))
        .map((event) => ({ ...event }))
    : [];
  const fallbackAddedAt =
    track.spotifyAddedAt ||
    track.firstFavoritedObservedAt ||
    track.firstBackedUpAt ||
    track.lastSeenAt ||
    state.summary.lastBackupAt ||
    new Date().toISOString();

  if (!events.some((event) => event.type === "added")) {
    events.unshift({
      type: "added",
      observedAt: fallbackAddedAt,
      providerEventAt: track.spotifyAddedAt || fallbackAddedAt,
    });
  }

  if (!track.isCurrentlySaved && !events.some((event) => event.type === "removed")) {
    events.push({
      type: "removed",
      observedAt: track.lastRemovedObservedAt || track.lastSeenAt || state.summary.lastBackupAt,
      providerEventAt: null,
    });
  }

  return events
    .filter((event) => eventTime(event) !== null)
    .sort((left, right) => eventTime(left) - eventTime(right));
}

function timelineBounds(track, events) {
  const times = events.map(eventTime).filter((time) => time !== null);
  const latestBackup = state.summary.lastBackupAt
    ? new Date(state.summary.lastBackupAt).getTime()
    : Date.now();
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

function lifecycleLabel(track) {
  const addCount = Math.max(Number(track.favoriteAddCount || 0), 1);
  const removeCount = Number(track.favoriteRemoveCount || 0);
  if (addCount > 1) return `Rediscovered ${addCount - 1}x`;
  if (removeCount > 0) return "Removed once";
  return "Stable";
}

function renderTimelineSvg(track, options = {}) {
  const events = lifecycleEvents(track);
  const width = options.width || 230;
  const height = options.height || 52;
  const pad = options.pad || 12;
  const laneY = options.laneY || 24;
  const bounds = timelineBounds(track, events);
  const segments = [];
  const markers = [];
  let active = false;
  let cursor = bounds.start;

  for (const event of events) {
    const time = eventTime(event);
    const x = timelineX(time, bounds, width, pad);
    const cursorX = timelineX(cursor, bounds, width, pad);

    if (x > cursorX) {
      const className = active ? "activeSegment" : "awaySegment";
      segments.push(
        `<line class="${className}" x1="${cursorX.toFixed(1)}" y1="${laneY}" x2="${x.toFixed(
          1,
        )}" y2="${laneY}" />`,
      );
    }

    if (event.type === "added") {
      markers.push(`<circle class="addMarker" cx="${x.toFixed(1)}" cy="${laneY}" r="5.5" />`);
      active = true;
    } else {
      markers.push(`<circle class="removeMarker" cx="${x.toFixed(1)}" cy="${laneY}" r="5.5" />`);
      active = false;
    }

    cursor = time;
  }

  const endX = timelineX(bounds.end, bounds, width, pad);
  const cursorX = timelineX(cursor, bounds, width, pad);
  if (endX > cursorX) {
    const className = active ? "activeSegment" : "awaySegment";
    segments.push(
      `<line class="${className}" x1="${cursorX.toFixed(1)}" y1="${laneY}" x2="${endX.toFixed(
        1,
      )}" y2="${laneY}" />`,
    );
  }

  const axisLabels = options.labels
    ? `
      <text class="timelineDate" x="${pad}" y="${height - 4}">${escapeHtml(
        formatShortDate(bounds.start),
      )}</text>
      <text class="timelineDate" x="${width - pad}" y="${height - 4}" text-anchor="end">${escapeHtml(
        formatShortDate(bounds.end),
      )}</text>
    `
    : "";

  return `
    <svg class="timelineSvg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(
      lifecycleLabel(track),
    )}" preserveAspectRatio="none">
      <line class="baseSegment" x1="${pad}" y1="${laneY}" x2="${width - pad}" y2="${laneY}" />
      ${segments.join("")}
      ${markers.join("")}
      ${axisLabels}
    </svg>
  `;
}

function renderLifecycle(track) {
  const addCount = Math.max(Number(track.favoriteAddCount || 0), 1);
  const removeCount = Number(track.favoriteRemoveCount || 0);
  const details = [
    pluralize(addCount, "add"),
    pluralize(removeCount, "removal", "removals"),
  ].join(", ");

  return `
    <div class="lifecycle" title="${escapeHtml(details)}">
      ${renderTimelineSvg(track)}
      <span>${escapeHtml(lifecycleLabel(track))}</span>
    </div>
  `;
}

function eventLabel(event, index) {
  if (event.type === "removed") return "Removed by";
  return index === 0 ? "Added" : "Re-added";
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

function renderDetail(track) {
  if (!track) {
    elements.trackDetail.hidden = true;
    return;
  }

  const events = lifecycleEvents(track);
  const addCount = Math.max(Number(track.favoriteAddCount || 0), 1);
  const removeCount = Number(track.favoriteRemoveCount || 0);
  const lastAdded = [...events].reverse().find((event) => event.type === "added");
  const lastChange = events[events.length - 1];
  const lastBackupAt = state.summary.lastBackupAt || new Date().toISOString();
  const currentStreak = track.isCurrentlySaved && lastAdded
    ? pluralize(daysBetween(eventDate(lastAdded), lastBackupAt), "day")
    : "Inactive";
  const awayDays = computeAwayDays(events, lastBackupAt);

  elements.detailCover.innerHTML = track.imageUrl
    ? `<img src="${escapeHtml(track.imageUrl)}" alt="" />`
    : `<span>${escapeHtml(track.name.charAt(0) || "?")}</span>`;
  elements.detailTitle.textContent = track.name;
  elements.detailMeta.textContent = `${track.artists}${track.album ? ` - ${track.album}` : ""}`;
  elements.detailStatus.innerHTML = track.isCurrentlySaved
    ? '<span class="statusPill active">Current</span>'
    : '<span class="statusPill removed">Removed</span>';
  elements.detailTimeline.innerHTML = `
    ${renderTimelineSvg(track, { width: 720, height: 78, pad: 18, laneY: 34, labels: true })}
    <ol class="eventList">
      ${events
        .map(
          (event, index) => `
            <li>
              <b>${escapeHtml(eventLabel(event, index))}</b>
              <span>${escapeHtml(formatShortDate(eventDate(event)))}</span>
            </li>
          `,
        )
        .join("")}
    </ol>
  `;
  elements.detailStats.innerHTML = `
    <div>
      <dt>Favorite periods</dt>
      <dd>${addCount}</dd>
    </div>
    <div>
      <dt>Removals</dt>
      <dd>${removeCount}</dd>
    </div>
    <div>
      <dt>Current streak</dt>
      <dd>${escapeHtml(currentStreak)}</dd>
    </div>
    <div>
      <dt>Time away</dt>
      <dd>${awayDays ? escapeHtml(pluralize(awayDays, "day")) : "None"}</dd>
    </div>
    <div>
      <dt>Latest change</dt>
      <dd>${lastChange ? escapeHtml(formatShortDate(eventDate(lastChange))) : "Unknown"}</dd>
    </div>
  `;
  elements.trackDetail.hidden = false;
}

function selectTrack(trackId) {
  const track = state.tracks.find((item) => item.spotifyTrackId === trackId);
  if (!track) return;
  state.selectedTrackId = track.spotifyTrackId;
  renderDetail(track);
  renderTracks();
}

function syncSelectedTrack() {
  if (!state.tracks.length) {
    state.selectedTrackId = null;
    renderDetail(null);
    return;
  }

  const selected = state.tracks.find((track) => track.spotifyTrackId === state.selectedTrackId);
  const fallback =
    selected ||
    state.tracks.find((track) => Number(track.favoriteAddCount || 0) > 1) ||
    state.tracks.find((track) => Number(track.favoriteRemoveCount || 0) > 0) ||
    state.tracks[0];
  state.selectedTrackId = fallback.spotifyTrackId;
  renderDetail(fallback);
}

function renderTracks() {
  if (!state.filteredTracks.length) {
    const emptyText = state.tracks.length
      ? "No matching songs in this backup."
      : "No backup has been saved yet.";
    elements.trackTable.innerHTML = `<tr><td colspan="6" class="empty">${emptyText}</td></tr>`;
    return;
  }

  elements.trackTable.innerHTML = state.filteredTracks
    .map((track) => {
      const cover = track.imageUrl
        ? `<img src="${escapeHtml(track.imageUrl)}" alt="" loading="lazy" />`
        : `<span class="coverFallback">${escapeHtml(track.name.charAt(0) || "?")}</span>`;
      const title = escapeHtml(track.name);
      const titleContent = track.externalUrl
        ? `<a href="${escapeHtml(track.externalUrl)}" target="_blank" rel="noreferrer">${title}</a>`
        : `<strong>${title}</strong>`;
      const duration = formatDuration(track.durationMs);
      const status = track.isCurrentlySaved
        ? '<span class="statusPill active">Current</span>'
        : '<span class="statusPill removed">Removed</span>';
      const selected = track.spotifyTrackId === state.selectedTrackId ? " selected" : "";

      return `
        <tr class="trackRow${selected}" data-track-id="${escapeHtml(track.spotifyTrackId)}" tabindex="0">
          <td>
            <div class="songCell">
              ${cover}
              <div>
                ${titleContent}
                <div class="meta">${duration}</div>
              </div>
            </div>
          </td>
          <td>${escapeHtml(track.artists)}</td>
          <td>${escapeHtml(track.album || "")}</td>
          <td>${track.spotifyAddedAt ? formatDate(track.spotifyAddedAt) : ""}</td>
          <td>${status}</td>
          <td>${renderLifecycle(track)}</td>
        </tr>
      `;
    })
    .join("");
}

async function loadDashboard() {
  const [sessionResponse, trackResponse] = await Promise.all([
    fetch("/api/session"),
    fetch("/api/tracks"),
  ]);
  const session = await sessionResponse.json();
  const library = await trackResponse.json();
  const urlError = getUrlError();

  elements.connectionStatus.textContent = session.authenticated
    ? `Connected as ${session.user.displayName || session.user.spotifyUserId}`
    : "Not connected";
  elements.loginButton.textContent = session.authenticated
    ? "Switch Spotify account"
    : "Connect Spotify";
  elements.loginButton.disabled = !session.spotifyConfigured;
  elements.syncButton.disabled = !session.authenticated;
  elements.logoutButton.hidden = !session.authenticated;
  elements.librarySubhead.textContent = session.authenticated
    ? "Back up your saved songs, then filter the local copy."
    : "Connect Spotify to create the first backup.";
  const setupMessage = !session.databaseReady
    ? "Postgres is not connected. Start the local database container and refresh."
    : !session.spotifyConfigured
      ? "Spotify credentials are not configured for this local server."
      : "";
  showNotice(
    urlError ||
      (setupMessage
        ? setupMessage
        : library.lastBackupError
          ? `Last backup failed: ${library.lastBackupError}`
          : ""),
    urlError || setupMessage || library.lastBackupError ? "error" : "info",
  );

  state.tracks = library.tracks || [];
  state.filteredTracks = state.tracks;
  state.summary = library;
  elements.lastBackup.textContent = formatDate(library.lastBackupAt);
  renderSummary(library);
  syncSelectedTrack();
  renderTracks();
}

elements.loginButton.addEventListener("click", () => {
  window.location.href = "/auth/login";
});

elements.logoutButton.addEventListener("click", () => {
  window.location.href = "/auth/logout";
});

elements.syncButton.addEventListener("click", async () => {
  elements.syncButton.disabled = true;
  elements.syncButton.textContent = "Backing up...";
  showNotice("Reading liked songs from Spotify and saving them locally.");

  try {
    const response = await fetch("/api/backup/liked-songs", { method: "POST" });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Backup failed");
    }

    state.tracks = payload.tracks || [];
    state.filteredTracks = state.tracks;
    state.summary = payload;
    elements.lastBackup.textContent = formatDate(payload.lastBackupAt);
    elements.librarySubhead.textContent = `Last backup saved ${payload.lastBackupTracksSeen} liked songs.`;
    renderSummary(payload);
    syncSelectedTrack();
    showNotice("");
    renderTracks();
  } catch (error) {
    showNotice(error.message, "error");
  } finally {
    elements.syncButton.disabled = false;
    elements.syncButton.textContent = "Back up liked songs";
  }
});

elements.searchInput.addEventListener("input", (event) => {
  const query = event.target.value.trim().toLowerCase();
  state.filteredTracks = query
    ? state.tracks.filter((track) =>
        `${track.name} ${track.artists} ${track.album}`.toLowerCase().includes(query),
      )
    : state.tracks;
  renderTracks();
});

elements.trackTable.addEventListener("click", (event) => {
  if (event.target.closest("a")) return;
  const row = event.target.closest(".trackRow");
  if (!row) return;
  selectTrack(row.dataset.trackId);
});

elements.trackTable.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const row = event.target.closest(".trackRow");
  if (!row) return;
  event.preventDefault();
  selectTrack(row.dataset.trackId);
});

elements.detailClose.addEventListener("click", () => {
  state.selectedTrackId = null;
  renderDetail(null);
  renderTracks();
});

loadDashboard().catch((error) => {
  showNotice(error.message, "error");
});
