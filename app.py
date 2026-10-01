"""ClipVault on Vercel — FastAPI + yt-dlp + bundled FFmpeg (imageio-ffmpeg).

Serverless-friendly: each download runs inside one request (fetch -> merge/convert in /tmp ->
stream file back), so no cross-request job state is needed.
"""
import os
import re
import shutil
import stat
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Optional

import yt_dlp
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

app = FastAPI(title="ClipVault API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
                   expose_headers=["Content-Disposition", "Content-Length", "X-Filename"])

MAX_DURATION = int(os.environ.get("MAX_DURATION", "1800"))  # 30 min keeps us inside the 300s limit
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"
_FFMPEG = None


def ffmpeg_path() -> Optional[str]:
    """Locate FFmpeg: system binary or the static one shipped in imageio-ffmpeg (copied to /tmp + chmod)."""
    global _FFMPEG
    if _FFMPEG and os.path.exists(_FFMPEG):
        return _FFMPEG
    sys_ff = shutil.which("ffmpeg")
    if sys_ff:
        _FFMPEG = sys_ff
        return _FFMPEG
    try:
        import imageio_ffmpeg
        src = imageio_ffmpeg.get_ffmpeg_exe()
        dst = "/tmp/ffbin/ffmpeg"
        if not os.path.exists(dst):
            os.makedirs("/tmp/ffbin", exist_ok=True)
            shutil.copy(src, dst)
            os.chmod(dst, os.stat(dst).st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
        _FFMPEG = dst
        # yt-dlp's partial-download (trim) check looks on PATH, so expose the bundled binary there too
        os.environ["PATH"] = "/tmp/ffbin:" + os.environ.get("PATH", "")
    except Exception:
        _FFMPEG = None
    return _FFMPEG


def cookies_file() -> Optional[str]:
    """YouTube cookies can be supplied via the YTDLP_COOKIES env var (full Netscape cookies.txt content)."""
    c = os.environ.get("YTDLP_COOKIES")
    if not c:
        return None
    p = "/tmp/cookies.txt"
    if not os.path.exists(p):
        Path(p).write_text(c)
    return p


def platform_of(url: str) -> str:
    u = url.lower()
    for key, names in (("tiktok", ["tiktok.com"]), ("youtube", ["youtube.com", "youtu.be"]),
                       ("facebook", ["facebook.com", "fb.watch", "fb.com"]), ("instagram", ["instagram.com"]),
                       ("x", ["twitter.com", "x.com"])):
        if any(n in u for n in names):
            return key
    return "other"


def base_opts() -> dict:
    o = {"quiet": True, "no_warnings": True, "noprogress": True, "noplaylist": True, "socket_timeout": 20, "retries": 2,
         "http_headers": {"User-Agent": UA}, "cachedir": "/tmp/ytdlp-cache"}
    ff = ffmpeg_path()
    if ff:
        o["ffmpeg_location"] = ff
    ck = cookies_file()
    if ck:
        o["cookiefile"] = ck
    return o


def friendly_error(e: Exception) -> str:
    msg = re.sub(r"\x1b\[[0-9;]*m", "", str(e))
    if "confirm you" in msg and "bot" in msg:
        return ("YouTube blocked this server's IP with a bot check. The site owner can add YouTube cookies "
                "(YTDLP_COOKIES env var) — TikTok and Facebook keep working.")
    if "Unsupported URL" in msg:
        return "That link isn't supported. Paste a direct TikTok, YouTube or Facebook video link."
    if "Private" in msg or "login" in msg.lower():
        return "This video is private or needs login, so it can't be downloaded."
    if "Video unavailable" in msg:
        return "This video is unavailable (removed, region-locked or private)."
    return msg.replace("ERROR: ", "")[:300]


def clean_url(u: str) -> str:
    m = re.search(r"https?://\S+", (u or "").strip())
    if not m:
        raise HTTPException(400, "Paste a valid video link that starts with http(s)://")
    return m.group(0)


def to_seconds(t) -> Optional[float]:
    if t is None or str(t).strip() == "":
        return None
    s = 0.0
    for p in str(t).strip().split(":"):
        s = s * 60 + float(p)
    return s


class InfoReq(BaseModel):
    url: str


class DlReq(BaseModel):
    url: str
    mode: str = "video"
    quality: Optional[int] = None
    abr: int = 192
    start: Optional[str] = None
    end: Optional[str] = None
    no_watermark: bool = True


@app.get("/api/health")
def health():
    return {"ok": True, "yt_dlp": yt_dlp.version.__version__, "ffmpeg": bool(ffmpeg_path()),
            "cookies": bool(os.environ.get("YTDLP_COOKIES")), "mode": "serverless"}


@app.get("/api/thumb")
def thumb(u: str):
    if not u.startswith("http"):
        raise HTTPException(400, "bad url")
    try:
        r = urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": UA}), timeout=15)
        return Response(r.read(), media_type=r.headers.get("Content-Type", "image/jpeg"),
                        headers={"Cache-Control": "public, max-age=86400"})
    except Exception:
        raise HTTPException(404, "thumbnail unavailable")


@app.post("/api/info")
def info(req: InfoReq):
    url = clean_url(req.url)
    try:
        with yt_dlp.YoutubeDL(base_opts()) as ydl:
            data = ydl.extract_info(url, download=False)
    except Exception as e:  # noqa
        raise HTTPException(422, friendly_error(e))
    if data.get("_type") == "playlist" and data.get("entries"):
        data = next(iter(data["entries"]))
    fmts = data.get("formats") or []
    vf = [f for f in fmts if f.get("height") and f.get("vcodec") not in (None, "none")]
    heights = sorted({f["height"] for f in vf}, reverse=True)
    labels = {f["height"]: min(f["height"], f.get("width") or f["height"]) for f in vf}
    sizes = {}
    for h in heights:
        c = [(f.get("filesize") or f.get("filesize_approx")) for f in vf if f["height"] == h and (f.get("filesize") or f.get("filesize_approx"))]
        if c:
            sizes[h] = max(c)
    if (data.get("duration") or 0) > MAX_DURATION:
        raise HTTPException(422, f"Video is longer than {MAX_DURATION // 60} minutes — the limit on this server.")
    return {
        "url": url, "platform": platform_of(url), "extractor": data.get("extractor_key"),
        "title": data.get("title") or "Untitled video",
        "uploader": data.get("uploader") or data.get("channel") or data.get("creator"),
        "thumbnail": data.get("thumbnail"), "duration": data.get("duration"),
        "views": data.get("view_count"), "likes": data.get("like_count"), "upload_date": data.get("upload_date"),
        "qualities": [{"height": h, "label": f"{labels.get(h, h)}p", "size": sizes.get(h)} for h in heights],
    }


@app.post("/api/fetch")
def fetch(req: DlReq):
    """Download + process in /tmp, then stream the finished file back in the same request."""
    url = clean_url(req.url)
    if req.mode not in ("video", "audio"):
        raise HTTPException(400, "mode must be video or audio")
    work = tempfile.mkdtemp(prefix="cv-", dir="/tmp")
    opts = base_opts()
    opts.update({"outtmpl": os.path.join(work, "%(title).70B [%(id)s].%(ext)s"), "windowsfilenames": True,
                 "concurrent_fragment_downloads": 4})
    has_ff = "ffmpeg_location" in opts
    if req.mode == "audio":
        if has_ff:
            opts["format"] = "bestaudio/best"
            opts["postprocessors"] = [{"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": str(req.abr)}]
        else:
            opts["format"] = "bestaudio[ext=m4a]/bestaudio"
    else:
        hf = f"[height<={req.quality}]" if req.quality else ""
        if has_ff:
            opts["format"] = f"bv*{hf}[vcodec^=avc1]+ba[acodec^=mp4a]/bv*{hf}[ext=mp4]+ba[ext=m4a]/bv*{hf}+ba/b{hf}/bv*+ba/b"
            opts["merge_output_format"] = "mp4"
        else:
            opts["format"] = f"b{hf}[ext=mp4]/b{hf}/b"
        if platform_of(url) == "tiktok" and req.no_watermark:
            opts["format"] = f"b{hf}[vcodec^=h264][format_note!*=watermark]/b{hf}[format_note!*=watermark]/" + opts["format"]
    s, e = to_seconds(req.start), to_seconds(req.end)
    if has_ff and (s is not None or e is not None):
        opts["download_ranges"] = yt_dlp.utils.download_range_func(None, [(s or 0, e or float("inf"))])
        opts["force_keyframes_at_cuts"] = True
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.extract_info(url, download=True)
        files = [p for p in Path(work).iterdir() if p.is_file() and not p.name.endswith((".part", ".ytdl"))]
        if not files:
            raise RuntimeError("Download finished but no file was produced.")
        f = max(files, key=lambda p: p.stat().st_size)
    except Exception as ex:  # noqa
        shutil.rmtree(work, ignore_errors=True)
        raise HTTPException(422, friendly_error(ex))

    size = f.stat().st_size
    mt = "audio/mpeg" if f.suffix == ".mp3" else ("audio/mp4" if f.suffix == ".m4a" else "video/mp4")

    def gen():
        with open(f, "rb") as fh:
            while chunk := fh.read(1024 * 256):
                yield chunk

    q = urllib.parse.quote(f.name)
    return StreamingResponse(gen(), media_type=mt, background=BackgroundTask(shutil.rmtree, work, True),
                             headers={"Content-Length": str(size), "X-Filename": q,
                                      "Content-Disposition": f"attachment; filename*=UTF-8''{q}"})
