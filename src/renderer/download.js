// ─────────────────────────────────────────────────────────────────────────────
// download.js — Downloads page scaffold
// Engine (yt-dlp IPC, progress tracking, db queue) will be implemented later.
// ─────────────────────────────────────────────────────────────────────────────

function renderDownloads() {
  const container = document.getElementById('downloads-content');
  if (!container) return;

  container.innerHTML = `
    <div class="empty-state" style="margin-top: 60px;">
      <div class="empty-icon">
        <svg width="48" height="48" viewBox="0 0 16 16" fill="currentColor" style="opacity:0.4">
          <path d=".5 9.9a.5.5 0 01.5.5v2.5a1 1 0 001 1h12a1 1 0 001-1v-2.5a.5.5 0 011 0v2.5a2 2 0 01-2 2H2a2 2 0 01-2-2v-2.5a.5.5 0 01.5-.5z"/>
          <path d="M7.646 11.854a.5.5 0 00.708 0l3-3a.5.5 0 00-.708-.708L8.5 10.293V1.5a.5.5 0 00-1 0v8.793L5.354 8.146a.5.5 0 10-.708.708l3 3z"/>
        </svg>
      </div>
      <div class="empty-title">No downloads yet</div>
      <div class="empty-sub">Download VOD content to watch offline.<br>Browse Movies or Series and click the Download button.</div>
    </div>
  `;
}
