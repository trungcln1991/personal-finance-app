# personal-finance-proxy (Cloudflare Worker)

Server trung gian miễn phí giữ token GitHub thật ở phía server, để app chỉ cần 1 mật khẩu ngắn
đăng nhập trên mỗi thiết bị (không phải copy-paste token GitHub dài, và token thật không bao giờ
nằm trong trình duyệt hay trong code public).

```
Trình duyệt (app public) --mật khẩu--> Worker --GITHUB_TOKEN--> GitHub API (repo private)
```

## Bước 1 — Tạo tài khoản Cloudflare (miễn phí)

Vào https://dash.cloudflare.com/sign-up → tạo tài khoản free. Không cần gắn domain nào cả,
Workers free tier có sẵn subdomain `*.workers.dev`.

## Bước 2 — Đăng nhập wrangler CLI

Chạy trong thư mục này (`personal-finance-app/worker`):

```bash
npx wrangler login
```

Lệnh sẽ mở trình duyệt để bạn đăng nhập/uỷ quyền Cloudflare — làm theo hướng dẫn trên màn hình.

## Bước 3 — Set 3 secret (chạy từng lệnh, KHÔNG gõ giá trị trực tiếp trên dòng lệnh mà để
wrangler hỏi rồi dán vào, tránh lưu lại trong lịch sử terminal)

```bash
npx wrangler secret put GITHUB_TOKEN
```
→ dán fine-grained PAT bạn đã tạo cho repo `personal-finance-data` (quyền Contents Read/write).

```bash
npx wrangler secret put APP_PASSWORD
```
→ tự đặt 1 mật khẩu ngắn, dễ nhớ — đây là mật khẩu bạn sẽ dùng để đăng nhập app trên mọi thiết bị.

```bash
npx wrangler secret put SESSION_SECRET
```
→ dán chuỗi ngẫu nhiên bất kỳ (không cần nhớ, chỉ dùng để ký session token nội bộ), ví dụ:
```
cd56de2b685eabe8e6d1ce2f93e4f4c89d4e949d8c8bfbffd0e1f8def3784245
```

## Bước 4 — Deploy

```bash
npx wrangler deploy
```

Kết quả in ra URL dạng `https://personal-finance-proxy.<subdomain-của-bạn>.workers.dev`.

## Bước 5 — Cập nhật app trỏ đúng URL Worker

Mở `../js/config.js`, sửa dòng `WORKER_URL` thành đúng URL vừa deploy, sau đó commit/push repo
`personal-finance-app`.

## Đổi mật khẩu / xoay vòng token sau này

- Đổi mật khẩu: `npx wrangler secret put APP_PASSWORD` (ghi đè giá trị cũ) — mọi phiên đăng nhập
  cũ trên các thiết bị khác vẫn còn hiệu lực tới khi hết hạn 90 ngày, chỉ có lần đăng nhập MỚI mới
  cần mật khẩu mới.
- Xoay vòng token GitHub: tạo PAT mới trong GitHub → `npx wrangler secret put GITHUB_TOKEN` ghi đè.
- Muốn "đăng xuất" toàn bộ thiết bị ngay lập tức: đổi `SESSION_SECRET` — mọi session token cũ ký
  bằng secret cũ sẽ hết hiệu lực ngay, tất cả thiết bị phải đăng nhập lại.
