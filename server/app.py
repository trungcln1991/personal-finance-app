"""Sổ Thu Chi — backend local trên PC E5 (thay Cloudflare Worker + GitHub Contents API).

Giữ NGUYÊN giao diện API mà app đang gọi (/login, /contents/<path> GET/PUT theo định dạng GitHub
Contents API) nên phía app gần như không phải sửa. Dữ liệu vẫn là 1 repo git: mỗi lần ghi = 1 commit
(giữ audit trail như cũ), repo nằm trên ổ 6TB (/data/repo), đẩy lên GitHub mỗi đêm làm bản sao ngoài nhà.

Xác thực: đứng sau Cloudflare Access (+MFA). App vẫn tự kiểm JWT `Cf-Access-Jwt-Assertion` (chữ ký,
aud, email) — phòng khi tunnel cấu hình nhầm thì cũng không ai đọc được dữ liệu tiền bạc.
"""
import base64
import json
import os
import subprocess
import threading
from pathlib import Path

import jwt
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response

REPO = Path(os.getenv("DATA_REPO", "/data/repo")).resolve()
STATIC = Path(os.getenv("STATIC_DIR", "/app/static")).resolve()
TEAM = os.getenv("CF_TEAM_DOMAIN", "https://trungcln.cloudflareaccess.com")
AUD = os.getenv("CF_ACCESS_AUD", "")
ALLOWED = {e.strip().lower() for e in os.getenv("ALLOWED_EMAILS", "").split(",") if e.strip()}
DEV_NO_AUTH = os.getenv("DEV_NO_AUTH") == "1"  # chỉ dùng khi chạy thử trên máy dev

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
_lock = threading.Lock()
_jwks = jwt.PyJWKClient(f"{TEAM}/cdn-cgi/access/certs", cache_keys=True) if not DEV_NO_AUTH else None


def require_access(request: Request) -> str:
    if DEV_NO_AUTH:
        return "dev"
    tok = request.headers.get("Cf-Access-Jwt-Assertion") or request.cookies.get("CF_Authorization")
    if not tok:
        raise HTTPException(401, "Chưa đăng nhập Cloudflare Access")
    try:
        key = _jwks.get_signing_key_from_jwt(tok).key
        claims = jwt.decode(tok, key, algorithms=["RS256"], audience=AUD, issuer=TEAM)
    except Exception:
        raise HTTPException(401, "Phiên Cloudflare Access không hợp lệ — tải lại trang để đăng nhập lại")
    email = str(claims.get("email", "")).lower()
    if ALLOWED and email not in ALLOWED:
        raise HTTPException(403, "Tài khoản này không được phép")
    return email


def git(*args) -> str:
    r = subprocess.run(["git", "-C", str(REPO), *args], capture_output=True, text=True)
    if r.returncode != 0:
        raise HTTPException(500, f"git {args[0]} lỗi: {r.stderr.strip()[:200]}")
    return r.stdout.strip()


def safe_path(rel: str) -> Path:
    p = (REPO / rel).resolve()
    if any(seg.startswith("-") for seg in Path(rel).parts):
        raise HTTPException(400, "Đường dẫn không hợp lệ")
    if REPO not in p.parents and p != REPO or ".git" in p.parts:
        raise HTTPException(400, "Đường dẫn không hợp lệ")
    return p


def blob_sha(p: Path) -> str:
    return git("hash-object", str(p))


@app.post("/api/login")
async def login(request: Request):
    # Mật khẩu app không còn cần: Cloudflare Access + MFA đã xác thực. Trả token giả để app chạy như cũ.
    require_access(request)
    return {"token": "cf-access"}


@app.get("/api/contents/{path:path}")
def get_contents(path: str, request: Request):
    require_access(request)
    p = safe_path(path)
    if p.is_dir():
        return [{"name": c.name, "path": str(c.relative_to(REPO)), "sha": blob_sha(c) if c.is_file() else "",
                 "type": "file" if c.is_file() else "dir"} for c in sorted(p.iterdir()) if c.name != ".git"]
    if not p.is_file():
        return JSONResponse({"message": "Not Found"}, status_code=404)
    return {"name": p.name, "path": path, "sha": blob_sha(p), "type": "file", "encoding": "base64",
            "content": base64.b64encode(p.read_bytes()).decode()}


@app.put("/api/contents/{path:path}")
async def put_contents(path: str, request: Request):
    who = require_access(request)
    if not path.endswith(".json"):
        raise HTTPException(400, "Chỉ cho phép ghi file .json")
    body = await request.json()
    p = safe_path(path)
    data = base64.b64decode(body.get("content", ""))
    json.loads(data)  # dữ liệu phải là JSON hợp lệ, hỏng thì từ chối trước khi ghi
    with _lock:
        cur = blob_sha(p) if p.is_file() else None
        if cur != body.get("sha"):  # giống GitHub: sha lệch = có người vừa ghi → 409
            return JSONResponse({"message": "sha mismatch"}, status_code=409)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".tmp"); tmp.write_bytes(data); tmp.replace(p)
        git("add", "--", str(p.relative_to(REPO)))  # "--" tách đường dẫn khỏi tuỳ chọn git
        changed = subprocess.run(["git", "-C", str(REPO), "diff", "--cached", "--quiet"]).returncode != 0
        if changed: git("-c", "user.name=So Thu Chi (E5)", "-c", f"user.email={who if '@' in who else 'app@taichinh.local'}",
            "commit", "-q", "-m", str(body.get("message") or f"Cập nhật {path}"))
        commit = git("rev-parse", "HEAD")
    return {"content": {"name": p.name, "path": path, "sha": blob_sha(p)}, "commit": {"sha": commit}}


@app.get("/api/health")
def health():
    return {"ok": True, "head": git("rev-parse", "--short", "HEAD"), "commits": int(git("rev-list", "--count", "HEAD"))}


@app.get("/{path:path}")
def static(path: str):
    p = (STATIC / (path or "index.html")).resolve()
    if STATIC not in p.parents and p != STATIC:
        raise HTTPException(404)
    if p.is_dir():
        p = p / "index.html"
    if not p.is_file():
        p = STATIC / "index.html"
    headers = {"Cache-Control": "no-cache"} if p.suffix in (".html", ".js", ".css", ".json") or p.name == "sw.js" else {}
    return FileResponse(p, headers=headers)
