const API = location.port === '5500' ? 'http://localhost:8000' : '';
const $ = (s) => document.querySelector(s);

const state = { info: null, mode: 'video', quality: null, abr: 192, job: null, timer: null, blobUrl: null, fileUrl: null };

/* ---------- helpers ---------- */
const platformOf = (u) => {
  u = (u || '').toLowerCase();
  if (u.includes('tiktok.com')) return 'tiktok';
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube';
  if (u.includes('facebook.com') || u.includes('fb.watch') || u.includes('fb.com')) return 'facebook';
  if (u.includes('instagram.com')) return 'instagram';
  if (u.includes('twitter.com') || u.includes('x.com')) return 'x';
  return null;
};
const fmtDur = (s) => {
  if (!s && s !== 0) return '';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
};
const toHMS = (s) => { s = Math.round(s); return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':'); };
const fmtBytes = (b) => { if (!b) return ''; const u = ['B', 'KB', 'MB', 'GB']; let i = 0; while (b >= 1024 && i < 3) { b /= 1024; i++; } return b.toFixed(i ? 1 : 0) + ' ' + u[i]; };
const fmtNum = (n) => (n == null ? '' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n));
const showError = (msg) => { const e = $('#errorBox'); e.textContent = msg; e.hidden = !msg; };

async function api(path, body) {
  const res = await fetch(API + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) throw new Error((data && data.detail) || `Server error (${res.status})`);
  return data;
}

/* ---------- theme ---------- */
$('#themeBtn').addEventListener('click', () => {
  const r = document.documentElement;
  r.dataset.theme = r.dataset.theme === 'dark' ? 'light' : 'dark';
});

/* ---------- health ---------- */
api('/api/health').then((h) => { $('#srvVer').textContent = 'engine ' + h.yt_dlp; })
  .catch(() => { document.querySelector('.dot').classList.add('off'); document.querySelector('.eyebrow').lastChild.textContent = ' Server offline — start the backend'; });

/* ---------- platform detection ---------- */
const input = $('#urlInput');
function syncPlatform() {
  const p = platformOf(input.value);
  document.querySelectorAll('#platChips .chip').forEach((c) => c.classList.toggle('on', c.dataset.p === p));
  $('#platIco').classList.toggle('on', !!p);
}
input.addEventListener('input', syncPlatform);
$('#pasteBtn').addEventListener('click', async () => {
  try { input.value = (await navigator.clipboard.readText()).trim(); syncPlatform(); input.focus(); }
  catch { input.focus(); showError('Clipboard access was blocked — long-press the box and choose Paste.'); }
});

/* ---------- fetch info ---------- */
$('#grabForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = input.value.trim();
  if (!url) return;
  showError('');
  resetJob();
  const go = $('#goBtn');
  go.disabled = true; go.classList.add('loading'); go.querySelector('.go-label').textContent = 'Reading…';
  $('#panel').hidden = false; $('#skeleton').hidden = false; $('#result').hidden = true;
  try {
    const info = await api('/api/info', { url });
    state.info = info;
    renderInfo(info);
  } catch (err) {
    $('#panel').hidden = true;
    showError(err.message);
  } finally {
    go.disabled = false; go.classList.remove('loading'); go.querySelector('.go-label').textContent = 'Fetch video';
  }
});

function renderInfo(info) {
  $('#skeleton').hidden = true; $('#result').hidden = false;
  const img = $('#thumb');
  img.hidden = !info.thumbnail;
  img.src = info.thumbnail ? `${API}/api/thumb?u=${encodeURIComponent(info.thumbnail)}` : '';
  img.alt = info.title;
  img.onerror = () => { img.hidden = true; };
  $('#durBadge').textContent = fmtDur(info.duration);
  $('#durBadge').hidden = !info.duration;
  $('#platBadge').textContent = info.platform === 'other' ? (info.extractor || 'video') : info.platform;
  $('#title').textContent = info.title;
  const bits = [info.uploader && '@' + info.uploader.replace(/^@/, ''), info.views != null && fmtNum(info.views) + ' views', info.likes != null && fmtNum(info.likes) + ' likes',
    info.upload_date && info.upload_date.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')].filter(Boolean);
  $('#sub').textContent = bits.join(' · ');
  $('#wmTog').hidden = info.platform !== 'tiktok';

  // qualities (dedupe by label, keep highest height for each)
  const seen = new Set();
  const qs = info.qualities.filter((q) => (seen.has(q.label) ? false : seen.add(q.label)));
  const grid = $('#qgrid');
  grid.innerHTML = '';
  const mk = (q, i) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'q'; b.dataset.h = q ? q.height : '';
    const n = q ? parseInt(q.label) : 0;
    const tag = n >= 2160 ? '4K' : n >= 1440 ? '2K' : n >= 1080 ? 'FHD' : n >= 720 ? 'HD' : '';
    b.innerHTML = q ? `<span>${q.label}${tag ? ' <span class="tag">' + tag + '</span>' : ''}</span><small>${q.size ? '~' + fmtBytes(q.size) : 'mp4'}</small>` : '<span>Best</span><small>auto</small>';
    b.setAttribute('aria-pressed', i === 0 ? 'true' : 'false');
    b.addEventListener('click', () => { grid.querySelectorAll('.q').forEach((x) => x.setAttribute('aria-pressed', 'false')); b.setAttribute('aria-pressed', 'true'); state.quality = q ? q.height : null; });
    grid.appendChild(b);
  };
  if (qs.length) qs.forEach((q, i) => mk(q, i)); else mk(null, 0);
  state.quality = qs.length ? qs[0].height : null;

  // trim defaults
  $('#tStart').value = '00:00:00';
  $('#tEnd').value = toHMS(info.duration ? Math.min(info.duration, 30) : 30);
  setMode('video');
  $('#panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ---------- options ---------- */
function setMode(m) {
  state.mode = m;
  document.querySelectorAll('#modeSeg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === m)));
  $('#qualityOpt').hidden = m !== 'video';
  $('#abrOpt').hidden = m !== 'audio';
  if (state.info) $('#wmTog').hidden = m !== 'video' || state.info.platform !== 'tiktok';
}
document.querySelectorAll('#modeSeg button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
document.querySelectorAll('#abrGrid .q').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('#abrGrid .q').forEach((x) => x.setAttribute('aria-pressed', 'false'));
  b.setAttribute('aria-pressed', 'true'); state.abr = +b.dataset.abr;
}));
$('#trimOn').addEventListener('change', (e) => { $('#trimBox').hidden = !e.target.checked; });

/* ---------- download job ---------- */
function resetJob() {
  clearInterval(state.timer);
  state.job = null;
  if (state.blobUrl) URL.revokeObjectURL(state.blobUrl);
  state.blobUrl = null;
  $('#progress').hidden = true; $('#done').hidden = true; $('#player').innerHTML = '';
  $('#dlBtn').disabled = false; $('#dlLabel').textContent = 'Start download';
}

$('#dlBtn').addEventListener('click', async () => {
  if (!state.info) return;
  resetJob();
  showError('');
  const trim = $('#trimOn').checked;
  const body = {
    url: state.info.url, mode: state.mode, quality: state.quality, abr: state.abr,
    no_watermark: $('#noWm').checked,
    start: trim ? $('#tStart').value : null, end: trim ? $('#tEnd').value : null,
  };
  $('#dlBtn').disabled = true; $('#dlLabel').textContent = 'Working…';
  $('#progress').hidden = false; $('#barFill').style.width = '0%'; $('#pStage').textContent = 'Queued'; $('#pStats').textContent = '';
  try {
    const { job_id } = await api('/api/download', body);
    state.job = job_id;
    state.timer = setInterval(() => poll(job_id), 700);
  } catch (err) { failJob(err.message); }
});

const STAGES = { queued: 'Queued', starting: 'Connecting…', downloading: 'Downloading', processing: 'Merging & converting (FFmpeg)…', done: 'Complete' };

async function poll(id) {
  let j;
  try { j = await api('/api/jobs/' + id); } catch (err) { return failJob(err.message); }
  if (id !== state.job) return;
  const bar = $('#barFill');
  const indet = j.stage === 'processing' || j.stage === 'starting' || (j.stage === 'downloading' && !j.percent);
  bar.parentElement.classList.toggle('indet', indet);
  bar.style.width = (j.percent || 0) + '%';
  $('#pStage').textContent = (STAGES[j.stage] || j.stage) + (j.stage === 'downloading' && j.percent ? ` ${Math.round(j.percent)}%` : '');
  const stats = [];
  if (j.stage === 'downloading') {
    if (j.downloaded) stats.push(fmtBytes(j.downloaded) + (j.total ? ' / ' + fmtBytes(j.total) : ''));
    if (j.speed) stats.push(fmtBytes(j.speed) + '/s');
    if (j.eta != null) stats.push('ETA ' + fmtDur(j.eta));
  }
  $('#pStats').textContent = stats.join(' · ');
  if (j.stage === 'error') failJob(j.error);
  if (j.stage === 'done') finishJob(j);
}

function failJob(msg) {
  clearInterval(state.timer);
  $('#progress').hidden = true;
  $('#dlBtn').disabled = false; $('#dlLabel').textContent = 'Try again';
  showError(msg);
  document.getElementById('errorBox').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function finishJob(j) {
  clearInterval(state.timer);
  $('#barFill').parentElement.classList.remove('indet');
  $('#barFill').style.width = '100%';
  $('#dlBtn').disabled = false; $('#dlLabel').textContent = 'Download again';
  const fileUrl = `${API}/api/file/${j.id}`;
  state.fileUrl = fileUrl; state.fileName = j.filename;
  $('#fname').textContent = j.filename;
  $('#fsize').textContent = [fmtBytes(j.size), j.mode === 'audio' ? 'MP3' : 'MP4'].join(' · ');
  $('#openLink').href = fileUrl + '?inline=1';
  const el = document.createElement(j.mode === 'audio' ? 'audio' : 'video');
  el.controls = true; el.preload = 'metadata'; el.playsInline = true;
  el.src = fileUrl + '?inline=1';
  $('#player').innerHTML = ''; $('#player').appendChild(el);
  $('#done').hidden = false;
  addHistory(j, fileUrl);
  saveFile(fileUrl, j.filename); // auto-save
}

async function saveFile(url, name) {
  const btn = $('#saveBtn');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    if (!state.blobUrl) {
      const r = await fetch(url);
      if (!r.ok) throw new Error('File expired, download again.');
      state.blobUrl = URL.createObjectURL(await r.blob());
    }
    const a = document.createElement('a');
    a.href = state.blobUrl; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    btn.textContent = 'Saved — save again';
  } catch (err) {
    btn.textContent = 'Save to device';
    window.open(url, '_blank');
  } finally { btn.disabled = false; }
}
$('#saveBtn').addEventListener('click', () => state.fileUrl && saveFile(state.fileUrl, state.fileName));

function addHistory(j, url) {
  $('#historyWrap').hidden = false;
  const li = document.createElement('li');
  const s = document.createElement('span'); s.textContent = j.filename;
  const a = document.createElement('a'); a.className = 'ghost-btn'; a.href = url; a.textContent = fmtBytes(j.size) + ' ↓'; a.target = '_blank'; a.rel = 'noopener';
  li.append(s, a);
  $('#history').prepend(li);
}
