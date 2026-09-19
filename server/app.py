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
import re
import subprocess
import threading
import uuid
from collections import defaultdict
from datetime import date, datetime, timedelta
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

BRIDGE_HOST = os.getenv("BRIDGE_HOST", "trungcln@10.10.10.104")
BRIDGE_KEY = os.getenv("BRIDGE_KEY", "/keys/id_ed25519_bridge")
AI_DAILY_LIMIT = int(os.getenv("AI_DAILY_LIMIT", "30"))

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


@app.get("/api/me")
def me(request: Request):
    return {"email": require_access(request)}


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


# ── AI: trợ lý tài chính (Claude qua cầu nối CT104, chạy nền vì Cloudflare cắt request > 100s) ──
_ai_used = {"day": "", "n": 0}
_jobs: dict = {}


def _load(rel, default=None):
    p = REPO / rel
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return default


def _month_keys(n=3):
    d = date.today().replace(day=1); out = []
    for _ in range(n):
        out.append(d.strftime("%Y-%m")); d = (d - timedelta(days=1)).replace(day=1)
    return out


def _finance_context() -> str:
    cats = _load("categories.json", {}) or {}
    name = {("income", c["id"]): c["name"] for c in cats.get("income", [])}
    name.update({("expense", c["id"]): c["name"] for c in cats.get("expense", [])})
    pm = {p["id"]: p.get("name", p["id"]) for p in cats.get("paymentMethods", [])}
    budget = _load("budget.json", {}) or {}
    cur = date.today().strftime("%Y-%m")
    lines = [f"Hôm nay: {date.today().isoformat()} (tháng {cur}, đã qua {date.today().day} ngày)."]
    blines = []
    for cid, b in (budget.get("categories") or {}).items():
        vs = [v for v in b.get("versions", []) if v.get("from", "") <= cur]
        if vs: blines.append(f"{b.get('name', cid)}: {vs[-1].get('monthlyAmount', 0):,}đ")
    if blines: lines.append("Ngân sách tháng theo danh mục: " + "; ".join(blines))
    for mk in _month_keys(3):
        tx = _load(f"transactions/{mk}.json", []) or []
        inc = sum(t.get("amount", 0) for t in tx if t.get("type") == "income")
        exp = sum(t.get("amount", 0) for t in tx if t.get("type") == "expense")
        by = defaultdict(int)
        for t in tx:
            if t.get("type") == "expense": by[name.get(("expense", t.get("category")), t.get("category"))] += t.get("amount", 0)
        top = ", ".join(f"{k} {v:,}đ" for k, v in sorted(by.items(), key=lambda x: -x[1]))
        lines.append(f"Tháng {mk}: thu {inc:,}đ · chi {exp:,}đ · {len(tx)} giao dịch. Chi theo danh mục: {top}")
    tx = _load(f"transactions/{cur}.json", []) or []
    lines.append(f"Chi tiết giao dịch tháng {cur} (ngày|loại|danh mục|số tiền|ghi chú|thanh toán):")
    for t in sorted(tx, key=lambda t: t.get("date", ""))[-200:]:
        lines.append(f"{t.get('date')}|{t.get('type')}|{name.get((t.get('type'), t.get('category')), t.get('category', ''))}|"
                     f"{t.get('amount', 0):,}|{(t.get('note') or '')[:60]}|{pm.get(t.get('paymentMethod'), t.get('paymentMethod', ''))}")
    return "\n".join(lines)[:30000]


def _categories_brief() -> str:
    cats = _load("categories.json", {}) or {}
    return json.dumps({"income": [{"id": c["id"], "name": c["name"]} for c in cats.get("income", [])],
                       "expense": [{"id": c["id"], "name": c["name"]} for c in cats.get("expense", [])],
                       "paymentMethods": [{"id": p["id"], "name": p.get("name", p["id"])} for p in cats.get("paymentMethods", [])],
                       "priorities": [{"id": p["id"], "name": p.get("name", p["id"])} for p in cats.get("priorities", [])]},
                      ensure_ascii=False)


NAMES = {"trung.caolenam@gmail.com": "Trung", "lephuc1702@gmail.com": "Phúc"}
ADVISOR = ("Bạn là cố vấn tài chính gia đình (Việt Nam), đang trả lời {who}. Dữ liệu dưới đây là sổ thu chi THẬT của gia đình. "
           "Chỉ dựa trên dữ liệu, không bịa số. Trả lời tiếng Việt, ngắn gọn, có số cụ thể (định dạng 1.234.000đ), "
           "Markdown gọn (tiêu đề nhỏ, gạch đầu dòng). Không khuyên đầu tư chứng khoán/crypto cụ thể. "
           "Khi phù hợp, kết thúc bằng 1 việc làm được ngay.\n\nDỮ LIỆU:\n{ctx}\n\n{page}{task}")
REVIEW_TASK = ("Nhận xét tháng hiện tại, đúng 5 mục: **Tình hình** (thu/chi/số dư so với ngân sách, tốc độ chi theo số ngày đã qua) · "
               "**Vượt/sắp vượt ngân sách** · **Khoản bất thường** (so với 2 tháng trước) · **Dự báo cuối tháng** (ngoại suy tuyến tính, nói rõ là ước tính) · "
               "**3 việc nên làm** cụ thể.")
PARSE_PROMPT = ("Chuyển câu mô tả giao dịch tiếng Việt thành JSON cho sổ thu chi. Hôm nay là {today}.\n"
                "Danh mục/phương thức hợp lệ (CHỈ dùng id trong danh sách):\n{cats}\n\nCâu: \"{text}\"\n\n"
                "Quy ước: 'k'=nghìn, 'tr'/'triệu'=triệu, 'lít'/'xị'=trăm nghìn; 'hôm qua','hôm kia','thứ 2 tuần này'… đổi ra ngày cụ thể. "
                "Không rõ phương thức thì null. Reply ONLY JSON: "
                '{{"type":"expense|income","date":"YYYY-MM-DD","amount":0,"category":"id","paymentMethod":"id or null",'
                '"priority":"id or null","note":"ghi chú ngắn","confidence":"high|low","question":"nếu thiếu thông tin quan trọng thì 1 câu hỏi lại, không thì rỗng"}}')


def _bridge(prompt: str) -> str:
    r = subprocess.run(["ssh", "-i", BRIDGE_KEY, "-o", "BatchMode=yes", "-o", "ConnectTimeout=15",
                        "-o", "StrictHostKeyChecking=accept-new", "-o", f"UserKnownHostsFile={Path(BRIDGE_KEY).parent / 'known_hosts'}",
                        BRIDGE_HOST], input=prompt, capture_output=True, text=True, timeout=600)
    if r.returncode != 0 or not r.stdout.strip():
        raise RuntimeError("Không gọi được Claude (cầu nối CT104)")
    return r.stdout.strip()


def _run_ai(jid: str, mode: str, text: str, history: list, who: str = "bạn", page: str = ""):
    try:
        if mode == "parse":
            raw = _bridge(PARSE_PROMPT.format(today=date.today().isoformat(), cats=_categories_brief(), text=text[:500]))
            res = {"draft": json.loads(raw[raw.find("{"):raw.rfind("}") + 1])}
        else:
            if mode == "review":
                task = REVIEW_TASK
            else:
                conv = "\n".join(f"{who if h.get('role') == 'user' else 'Cố vấn'}: {h.get('content', '')}" for h in history[-10:])
                task = f"Hội thoại:\n{conv}\n{who}: {text[:2000]}\n\nTrả lời câu hỏi mới nhất của {who}."
            # Màn hình người dùng đang xem → hiểu "cái này", "khoản này", "tháng này" chỉ cái gì
            page_note = f"NGƯỜI DÙNG ĐANG XEM (bối cảnh câu hỏi): {page[:1500]}\n\n" if page else ""
            res = {"text": _bridge(ADVISOR.format(who=who, ctx=_finance_context(), page=page_note, task=task))}
        _jobs[jid] = {"status": "done", "result": res, "at": datetime.now()}
    except Exception as e:  # noqa: BLE001
        _ai_used["n"] = max(0, _ai_used["n"] - 1)  # lỗi thì hoàn lượt
        _jobs[jid] = {"status": "error", "error": str(e)[:300], "at": datetime.now()}


@app.post("/api/ai/job")
async def ai_job(request: Request):
    email = require_access(request)
    body = await request.json()
    mode = body.get("mode")
    if mode not in ("chat", "review", "parse"):
        raise HTTPException(400, "Chế độ AI không hợp lệ")
    today = date.today().isoformat()
    if _ai_used["day"] != today:
        _ai_used.update(day=today, n=0)
    if _ai_used["n"] >= AI_DAILY_LIMIT:
        raise HTTPException(429, f"Đã dùng hết {AI_DAILY_LIMIT} lượt AI hôm nay")
    _ai_used["n"] += 1
    cutoff = datetime.now() - timedelta(hours=1)
    for k in [k for k, v in _jobs.items() if v["at"] < cutoff]:
        _jobs.pop(k, None)
    jid = uuid.uuid4().hex[:12]
    _jobs[jid] = {"status": "running", "at": datetime.now()}
    threading.Thread(target=_run_ai, args=(jid, mode, str(body.get("text", "")), body.get("history") or [],
                                                        NAMES.get(email, "bạn"), str(body.get("page", ""))), daemon=True).start()
    return {"job": jid, "left": AI_DAILY_LIMIT - _ai_used["n"]}


@app.get("/api/ai/job/{jid}")
def ai_job_status(jid: str, request: Request):
    require_access(request)
    j = _jobs.get(jid)
    if not j:
        raise HTTPException(404, "Không tìm thấy công việc AI — thử lại")
    if j["status"] == "running":
        return {"status": "running"}
    _jobs.pop(jid, None)
    if j["status"] == "error":
        raise HTTPException(502, j["error"])
    return {"status": "done", **j["result"]}


@app.get("/api/health")
def health():
    return {"ok": True, "head": git("rev-parse", "--short", "HEAD"), "commits": int(git("rev-list", "--count", "HEAD"))}


def _asset_version() -> str:
    # Hash toàn bộ file tĩnh → đổi code là đổi URL (?v=), Cloudflare/trình duyệt không giữ bản cũ được
    import hashlib
    h = hashlib.sha256()
    for f in sorted(STATIC.rglob("*")):
        if f.is_file():
            h.update(f.read_bytes())
    return h.hexdigest()[:10]


ASSET_V = _asset_version()
_REF_HTML = re.compile(r'((?:src|href)="(?:js|css)/[\w.-]+\.(?:js|css))"')
_REF_JS = re.compile(r"""(from\s+'\./[\w.-]+\.js)'""")


@app.get("/{path:path}")
def static(path: str):
    p = (STATIC / (path or "index.html")).resolve()
    if STATIC not in p.parents and p != STATIC:
        raise HTTPException(404)
    if p.is_dir():
        p = p / "index.html"
    if not p.is_file():
        p = STATIC / "index.html"
    if p.suffix in (".html", ".js") and p.name != "sw.js":
        body = p.read_text(encoding="utf-8")
        if p.suffix == ".html":
            body = _REF_HTML.sub(rf'\1?v={ASSET_V}"', body)
            media = "text/html; charset=utf-8"
        else:
            body = _REF_JS.sub(rf"\1?v={ASSET_V}'", body)
            media = "text/javascript; charset=utf-8"
        return Response(body, media_type=media, headers={"Cache-Control": "no-cache"})
    headers = {"Cache-Control": "no-cache"} if p.suffix in (".css", ".json") or p.name == "sw.js" else {}
    return FileResponse(p, headers=headers)
