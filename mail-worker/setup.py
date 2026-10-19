#!/usr/bin/env python3
"""Dựng phía Cloudflare cho tính năng "mail ngân hàng → Sổ Thu Chi tự ghi". 3T TỰ CHẠY trên Mac:

    python3 ~/Personal/personal-finance-app/mail-worker/setup.py            # dựng / xoay secret (chạy lại được)
    python3 ~/Personal/personal-finance-app/mail-worker/setup.py --teardown # gỡ sạch mọi thứ đã tạo
    python3 ~/Personal/personal-finance-app/mail-worker/setup.py --code-only # chỉ đưa lại code Worker, giữ nguyên secret

Làm 5 việc (token lấy từ Keychain `cloudflare-api-token`, giống bin/cf — KHÔNG in secret ra màn hình):
  1. Access service token `sothuchi-mail-ingest` (secret chỉ đi thẳng vào Worker, không lưu ở đâu khác)
  2. Policy + Access app RIÊNG cho đường dẫn taichinh.dichvunamtrung.com/api/ingest (chỉ service token, KHÔNG đụng
     app chính đang bảo vệ Sổ bằng MFA — path cụ thể hơn thì Access ưu tiên)
  3. Email Worker `sothuchi-mail` (code ở index.js cùng thư mục) kèm secret CF_ID / CF_SECRET
  4. Email Routing rule: địa chỉ ngẫu nhiên sotc-xxxxxxxxxx@dichvunamtrung.com → Worker
  5. Ghi ~/.sothuchi-ingest.json (chmod 600) — CHỈ chứa thông tin không bí mật: client_id, aud, địa chỉ nhận
"""
import json
import os
import secrets
import string
import subprocess
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path

API = "https://api.cloudflare.com/client/v4"
DOMAIN = "dichvunamtrung.com"  # ACC/ZONE tra lúc chạy (không đưa ID tài khoản vào repo công khai)
APP_DOMAIN = "taichinh.dichvunamtrung.com/api/ingest"
INGEST_URL = "https://taichinh.dichvunamtrung.com/api/ingest"
WORKER = "sothuchi-mail"
TOKEN_NAME = "sothuchi-mail-ingest"
POLICY_NAME = "sothuchi-ingest service token"
RULE_NAME = "sothuchi-mail"
STATE = Path.home() / ".sothuchi-ingest.json"
HERE = Path(__file__).resolve().parent
NEED = ("Token Cloudflare thiếu quyền. Cần các quyền: Account > Access: Service Tokens (Edit), Account > Access: Apps and "
        "Policies (Edit), Account > Workers Scripts (Edit), Zone > Email Routing Rules (Edit). Thêm ở "
        "dash.cloudflare.com > My Profile > API Tokens > sửa token `cloudflare-api-token`, rồi chạy lại script.")


def token() -> str:
    p = subprocess.run(["security", "find-generic-password", "-w", "-s", "cloudflare-api-token"], capture_output=True, text=True)
    if p.returncode != 0 or not p.stdout.strip():
        sys.exit("Không lấy được token từ Keychain (service 'cloudflare-api-token').")
    return p.stdout.strip()


TOK = token()


def call(method, path, body=None, raw=None, ctype="application/json", ok_404=False):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(API + path, method=method, data=data,
                                 headers={"Authorization": f"Bearer {TOK}", "Content-Type": ctype})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read()).get("result")
    except urllib.error.HTTPError as e:
        txt = e.read().decode("utf-8", "replace")
        if ok_404 and e.code == 404:
            return None
        if e.code in (401, 403) or "Authentication error" in txt:
            sys.exit(f"❌ {method} {path} → {e.code}\n{NEED}")
        sys.exit(f"❌ {method} {path} → {e.code}\n{txt[:600]}")


_zones = call("GET", f"/zones?name={DOMAIN}")
if not _zones:
    sys.exit(f"Không tìm thấy zone {DOMAIN} (token thiếu quyền Zone > Read?)")
ACC, ZONE = _zones[0]["account"]["id"], _zones[0]["id"]


def owner_email() -> str:
    """Hộp thư chủ (đã xác minh ở Email Routing > Destination addresses) — đọc từ file cục bộ, không ghi vào repo công khai."""
    v = json.loads(STATE.read_text()).get("owner_email") if STATE.is_file() else None
    if not v:
        sys.exit(f"Thiếu 'owner_email' trong {STATE} (thêm email chủ hộp thư vào file đó rồi chạy lại).")
    return v


def worker_upload(client_id: str, client_secret: str):
    meta = {"main_module": "index.js", "compatibility_date": "2026-10-01", "bindings": [
        {"type": "plain_text", "name": "INGEST_URL", "text": INGEST_URL},
        {"type": "plain_text", "name": "OWNER_EMAIL", "text": owner_email()},
        {"type": "secret_text", "name": "CF_ID", "text": client_id},
        {"type": "secret_text", "name": "CF_SECRET", "text": client_secret}]}
    b = uuid.uuid4().hex
    code = (HERE / "index.js").read_bytes()
    parts = (f'--{b}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n'.encode()
             + json.dumps(meta).encode()
             + f'\r\n--{b}\r\nContent-Disposition: form-data; name="index.js"; filename="index.js"\r\n'
               f'Content-Type: application/javascript+module\r\n\r\n'.encode() + code + f"\r\n--{b}--\r\n".encode())
    call("PUT", f"/accounts/{ACC}/workers/scripts/{WORKER}", raw=parts, ctype=f"multipart/form-data; boundary={b}")


def worker_code_only():
    """Đưa lại code index.js, GIỮ NGUYÊN secret CF_ID / CF_SECRET đang có (không cần biết secret)."""
    meta = {"main_module": "index.js", "compatibility_date": "2026-10-01", "keep_bindings": ["secret_text"], "bindings": [
        {"type": "plain_text", "name": "INGEST_URL", "text": INGEST_URL},
        {"type": "plain_text", "name": "OWNER_EMAIL", "text": owner_email()}]}
    b = uuid.uuid4().hex
    code = (HERE / "index.js").read_bytes()
    parts = (f'--{b}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n'.encode()
             + json.dumps(meta).encode()
             + f'\r\n--{b}\r\nContent-Disposition: form-data; name="index.js"; filename="index.js"\r\n'
               f'Content-Type: application/javascript+module\r\n\r\n'.encode() + code + f"\r\n--{b}--\r\n".encode())
    call("PUT", f"/accounts/{ACC}/workers/scripts/{WORKER}", raw=parts, ctype=f"multipart/form-data; boundary={b}")
    print("✅ đã cập nhật code Worker (secret giữ nguyên)")


def find(items, key, val):
    return next((i for i in (items or []) if i.get(key) == val), None)


def teardown():
    st = json.loads(STATE.read_text()) if STATE.is_file() else {}
    for r in call("GET", f"/zones/{ZONE}/email/routing/rules") or []:
        if r.get("name") == RULE_NAME:
            call("DELETE", f"/zones/{ZONE}/email/routing/rules/{r['id']}"); print("đã xoá Email Routing rule")
    app = find(call("GET", f"/accounts/{ACC}/access/apps"), "domain", APP_DOMAIN)
    if app:
        call("DELETE", f"/accounts/{ACC}/access/apps/{app['id']}"); print("đã xoá Access app")
    pol = find(call("GET", f"/accounts/{ACC}/access/policies"), "name", POLICY_NAME)
    if pol:
        call("DELETE", f"/accounts/{ACC}/access/policies/{pol['id']}"); print("đã xoá policy")
    tk = find(call("GET", f"/accounts/{ACC}/access/service_tokens"), "name", TOKEN_NAME)
    if tk:
        call("DELETE", f"/accounts/{ACC}/access/service_tokens/{tk['id']}"); print("đã xoá service token")
    call("DELETE", f"/accounts/{ACC}/workers/scripts/{WORKER}", ok_404=True); print("đã xoá Worker")
    STATE.unlink(missing_ok=True)
    print("✅ Gỡ xong. Nhớ gỡ bộ lọc chuyển tiếp trong Gmail nếu đã tạo, và bỏ INGEST_* trong .env của CT107.")


def main():
    if "--teardown" in sys.argv:
        return teardown()
    if "--code-only" in sys.argv:
        return worker_code_only()
    # 1. service token (đã có → xoay secret mới; chưa có → tạo)
    tk = find(call("GET", f"/accounts/{ACC}/access/service_tokens"), "name", TOKEN_NAME)
    if tk:
        res = call("POST", f"/accounts/{ACC}/access/service_tokens/{tk['id']}/rotate")
        print("1/5 service token: đã xoay secret mới")
    else:
        res = call("POST", f"/accounts/{ACC}/access/service_tokens", {"name": TOKEN_NAME, "duration": "8760h"})
        print("1/5 service token: đã tạo (hiệu lực 1 năm)")
    token_id, client_id, client_secret = res["id"], res["client_id"], res["client_secret"]
    # 2. policy + app riêng cho /api/ingest
    pol = find(call("GET", f"/accounts/{ACC}/access/policies"), "name", POLICY_NAME)
    pbody = {"name": POLICY_NAME, "decision": "non_identity", "include": [{"service_token": {"token_id": token_id}}]}
    pol = call("PUT", f"/accounts/{ACC}/access/policies/{pol['id']}", pbody) if pol else call("POST", f"/accounts/{ACC}/access/policies", pbody)
    app = find(call("GET", f"/accounts/{ACC}/access/apps"), "domain", APP_DOMAIN)
    abody = {"name": "sothuchi-ingest", "domain": APP_DOMAIN, "type": "self_hosted", "session_duration": "24h",
             "app_launcher_visible": False, "policies": [{"id": pol["id"], "precedence": 1}]}
    app = call("PUT", f"/accounts/{ACC}/access/apps/{app['id']}", abody) if app else call("POST", f"/accounts/{ACC}/access/apps", abody)
    aud = app["aud"]
    print("2/5 Access app riêng cho /api/ingest: OK")
    # 3. Worker + secret
    worker_upload(client_id, client_secret)
    del client_secret
    print("3/5 Email Worker `sothuchi-mail`: đã đưa lên")
    # 4. Email Routing rule (địa chỉ ngẫu nhiên, giữ nguyên nếu đã có)
    st = json.loads(STATE.read_text()) if STATE.is_file() else {}
    addr = st.get("address") or ("sotc-" + "".join(secrets.choice(string.ascii_lowercase + string.digits) for _ in range(10)) + "@" + DOMAIN)
    rbody = {"name": RULE_NAME, "enabled": True, "matchers": [{"type": "literal", "field": "to", "value": addr}],
             "actions": [{"type": "worker", "value": [WORKER]}]}
    rule = find(call("GET", f"/zones/{ZONE}/email/routing/rules"), "name", RULE_NAME)
    call("PUT", f"/zones/{ZONE}/email/routing/rules/{rule['id']}", rbody) if rule else call("POST", f"/zones/{ZONE}/email/routing/rules", rbody)
    print("4/5 Email Routing rule: OK")
    # 5. ghi thông tin KHÔNG bí mật
    STATE.write_text(json.dumps({"client_id": client_id, "aud": aud, "address": addr}, indent=1))
    STATE.chmod(0o600)
    print(f"5/5 đã ghi {STATE} (client_id, aud, địa chỉ nhận — không có secret)")
    print(f"\n✅ XONG. Địa chỉ nhận thư: {addr}\n   Việc tiếp theo: nhắn Claude 'đã chạy setup' để Claude cấu hình CT107; sau đó tạo bộ lọc Gmail chuyển tiếp tới địa chỉ trên.")


if __name__ == "__main__":
    main()
