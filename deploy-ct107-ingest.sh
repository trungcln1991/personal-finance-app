#!/bin/bash
# Deploy tính năng "mail ngân hàng -> Sổ Thu Chi" lên CT107 (production) — có backup trước. Chạy lại được.
# Giai đoạn 1 (chưa có ~/.sothuchi-ingest.json): chỉ đưa code + volume /state, endpoint /api/ingest vẫn đóng (401).
# Giai đoạn 2 (đã chạy mail-worker/setup.py): thêm INGEST_* (KHÔNG bí mật) vào .env rồi dựng lại.
#   Chạy từ Mac:  bash ~/Personal/personal-finance-app/deploy-ct107-ingest.sh
set -e
cd "$(dirname "$0")"
H=root@100.94.133.67; K=~/.ssh/id_ed25519_pce5
ENVLINES=""
if [ -f ~/.sothuchi-ingest.json ]; then
  ENVLINES=$(python3 - <<'PY'
import json,os
d=json.load(open(os.path.expanduser("~/.sothuchi-ingest.json")))
m={"INGEST_CLIENT_IDS":"client_id","INGEST_AUD":"aud","INGEST_VCB_ACCOUNT":"vcb_account","INGEST_HSBC_CARD":"hsbc_card","INGEST_NOTIFY_URL":"notify_url","INGEST_REQUIRE_DKIM":"require_dkim","INGEST_TRUSTED_AUTHSERV":"trusted_authserv","INGEST_OWNER_EMAIL":"owner_email","INGEST_DISABLED_KINDS":"disabled_kinds"}
for k,v in m.items():
    if d.get(v): print(f"{k}={d[v]}")
PY
)
fi
ssh -i $K $H 'mkdir -p /root/ingest-deploy'
scp -q -i $K server/app.py server/mailingest.py server/Dockerfile server/docker-compose.yml $H:/root/ingest-deploy/
printf '%s\n' "$ENVLINES" | ssh -i $K $H 'cat > /root/ingest-deploy/env.add'
ssh -i $K $H 'set -e; B=$(date +%Y%m%d-%H%M%S)
pct exec 107 -- bash -c "cd /opt && tar czf /root/taichinh-code-before-ingest-$B.tgz --exclude=server/.env taichinh && cp -a taichinh/server/.env taichinh/server/.env.bak-ingest-$B"
echo "Backup: CT107 /root/taichinh-code-before-ingest-$B.tgz (+ .env.bak-ingest-$B)"
pct exec 107 -- bash -c "mkdir -p /opt/taichinh-state && chown 1000:1000 /opt/taichinh-state"
for f in app.py mailingest.py Dockerfile docker-compose.yml; do pct push 107 /root/ingest-deploy/$f /opt/taichinh/server/$f; done
if [ -s /root/ingest-deploy/env.add ]; then
  pct push 107 /root/ingest-deploy/env.add /root/env.add
  pct exec 107 -- bash -c "cd /opt/taichinh/server && grep -v ^INGEST_ .env > .env.new && cat /root/env.add >> .env.new && cat .env.new > .env && rm -f .env.new /root/env.add && chmod 600 .env"
  echo ".env: đã cập nhật $(grep -c . /root/ingest-deploy/env.add) biến INGEST_*"
fi
rm -f /root/ingest-deploy/*; rmdir /root/ingest-deploy
pct exec 107 -- bash -c "cd /opt/taichinh/server && docker-compose up -d --build 2>&1 | tail -2; sleep 6; docker ps --format \"{{.Names}} {{.Status}}\"; docker exec taichinh python3 -c \"import urllib.request;print(urllib.request.urlopen(\\\"http://127.0.0.1:8000/api/health\\\").read().decode())\"; docker exec taichinh sh -c \"touch /state/.t && rm /state/.t && echo state-writable\""'
echo "Xong. Rollback: pct exec 107 -- tar xzf /root/taichinh-code-before-ingest-<B>.tgz -C /opt (+ cp .env.bak-ingest-<B> .env) rồi docker-compose up -d --build"
