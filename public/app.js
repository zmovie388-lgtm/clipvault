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
const extractUrl = (t) => { const m = String(t || '').match(/https?:\/\/[^\s"'<>]+/); return m ? m[0] : String(t || '').trim(); };
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
  try { input.value = extractUrl(await navigator.clipboard.readText()); if (platformOf(input.value)) { syncPlatform(); $('#grabForm').requestSubmit(); return; } syncPlatform(); input.focus(); }
  catch { input.focus(); showError('Clipboard access was blocked — long-press the box and choose Paste.'); }
});

/* ---------- fetch info ---------- */
$('#grabForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = extractUrl(input.value);
  if (!url) return;
  if (!/^https?:\/\//.test(url)) { showError('Paste a full video link that starts with https://'); return; }
  input.value = url;
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
  const myJob = (state.job = Math.random().toString(36).slice(2));
  $('#dlBtn').disabled = true; $('#dlLabel').textContent = 'Working…';
  $('#progress').hidden = false;
  const bar = $('#barFill');
  bar.style.width = '0%'; bar.parentElement.classList.add('indet');
  $('#pStage').textContent = state.mode === 'audio' ? 'Server is fetching & converting to MP3…' : 'Server is fetching & merging HD video…';
  const t0 = Date.now();
  state.timer = setInterval(() => { $('#pStats').textContent = Math.round((Date.now() - t0) / 1000) + 's'; }, 500);
  try {
    const res = await fetch(`${API}/api/fetch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) { let d = null; try { d = await res.json(); } catch {} throw new Error((d && d.detail) || `Server error (${res.status})`); }
    clearInterval(state.timer);
    const total = +res.headers.get('Content-Length') || 0;
    const name = decodeURIComponent(res.headers.get('X-Filename') || 'clipvault-download.' + (state.mode === 'audio' ? 'mp3' : 'mp4'));
    bar.parentElement.classList.toggle('indet', !total);
    $('#pStage').textContent = 'Sending to your device';
    const reader = res.body.getReader();
    const chunks = []; let got = 0; const t1 = Date.now();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (myJob !== state.job) return;
      chunks.push(value); got += value.length;
      const pct = total ? (got / total) * 100 : 0;
      bar.style.width = pct + '%';
      const sp = got / Math.max(0.2, (Date.now() - t1) / 1000);
      $('#pStage').textContent = 'Sending to your device' + (total ? ` ${Math.round(pct)}%` : '');
      $('#pStats').textContent = [fmtBytes(got) + (total ? ' / ' + fmtBytes(total) : ''), fmtBytes(sp) + '/s'].join(' · ');
    }
    const type = res.headers.get('Content-Type') || 'video/mp4';
    const blob = new Blob(chunks, { type });
    finishJob({ filename: name, size: blob.size, mode: type.startsWith('audio') ? 'audio' : 'video' }, blob);
  } catch (err) { failJob(err.message); }
});

function failJob(msg) {
  clearInterval(state.timer);
  $('#progress').hidden = true;
  $('#dlBtn').disabled = false; $('#dlLabel').textContent = 'Try again';
  showError(msg);
  document.getElementById('errorBox').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function finishJob(j, blob) {
  clearInterval(state.timer);
  $('#barFill').parentElement.classList.remove('indet');
  $('#barFill').style.width = '100%';
  $('#pStage').textContent = 'Complete';
  $('#dlBtn').disabled = false; $('#dlLabel').textContent = 'Download again';
  state.blobUrl = URL.createObjectURL(blob);
  state.fileName = j.filename;
  $('#fname').textContent = j.filename;
  $('#fsize').textContent = [fmtBytes(j.size), j.filename.split('.').pop().toUpperCase()].join(' · ');
  $('#openLink').href = state.blobUrl;
  const el = document.createElement(j.mode === 'audio' ? 'audio' : 'video');
  el.controls = true; el.preload = 'metadata'; el.playsInline = true; el.src = state.blobUrl;
  $('#player').innerHTML = ''; $('#player').appendChild(el);
  $('#done').hidden = false;
  addHistory(j, state.blobUrl);
  saveFile();
}

function saveFile() {
  if (!state.blobUrl) return;
  const a = document.createElement('a');
  a.href = state.blobUrl; a.download = state.fileName; document.body.appendChild(a); a.click(); a.remove();
  $('#saveBtn').textContent = 'Saved — save again';
}
$('#saveBtn').addEventListener('click', saveFile);

function addHistory(j, url) {
  $('#historyWrap').hidden = false;
  const li = document.createElement('li');
  const s = document.createElement('span'); s.textContent = j.filename;
  const a = document.createElement('a'); a.className = 'ghost-btn'; a.href = url; a.textContent = fmtBytes(j.size) + ' ↓'; a.download = j.filename;
  li.append(s, a);
  $('#history').prepend(li);
}
