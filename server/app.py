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
AI_DAILY_LIMIT = int(os.getenv("AI_DAILY_LIMIT", "150"))  # trợ lý hội thoại: mỗi câu nói = 1 lượt
# 22/09/2026: trợ lý giao tiếp cần NHANH — model/effort riêng, system prompt ngắn thay cho system prompt dài của Claude Code
AI_AGENT_MODEL = os.getenv("AI_AGENT_MODEL", "claude-opus-5")  # đo 22/09: Opus low 4,9s ≈ Sonnet low 4,6s, Opus trả lời đủ ý hơn
AI_AGENT_EFFORT = os.getenv("AI_AGENT_EFFORT", "low")
FAST_SYSTEM = ("Bạn là trợ lý tài chính gia đình trong app Sổ Thu Chi. Làm đúng yêu cầu trong tin nhắn, trả đúng định dạng được yêu cầu. "
               "Mọi con số phải lấy nguyên văn từ dữ liệu được cung cấp, không tự cộng lại, không bịa.")

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


# ── Cách tính tiền — BẢN SAO 1:1 của js/store.js (statementDueDate/effectiveMonth/monthSummary/debtSchedule/
#    computeAccountBalances). Sửa công thức bên đó thì sửa cả ở đây; test đối chiếu JS↔Python trong scratchpad. ──
import calendar


def _dim(y, m):
    return calendar.monthrange(y, m)[1]


def _add_m(y, m, d):
    k = y * 12 + (m - 1) + d
    return k // 12, k % 12 + 1


def _norm_pm(p):
    b = {"type": "cash", "owner": "shared", "initialBalance": 0, "initialBalanceDate": None, "openingDebt": 0,
         "openingDebtDate": None, "statementDay": None, "dueDay": None, **p}
    if not b.get("openingDebtDate") and b.get("lastPaidMonth"):
        y, m = map(int, b["lastPaidMonth"].split("-")); y, m = _add_m(y, m, 1)
        b["openingDebt"], b["openingDebtDate"] = 0, f"{y}-{m:02d}-01"
    b["openingDebt"] = b.get("openingDebt") or 0
    b["initialBalance"] = b.get("initialBalance") or 0
    return b


def _debt_map(cats):
    return {p["id"]: p for p in map(_norm_pm, cats.get("paymentMethods", [])) if p["type"] in ("credit", "wallet")}


def _due_date(p, ds):
    y, m, d = map(int, ds.split("-"))
    if not (p.get("statementDay") and p.get("dueDay")):
        y, m = _add_m(y, m, 1); return f"{y}-{m:02d}-01"
    if d > min(p["statementDay"], _dim(y, m)):
        y, m = _add_m(y, m, 1)
    y, m = _add_m(y, m, 1)
    return f"{y}-{m:02d}-{min(p['dueDay'], _dim(y, m)):02d}"


def _eff_month(t, dm):
    p = dm.get(t.get("paymentMethod")) if t.get("type") != "transfer" else None
    if not p or (p.get("openingDebtDate") and t["date"] < p["openingDebtDate"]):
        return t["date"][:7]
    return _due_date(p, t["date"])[:7]


def _month_summary(all_tx, mk, dm):
    inc = cash = card = paid = 0; exp = []
    for t in all_tx:
        if t.get("type") == "transfer":
            if t["date"][:7] == mk and t.get("toPayment") in dm and t.get("fromPayment") not in dm:
                paid += t["amount"]
            continue
        if _eff_month(t, dm) != mk:
            continue
        via = t.get("paymentMethod") in dm
        if t["type"] == "income":
            inc += t["amount"]; continue
        if t["type"] != "expense":
            continue
        exp.append({**t, "dueMonth": mk} if via else t)
        if via: card += t["amount"]
        else: cash += t["amount"]
    return {"income": inc, "out": cash + card, "cashOut": cash, "cardDue": card, "debtPaid": paid, "expenseList": exp}


def _debt_schedule(cats, all_tx, mk, until):
    dm = _debt_map(cats); y, m = map(int, mk.split("-")); ny, nm = _add_m(y, m, 1); nxt = f"{ny}-{nm:02d}"
    rows = []
    for p in dm.values():
        if not p.get("openingDebtDate"):
            continue
        by = defaultdict(int)
        if p["openingDebt"]:
            by[p["openingDebtDate"][:7]] += p["openingDebt"]
        paid = 0
        for t in all_tx:
            if t["date"] < p["openingDebtDate"] or t["date"] > until:
                continue
            if t["type"] == "expense" and t.get("paymentMethod") == p["id"]: by[_eff_month(t, dm)] += t["amount"]
            elif t["type"] == "transfer" and t.get("fromPayment") == p["id"]: by[_due_date(p, t["date"])[:7]] += t["amount"]
            elif t["type"] == "transfer" and t.get("toPayment") == p["id"]: paid += t["amount"]
            elif t["type"] == "income" and t.get("paymentMethod") == p["id"]: paid += t["amount"]
        thr = lambda k: sum(a for kk, a in by.items() if kk <= k)
        total = thr("9999-12"); unp = lambda k: max(0, thr(k) - paid)
        due_day = None
        if p.get("dueDay"):
            due_day = f"{min(p['dueDay'], _dim(ny, nm)):02d}/{nm:02d}/{ny}"
        rows.append({"id": p["id"], "name": p.get("name", p["id"]), "unpaidDue": unp(mk), "nextDue": unp(nxt) - unp(mk),
                     "later": max(0, total - paid) - unp(nxt), "total": total - paid, "nextDueDate": due_day})
    return rows


def _balances(cats, all_tx):
    out = []
    for p in map(_norm_pm, cats.get("paymentMethods", [])):
        if p["type"] not in ("cash", "bank"):
            continue
        if not p.get("initialBalanceDate"):
            out.append({**p, "balance": None}); continue
        d = 0
        for t in all_tx:
            if t["date"] < p["initialBalanceDate"] or t.get("excludeFromBalance"):
                continue
            if t["type"] == "transfer":
                d += t["amount"] if t.get("toPayment") == p["id"] else -t["amount"] if t.get("fromPayment") == p["id"] else 0
            elif t.get("paymentMethod") == p["id"]:
                d += t["amount"] if t["type"] == "income" else -t["amount"]
        out.append({**p, "balance": p["initialBalance"] + d})
    return out


def _all_tx():
    d = REPO / "transactions"
    return [t for f in sorted(d.glob("*.json")) for t in (_load(f"transactions/{f.name}", []) or [])]


def _vnd(n):
    return f"{n:,.0f}".replace(",", ".") + "đ"


def _finance_context(detail_rows: bool = True) -> str:
    """Số liệu CHÍNH XÁC tính bằng đúng công thức của app — AI đọc nguyên văn, không tự cộng lại."""
    cats = _load("categories.json", {}) or {}
    name = {("income", c["id"]): c["name"] for c in cats.get("income", [])}
    name.update({("expense", c["id"]): c["name"] for c in cats.get("expense", [])})
    pm = {p["id"]: p.get("name", p["id"]) for p in cats.get("paymentMethods", [])}
    budget = _load("budget.json", {}) or {}
    all_tx = _all_tx(); dm = _debt_map(cats)
    today = date.today(); ts = today.isoformat(); cur = ts[:7]
    V = _vnd
    wd = ["Thứ Hai", "Thứ Ba", "Thứ Tư", "Thứ Năm", "Thứ Sáu", "Thứ Bảy", "Chủ Nhật"]
    mon = today - timedelta(days=today.weekday())
    L = [f"Hôm nay: {wd[today.weekday()]} {today.strftime('%d/%m/%Y')} ({ts}; tháng {cur}, đã qua {today.day}/{_dim(today.year, today.month)} ngày). "
         f"\"Tuần này\" = từ {wd[0]} {mon.strftime('%d/%m')} đến hôm nay; \"hôm qua\" = {(today - timedelta(days=1)).strftime('%d/%m')}.",
         "CÁCH APP TÍNH (bắt buộc dùng đúng): khoản quẹt THẺ TÍN DỤNG / VÍ TRẢ SAU tính vào THÁNG PHẢI TRẢ theo sao kê, KHÔNG phải tháng quẹt "
         "(HSBC chốt ngày 14, hạn ngày 5 tháng sau → quẹt 1–14 trả tháng sau, quẹt 15–cuối tháng trả tháng sau nữa; Mono chốt cuối tháng, hạn ngày 10 tháng sau). "
         "«Chi» của 1 tháng = chi tiền mặt/ngân hàng trong tháng + khoản thẻ/ví đến hạn trong tháng = đúng tổng theo danh mục & ngân sách. "
         "Tiền trả nợ thẻ là trả cho khoản đã tính rồi, KHÔNG cộng thêm vào Chi."]
    bals = _balances(cats, all_tx)
    L.append("TIỀN ĐANG CÓ HÔM NAY: " + "; ".join(f"{b['name']} {V(b['balance']) if b['balance'] is not None else 'chưa cấu hình'}" for b in bals)
             + f" → tổng {V(sum(b['balance'] or 0 for b in bals))}.")
    for r in _debt_schedule(cats, all_tx, cur, ts):
        L.append(f"NỢ {r['name']}: tổng nợ {V(r['total'])}; đã tới hạn mà chưa trả {V(r['unpaidDue'])}; "
                 f"phải trả tháng sau {V(r['nextDue'])}{' (hạn ' + r['nextDueDate'] + ')' if r['nextDueDate'] and r['nextDue'] else ''}; "
                 f"trả các tháng sau nữa {V(r['later'])}.")
    ym = [cur]
    for _ in range(2):
        y, m = map(int, ym[-1].split("-")); y, m = _add_m(y, m, -1); ym.append(f"{y}-{m:02d}")
    y, m = map(int, cur.split("-")); y, m = _add_m(y, m, 1); nxt = f"{y}-{m:02d}"
    for mk in ym:
        s = _month_summary(all_tx, mk, dm)
        by = defaultdict(int)
        for t in s["expenseList"]:
            by[name.get(("expense", t.get("category")), t.get("category"))] += t["amount"]
        top = ", ".join(f"{k} {V(v)}" for k, v in sorted(by.items(), key=lambda x: -x[1]))
        L.append(f"THÁNG {mk}: Thu {V(s['income'])} · Chi {V(s['out'])} (tiền mặt/ngân hàng {V(s['cashOut'])} + thẻ/ví đến hạn {V(s['cardDue'])}) "
                 f"· đã chuyển trả nợ thẻ/ví {V(s['debtPaid'])} · Thu − Chi {V(s['income'] - s['out'])}. Chi theo danh mục: {top or 'chưa có'}.")
    ns = _month_summary(all_tx, nxt, dm)
    L.append(f"THÁNG {nxt} (sắp tới): đã có sẵn {V(ns['cardDue'])} khoản thẻ/ví đến hạn.")
    s = _month_summary(all_tx, cur, dm); spent = defaultdict(int)
    for t in s["expenseList"]:
        spent[t.get("category")] += t["amount"]
    blines = []
    for cid, b in (budget.get("categories") or {}).items():
        vs = [v for v in b.get("versions", []) if v.get("from", "") <= cur and (not v.get("until") or cur <= v["until"])]
        if vs:
            lim = max(vs, key=lambda v: v["from"]).get("monthlyAmount", 0); sp = spent.get(cid, 0)
            blines.append(f"{b.get('name', cid)}: đã chi {V(sp)} / ngân sách {V(lim)} ({'VƯỢT ' + V(sp - lim) if sp > lim else 'còn ' + V(lim - sp)})")
    if blines:
        L.append(f"NGÂN SÁCH THÁNG {cur}: " + "; ".join(blines))
    if detail_rows:
        L.append(f"Chi tiết giao dịch tháng {cur} theo ngày quẹt (ngày|loại|danh mục|số tiền|ghi chú|thanh toán|tính vào tháng):")
        for t in sorted([t for t in all_tx if t["date"][:7] == cur], key=lambda t: t.get("date", ""))[-200:]:
            L.append(f"{t.get('date')}|{t.get('type')}|{name.get((t.get('type'), t.get('category')), t.get('category', ''))}|"
                     f"{t.get('amount', 0):,}|{(t.get('note') or '')[:60]}|{pm.get(t.get('paymentMethod'), t.get('paymentMethod', ''))}|"
                     f"{_eff_month(t, dm) if t.get('type') != 'transfer' else ''}")
    return "\n".join(L)[:30000]


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


IMAGE_PROMPT = ("Đọc ảnh chi tiêu (hoá đơn, bill, ảnh chụp màn hình chuyển khoản/app ngân hàng/ví) cho sổ thu chi gia đình. "
                "Hôm nay là {today}.\nDanh mục/phương thức hợp lệ (CHỈ dùng id trong danh sách):\n{cats}\n\n"
                "{hint}Quy tắc: 1 hoá đơn mua hàng = 1 giao dịch (số TỔNG phải trả, liệt kê vài món chính vào note). "
                "Ảnh lịch sử/sao kê có nhiều dòng = mỗi dòng 1 giao dịch. Tiền vào tài khoản = income. "
                "Ngày trên ảnh đổi sang YYYY-MM-DD; không thấy ngày thì dùng hôm nay. Ảnh mờ/không phải chứng từ thì items rỗng và hỏi lại. "
                "Reply ONLY JSON: "
                '{{"items":[{{"type":"expense|income","date":"YYYY-MM-DD","amount":0,"category":"id","paymentMethod":"id or null",'
                '"priority":"id or null","note":"ngắn: nơi mua + món chính"}}],"summary":"1 câu mô tả ảnh",'
                '"question":"nếu thiếu thông tin quan trọng (vd không rõ trả bằng gì, số mờ) thì 1 câu hỏi lại, không thì rỗng"}}')


def _tx_index(months: int = 2) -> str:
    """Giao dịch N tháng gần nhất KÈM id — để trợ lý chỉ đúng khoản cần sửa/xoá."""
    dm = _debt_map(_load("categories.json", {}) or {})
    out = ["id|ngày|loại|danh mục id|số tiền|thanh toán id|từ|đến|mức độ|ghi chú|tính vào tháng"]
    for mk in _month_keys(months):
        for t in sorted(_load(f"transactions/{mk}.json", []) or [], key=lambda t: t.get("date", ""), reverse=True):
            out.append("|".join(str(t.get(k) or "") for k in ("id", "date", "type", "category", "amount", "paymentMethod",
                                                              "fromPayment", "toPayment", "priority")) + "|" + (t.get("note") or "")[:50]
                       + "|" + (_eff_month(t, dm) if t.get("type") != "transfer" else ""))
    return "\n".join(out[:400])


AGENT_PROMPT = """Bạn là trợ lý GIỌNG NÓI của app Sổ Thu Chi gia đình, đang nói chuyện với {who}. Hôm nay {today}.
Bạn giúp: (1) TẠO giao dịch mới, (2) SỬA giao dịch, (3) XOÁ giao dịch, (4) TRA CỨU/hỏi đáp số liệu.
Nguyên tắc:
- Hỏi TỪNG câu ngắn cho tới khi đủ thông tin. Tạo giao dịch chi cần: số tiền, danh mục, ngày (mặc định hôm nay),
  phương thức thanh toán; mức độ cần thiết và ghi chú là tuỳ chọn (tự đoán hợp lý, không cần hỏi). Chuyển khoản cần từ/đến.
- Mặc định là khoản CHI (chỉ là thu khi người dùng nói lương, được cho, nhận, hoàn tiền…) — đừng hỏi "thu hay chi".
- DANH MỤC và mức độ: đoán được thì đoán (vd "phở" → Tiền ăn sáng/chiều). 'k'=nghìn, 'tr'/'triệu'=triệu, 'lít'=trăm nghìn.
- PHƯƠNG THỨC THANH TOÁN: KHÔNG tự đoán. Người dùng chưa nói thì HỎI ("Trả bằng tiền mặt, ngân hàng hay thẻ?"). Có thể gợi ý cái hay dùng.
- SỬA/XOÁ: tìm đúng giao dịch trong danh sách có id bên dưới. Nhiều khoản khớp thì liệt kê ngắn để người dùng chọn. KHÔNG BAO GIỜ bịa id.
- Đủ thông tin → ready=true, câu "say" phải ĐỌC LẠI tóm tắt và hỏi "Lưu nhé?" / "Xoá nhé?". App sẽ tự hỏi xác nhận, bạn KHÔNG tự lưu.
  BẮT BUỘC nhất quán: hễ "say" hỏi "Lưu nhé?"/"Xoá nhé?" thì ready PHẢI là true (ready=false chỉ khi còn đang HỎI thông tin thiếu).
- Người dùng từ chối hoặc muốn sửa → cập nhật draft theo ý họ, ready=true lại khi đủ.
- Lượt trước bạn đã đọc lại tóm tắt mà người dùng ĐỒNG Ý (ok, lưu đi, ừ, được, đúng rồi… kể cả nói lặp "lưu lưu đi ok" hay
  đọc lại y câu cũ kèm "ok") → trả NGUYÊN draft cũ với ready=true. TUYỆT ĐỐI không hỏi lại "Lưu nhé?" lần nữa.
- "say" để ĐỌC TO: tối đa 2 câu, tự nhiên, không markdown, số tiền đọc kiểu "50 nghìn", "1 triệu 2".
- Tra cứu: trả lời ngắn trong "say" bằng SỐ CÓ SẴN trong phần SỐ LIỆU (tiền đang có, nợ, Chi tháng, ngân sách) — không tự cộng lại.
  Hỏi "chi tháng này" = dùng đúng số «Chi» của tháng. Chỉ khi hỏi 1 danh mục/khoảng ngày cụ thể mới được cộng từ danh sách giao dịch.
  "Khoản chi lớn nhất" = 1 GIAO DỊCH đơn lẻ (xem danh sách), khác "danh mục chi nhiều nhất".
  "detail" chỉ khi thật cần (tối đa 6 dòng Markdown), còn lại để rỗng — trả lời càng ngắn càng nhanh.
- Chỉ dùng id danh mục/phương thức trong danh sách hợp lệ.

DANH MỤC & PHƯƠNG THỨC HỢP LỆ: {cats}

SỐ LIỆU TỔNG HỢP:
{ctx}

GIAO DỊCH 2 THÁNG GẦN NHẤT (có id):
{index}

{page}{images}HỘI THOẠI:
{conv}
{who}: {text}

Reply ONLY JSON (không thêm chữ nào khác):
{{"say":"...","detail":"markdown hoặc rỗng","intent":"create|update|delete|query|chat",
"draft":{{"id":"chỉ khi update/delete","type":"expense|income|transfer","date":"YYYY-MM-DD","amount":0,"category":"id","paymentMethod":"id|null",
"fromPayment":"id|null","toPayment":"id|null","priority":"id|null","note":""}},"ready":false,"items":[]}}
(draft = null khi query/chat; với update: draft là giao dịch SAU khi sửa, đủ mọi trường; với delete: chỉ cần id.
"items" CHỈ dùng khi ảnh có từ 2 giao dịch trở lên: mỗi phần tử có dạng như draft (không có id), khi đó intent=create, draft=null)"""

AGENT_IMAGE_NOTE = """ẢNH NGƯỜI DÙNG VỪA GỬI ({n} ảnh — hoá đơn, bill, ảnh chụp màn hình chuyển khoản/app ngân hàng/ví…):
- Đọc kỹ từng ảnh bằng công cụ Read. Lấy số TỔNG phải trả (không lấy tiền khách đưa/tiền thối), ngày trên ảnh (không thấy thì hôm nay),
  nơi mua + vài món chính cho note. Câu người dùng gõ kèm (nếu có) được ưu tiên hơn nội dung ảnh.
- 1 hoá đơn = 1 giao dịch → dùng "draft". Ảnh lịch sử/sao kê nhiều dòng, hoặc nhiều ảnh nhiều hoá đơn → mỗi khoản 1 phần tử trong "items".
- Tiền VÀO tài khoản = income. Chuyển khoản giữa 2 tài khoản của chính gia đình = transfer.
- Phương thức thanh toán: CHỈ điền khi ảnh cho thấy rõ (ảnh app ngân hàng/ví/thẻ khớp 1 phương thức trong danh sách, hoặc hoá đơn ghi "tiền mặt"/"thẻ").
  Không rõ → để null, ready=false và HỎI 1 câu (câu trả lời áp dụng cho mọi khoản trong ảnh).
- So với danh sách giao dịch có id ở trên: khoản nào cùng ngày + cùng số tiền đã có sẵn thì CẢNH BÁO có thể đã nhập rồi và KHÔNG đưa vào nữa trừ khi người dùng bảo vẫn lưu.
- Ảnh mờ / không phải chứng từ chi tiêu → intent=chat, nói rõ đọc được gì và hỏi lại.
- "say" tóm tắt ngắn những gì đọc được (vd "Hoá đơn Bách Hoá Xanh 167 nghìn ngày 18/9") rồi hỏi "Lưu nhé?" hoặc hỏi phần còn thiếu.

"""


def _bridge(prompt: str, images: list | None = None, fast: bool = False) -> str:
    # Phong bì JSON cho cầu nối CT104: ảnh (19/09) + model/effort/system prompt ngắn khi cần nhanh (22/09)
    if images or fast:
        env = {"__bridge": 1, "prompt": prompt, "images": images or []}
        if fast:
            env.update(model=AI_AGENT_MODEL, effort=AI_AGENT_EFFORT, system=FAST_SYSTEM)
        prompt = json.dumps(env)
    r = subprocess.run(["ssh", "-i", BRIDGE_KEY, "-o", "BatchMode=yes", "-o", "ConnectTimeout=15",
                        "-o", "StrictHostKeyChecking=accept-new", "-o", f"UserKnownHostsFile={Path(BRIDGE_KEY).parent / 'known_hosts'}",
                        BRIDGE_HOST], input=prompt, capture_output=True, text=True, timeout=600)
    if r.returncode != 0 or not r.stdout.strip():
        err = (r.stderr or "").strip()
        m = re.search(r"resets\s+([0-9:]+\s*[ap]m)\s*\(UTC\)", err, re.I)
        if m:  # đổi giờ mở lại từ UTC sang giờ VN cho dễ hiểu
            try:
                t = datetime.strptime(m.group(1).replace(" ", "").upper(), "%I:%M%p") + timedelta(hours=7)
                raise RuntimeError(f"Claude đã hết hạn mức phiên — mở lại lúc {t.strftime('%H:%M')} (giờ VN). Trong lúc chờ vẫn nhập tay bình thường.")
            except ValueError:
                pass
        if re.search(r"limit|429", err, re.I):
            raise RuntimeError("Claude đang hết hạn mức — thử lại sau. Trong lúc chờ vẫn nhập tay bình thường.")
        raise RuntimeError("Không gọi được Claude (cầu nối CT104)")
    return r.stdout.strip()


def _run_ai(jid: str, mode: str, text: str, history: list, who: str = "bạn", page: str = "", images: list | None = None):
    try:
        if mode == "agent":
            conv = "\n".join(f"{who if h.get('role') == 'user' else 'Trợ lý'}: {h.get('content', '')}" for h in history[-14:])
            page_note = f"NGƯỜI DÙNG ĐANG XEM: {page[:1000]}\n\n" if page else ""
            img_note = AGENT_IMAGE_NOTE.format(n=len(images)) if images else ""
            raw = _bridge(AGENT_PROMPT.format(who=who, today=date.today().isoformat(), cats=_categories_brief(), ctx=_finance_context(detail_rows=False)[:12000],
                                              index=_tx_index(), page=page_note, images=img_note, conv=conv,
                                              text=text[:1500] or "(chỉ gửi ảnh, không ghi chú)"), images or None, fast=True)
            try:
                res = {"agent": json.loads(raw[raw.find("{"):raw.rfind("}") + 1])}
            except Exception:  # AI không trả JSON → coi như câu trả lời thường
                res = {"agent": {"say": raw[:600], "detail": "", "intent": "chat", "draft": None, "ready": False}}
        elif mode == "image":
            hint = f"Người dùng ghi chú thêm: \"{text[:500]}\"\n" if text else ""
            raw = _bridge(IMAGE_PROMPT.format(today=date.today().isoformat(), cats=_categories_brief(), hint=hint), images)
            res = {"scan": json.loads(raw[raw.find("{"):raw.rfind("}") + 1])}
        elif mode == "parse":
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
    if mode not in ("chat", "review", "parse", "image", "agent"):
        raise HTTPException(400, "Chế độ AI không hợp lệ")
    images = []
    if mode in ("image", "agent"):
        for im in (body.get("images") or [])[:4]:
            ext = str(im.get("ext", "")).lower()
            b64 = str(im.get("b64", ""))
            if ext not in ("jpg", "jpeg", "png", "webp") or not b64 or len(b64) > 11_000_000:
                raise HTTPException(400, "Ảnh không hợp lệ (chỉ JPG/PNG/WEBP, tối đa 8MB)")
            images.append({"ext": ext, "b64": b64})
        if mode == "image" and not images:
            raise HTTPException(400, "Chưa có ảnh")
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
                                                        NAMES.get(email, "bạn"), str(body.get("page", "")), images), daemon=True).start()
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
