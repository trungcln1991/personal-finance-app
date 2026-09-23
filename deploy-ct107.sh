#!/bin/bash
# Deploy 3 file (ai-drawer.js, app.py, sw.js) lên CT107 production — có backup code trước.
# Chạy từ Mac:  bash ~/Personal/personal-finance-app/deploy-ct107.sh
set -e
cd "$(dirname "$0")"
H=root@100.94.133.67; K=~/.ssh/id_ed25519_pce5
scp -q -i $K js/ai-drawer.js server/app.py sw.js $H:/root/
ssh -i $K $H 'set -e; B=$(date +%Y%m%d-%H%M%S)
pct exec 107 -- bash -c "cd /opt && tar czf /root/taichinh-code-before-$B.tgz --exclude=server/.env taichinh"
echo "Backup: CT107 /root/taichinh-code-before-$B.tgz"
pct push 107 /root/ai-drawer.js /opt/taichinh/js/ai-drawer.js
pct push 107 /root/app.py /opt/taichinh/server/app.py
pct push 107 /root/sw.js /opt/taichinh/sw.js
cd /root && rm ai-drawer.js app.py sw.js
pct exec 107 -- bash -c "cd /opt/taichinh/server && docker-compose up -d --build 2>&1 | tail -2; sleep 5; docker ps --format \"{{.Names}} {{.Status}}\""'
echo "Xong. Rollback: pct exec 107 -- tar xzf /root/taichinh-code-before-<B>.tgz -C /opt  rồi  docker-compose up -d --build"
