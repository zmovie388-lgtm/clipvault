#!/usr/bin/env python3
"""ClipVault backend — yt-dlp powered media downloader API (TikTok, YouTube, Facebook, more).

Endpoints
  POST /api/info       {url}                         -> metadata + available qualities
  POST /api/download   {url, mode, quality, abr, start, end, no_watermark}
                                                     -> {job_id}
  GET  /api/jobs/{id}                                -> progress / status
  GET  /api/file/{id}                                -> the finished file (attachment)
  GET  /api/health

Optional: put a Netscape-format cookies.txt next to this file (or set YTDLP_COOKIES)
to unlock YouTube on servers whose IP gets the "confirm you're not a bot" wall.
"""
import os
import re
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Optional

import yt_dlp
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

BASE = Path(__file__).resolve().parent
DL_DIR = BASE / "downloads"
DL_DIR.mkdir(exist_ok=True)
COOKIES = os.environ.get("YTDLP_COOKIES") or (str(BASE / "cookies.txt") if (BASE / "cookies.txt").exists() else None)
MAX_JOBS = int(os.environ.get("MAX_JOBS", "3"))
FILE_TTL = int(os.environ.get("FILE_TTL", "3600"))  # seconds to keep finished files
MAX_DURATION = int(os.environ.get("MAX_DURATION", str(3 * 3600)))

app = FastAPI(title="ClipVault API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
                   expose_headers=["Content-Disposition", "Content-Length"])

JOBS: dict = {}
LOCK = threading.Lock()
SEM = threading.Semaphore(MAX_JOBS)


def platform_of(url: str) -> str:
    u = url.lower()
    if "tiktok.com" in u:
        return "tiktok"
    if "youtube.com" in u or "youtu.be" in u:
        return "youtube"
    if "facebook.com" in u or "fb.watch" in u or "fb.com" in u:
        return "facebook"
    if "instagram.com" in u:
        return "instagram"
    if "twitter.com" in u or "x.com" in u:
        return "x"
    return "other"


def base_opts() -> dict:
    o = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "socket_timeout": 20,
        "retries": 3,
        "http_headers": {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"},
    }
    if COOKIES:
        o["cookiefile"] = COOKIES
    return o


def friendly_error(e: Exception, url: str) -> str:
    msg = re.sub(r"\x1b\[[0-9;]*m", "", str(e))
    if "confirm you" in msg and "bot" in msg:
        return ("YouTube blocked this server's IP with a bot check. Add a cookies.txt to the server "
                "(see README) or run ClipVault on your own PC/VPS — TikTok and Facebook keep working.")
    if "Unsupported URL" in msg:
        return "That link isn't supported. Paste a direct TikTok, YouTube or Facebook video link."
    if "Private" in msg or "login" in msg.lower():
        return "This video is private or needs login, so it can't be downloaded."
    if "Video unavailable" in msg:
        return "This video is unavailable (removed, region-locked or private)."
    return msg.replace("ERROR: ", "")[:300]


class InfoReq(BaseModel):
    url: str


class DlReq(BaseModel):
    url: str
    mode: str = "video"            # video | audio
    quality: Optional[int] = None  # target height, None = best
    abr: int = 192                 # mp3 bitrate
    start: Optional[str] = None    # "hh:mm:ss" or seconds
    end: Optional[str] = None
    no_watermark: bool = True


def clean_url(u: str) -> str:
    u = (u or "").strip()
    m = re.search(r"https?://\S+", u)
    if not m:
        raise HTTPException(400, "Paste a valid video link that starts with http(s)://")
    return m.group(0)


def to_seconds(t: Optional[str]) -> Optional[float]:
    if t is None or str(t).strip() == "":
        return None
    parts = [float(p) for p in str(t).strip().split(":")]
    s = 0.0
    for p in parts:
        s = s * 60 + p
    return s


@app.get("/api/health")
def health():
    return {"ok": True, "yt_dlp": yt_dlp.version.__version__, "cookies": bool(COOKIES)}


@app.get("/api/thumb")
def thumb(u: str):
    """Proxy thumbnails (TikTok/FB CDNs block hotlinking)."""
    import urllib.request
    from fastapi.responses import Response
    if not u.startswith("http"):
        raise HTTPException(400, "bad url")
    try:
        r = urllib.request.urlopen(urllib.request.Request(u, headers=base_opts()["http_headers"]), timeout=15)
        return Response(r.read(), media_type=r.headers.get("Content-Type", "image/jpeg"),
                        headers={"Cache-Control": "public, max-age=3600"})
    except Exception:
        raise HTTPException(404, "thumbnail unavailable")


@app.post("/api/info")
def info(req: InfoReq):
    url = clean_url(req.url)
    try:
        with yt_dlp.YoutubeDL(base_opts()) as ydl:
            data = ydl.extract_info(url, download=False)
    except Exception as e:  # noqa
        raise HTTPException(422, friendly_error(e, url))
    if data.get("_type") == "playlist" and data.get("entries"):
        data = next(iter(data["entries"]))

    fmts = data.get("formats") or []
    heights = sorted({f.get("height") for f in fmts if f.get("height") and f.get("vcodec") not in (None, "none")}, reverse=True)
    sizes = {}
    for h in heights:
        cands = [f for f in fmts if f.get("height") == h and (f.get("filesize") or f.get("filesize_approx"))]
        if cands:
            sizes[h] = max((c.get("filesize") or c.get("filesize_approx")) for c in cands)
    has_audio = any(f.get("acodec") not in (None, "none") for f in fmts) or not fmts
    plat = platform_of(url)
    labels = {}
    for f in fmts:
        h, w = f.get("height"), f.get("width")
        if h and w and f.get("vcodec") not in (None, "none"):
            labels[h] = min(h, w)
    if (data.get("duration") or 0) > MAX_DURATION:
        raise HTTPException(422, f"Video is longer than {MAX_DURATION // 3600}h, which is the limit on this server.")
    return {
        "url": url,
        "platform": plat,
        "extractor": data.get("extractor_key"),
        "title": data.get("title") or data.get("description", "")[:80] or "Untitled video",
        "uploader": data.get("uploader") or data.get("channel") or data.get("creator"),
        "thumbnail": data.get("thumbnail"),
        "duration": data.get("duration"),
        "views": data.get("view_count"),
        "likes": data.get("like_count"),
        "upload_date": data.get("upload_date"),
        "qualities": [{"height": h, "label": f"{labels.get(h, h)}p", "size": sizes.get(h)} for h in heights],
        "has_audio": has_audio,
        "watermark_free": plat == "tiktok" and any("watermark" not in (f.get("format_note") or "").lower() for f in fmts),
    }


def _progress_hook(job_id):
    def hook(d):
        j = JOBS.get(job_id)
        if not j:
            return
        if d["status"] == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            done = d.get("downloaded_bytes") or 0
            frag = d.get("fragment_index"), d.get("fragment_count")
            pct = (done / total * 100) if total else (frag[0] / frag[1] * 100 if frag[0] and frag[1] else 0)
            j.update(stage="downloading", percent=round(min(pct, 99.0), 1), speed=d.get("speed"),
                     eta=d.get("eta"), downloaded=done, total=total)
        elif d["status"] == "finished":
            j.update(stage="processing", percent=99.0)
    return hook


def _postproc_hook(job_id):
    def hook(d):
        j = JOBS.get(job_id)
        if j and d.get("status") == "started":
            j.update(stage="processing", note=d.get("postprocessor"))
    return hook


def _run(job_id: str, req: DlReq):
    j = JOBS[job_id]
    with SEM:
        j["stage"] = "starting"
        out_dir = DL_DIR / job_id
        out_dir.mkdir(exist_ok=True)
        opts = base_opts()
        opts.update({
            "outtmpl": str(out_dir / "%(title).80B [%(id)s].%(ext)s"),
            "progress_hooks": [_progress_hook(job_id)],
            "postprocessor_hooks": [_postproc_hook(job_id)],
            "restrictfilenames": False,
            "windowsfilenames": True,
            "concurrent_fragment_downloads": 4,
        })
        plat = platform_of(req.url)
        if req.mode == "audio":
            opts["format"] = "bestaudio/best"
            opts["postprocessors"] = [
                {"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": str(req.abr)},
                {"key": "FFmpegMetadata"},
            ]
        else:
            h = req.quality
            hf = f"[height<={h}]" if h else ""
            # Prefer H.264 + AAC so the MP4 plays everywhere (phones, WhatsApp, editors)
            opts["format"] = (
                f"bv*{hf}[vcodec^=avc1]+ba[acodec^=mp4a]/"
                f"bv*{hf}[ext=mp4]+ba[ext=m4a]/"
                f"bv*{hf}+ba/b{hf}/bv*+ba/b"
            )
            if plat == "tiktok" and req.no_watermark:
                opts["format"] = (f"b{hf}[vcodec^=h264][format_note!*=watermark]/"
                                  f"b{hf}[format_note!*=watermark]/" + opts["format"])
            opts["merge_output_format"] = "mp4"
            opts["postprocessors"] = [{"key": "FFmpegVideoRemuxer", "preferedformat": "mp4"}, {"key": "FFmpegMetadata"}]
        s, e = to_seconds(req.start), to_seconds(req.end)
        if s is not None or e is not None:
            opts["download_ranges"] = yt_dlp.utils.download_range_func(None, [(s or 0, e or float("inf"))])
            opts["force_keyframes_at_cuts"] = True
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                ydl.extract_info(req.url, download=True)
            files = [p for p in out_dir.iterdir() if p.is_file() and not p.name.endswith((".part", ".ytdl"))]
            if not files:
                raise RuntimeError("Download finished but no file was produced.")
            f = max(files, key=lambda p: p.stat().st_size)
            j.update(stage="done", percent=100.0, file=str(f), filename=f.name, size=f.stat().st_size,
                     finished_at=time.time())
        except Exception as ex:  # noqa
            j.update(stage="error", error=friendly_error(ex, req.url))


@app.post("/api/download")
def download(req: DlReq):
    req.url = clean_url(req.url)
    if req.mode not in ("video", "audio"):
        raise HTTPException(400, "mode must be video or audio")
    job_id = uuid.uuid4().hex[:12]
    JOBS[job_id] = {"id": job_id, "stage": "queued", "percent": 0.0, "mode": req.mode, "created": time.time()}
    threading.Thread(target=_run, args=(job_id, req), daemon=True).start()
    return {"job_id": job_id}


@app.get("/api/jobs/{job_id}")
def job(job_id: str):
    j = JOBS.get(job_id)
    if not j:
        raise HTTPException(404, "Job not found")
    return {k: v for k, v in j.items() if k != "file"}


@app.get("/api/file/{job_id}")
def file(job_id: str, inline: int = 0):
    j = JOBS.get(job_id)
    if not j or j.get("stage") != "done" or not os.path.exists(j.get("file", "")):
        raise HTTPException(404, "File not ready or expired")
    mt = "audio/mpeg" if j["filename"].endswith(".mp3") else "video/mp4"
    return FileResponse(j["file"], media_type=mt, filename=j["filename"],
                        content_disposition_type="inline" if inline else "attachment")


def _janitor():
    while True:
        time.sleep(120)
        now = time.time()
        for jid, j in list(JOBS.items()):
            if now - j.get("created", now) > FILE_TTL:
                shutil.rmtree(DL_DIR / jid, ignore_errors=True)
                JOBS.pop(jid, None)


threading.Thread(target=_janitor, daemon=True).start()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8000")))
