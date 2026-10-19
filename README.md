# Sổ Thu Chi — Personal Finance App

App quản lý tài chính cá nhân, chạy trên trình duyệt, host miễn phí qua GitHub Pages. Dữ liệu
(giao dịch/danh mục/ngân sách) lưu dưới dạng JSON trong repo private
[`personal-finance-data`](https://github.com/trungcln1991/personal-finance-data) — mỗi lần
thêm/sửa giao dịch là một commit, nên có lịch sử chỉnh sửa và backup tự động, miễn phí.

Token GitHub thật **không** nằm trong trình duyệt hay trong code (code ở repo `personal-finance-app`
là public). Nó được giữ ở server trung gian [`worker/`](worker/) (Cloudflare Worker, free tier) —
app chỉ cần 1 mật khẩu ngắn tự đặt để đăng nhập trên mỗi thiết bị.

## Chạy thử ngay (production)

👉 **https://trungcln1991.github.io/personal-finance-app/**

Lần đầu mở app trên mỗi thiết bị sẽ yêu cầu đăng nhập bằng mật khẩu app (xem `worker/README.md`
để biết cách đặt mật khẩu). Phiên đăng nhập có hiệu lực 90 ngày trên thiết bị đó.

## Kiến trúc

```
Trình duyệt (personal-finance-app, repo public — GitHub Pages)
        │  mật khẩu app → session token
        ▼
Cloudflare Worker (personal-finance-proxy, worker/) — giữ GITHUB_TOKEN thật
        │  Bearer GITHUB_TOKEN
        ▼
GitHub Contents API → repo personal-finance-data (private)
  ├── categories.json
  ├── budget.json
  └── transactions/YYYY-MM.json
```

Không có database riêng — Git chính là database, có versioning/audit trail miễn phí. Chi tiết
deploy Worker: [`worker/README.md`](worker/README.md).

## Cài lên điện thoại (PWA)

App có `manifest.json` + service worker, mở link trên Safari/Chrome mobile → **Thêm vào Màn
hình chính** để dùng như app thật, có icon riêng, mở nhanh không qua trình duyệt.

## Phát triển local

Không cần build step, chỉ cần serve tĩnh (module JS cần chạy qua http, không mở trực tiếp file://):

```bash
npx serve .
# hoặc
python3 -m http.server 8080
```

## Cấu trúc code

```
index.html         Dashboard: tổng thu/chi, biểu đồ theo danh mục & mức ưu tiên, tiến độ ngân sách
add.html            Form thêm/sửa giao dịch
transactions.html   Danh sách giao dịch theo tháng, sửa/xoá
settings.html       Đăng nhập, quản lý danh mục/PP thanh toán/ngân sách
js/config.js        Owner/repo GitHub chứa data + URL Worker
js/github-api.js    Gọi Worker (đăng nhập, đọc/ghi file JSON qua proxy, base64 UTF-8 an toàn)
js/store.js         Lớp nghiệp vụ: CRUD giao dịch, format tiền VNĐ, tính tháng
js/nav.js           Thanh điều hướng dưới + nút Thêm nổi, chặn truy cập khi chưa đăng nhập
worker/             Cloudflare Worker proxy — xem worker/README.md để deploy
```

## Tự ghi giao dịch từ mail ngân hàng (19/10/2026)
Thư chi tiêu tự thành giao dịch trong sổ: HSBC (thẻ tín dụng), VCB (biên lai chuyển khoản/thanh toán + thông báo thẻ ghi nợ, bỏ qua giao dịch thất bại/ngoại tệ), MoMo (hóa đơn), Apple (biên nhận).

```
Gmail (bộ lọc chuyển tiếp) → sotc-xxxxxxxxxx@dichvunamtrung.com → Cloudflare Email Routing → Email Worker
   → POST thư thô lên taichinh.dichvunamtrung.com/api/ingest (Access service token) → server/mailingest.py → git commit
```
- `server/mailingest.py`: đọc thư bằng **regex cứng** (không LLM), danh sách trắng người gửi (`notification.hsbc.com.hk`,
  `info.vietcombank.com.vn`), khoản lạ ghi kèm `[?]` ở ghi chú để tìm và sửa. Test: `cd server && python3 -m unittest test_mailingest`.
- **Chống trùng**: mỗi thư 1 lần (state ở volume `/state`); nếu sổ đã có khoản y hệt (cùng tiền + phương thức, lệch ≤ 1 ngày)
  do nhập tay/AI thì chỉ "nhận khớp", không thêm. HSBC: đối chiếu "Dư nợ hiện tại" liên tiếp → báo nếu sót khoản.
- Env CT107 (`server/.env`): `INGEST_CLIENT_IDS`, `INGEST_AUD` (Access app riêng cho `/api/ingest`), `INGEST_VCB_ACCOUNT`,
  `INGEST_HSBC_CARD` (4 số cuối), tuỳ chọn `INGEST_NOTIFY_URL` (ntfy). KHÔNG hardcode trong repo.
- **Kiểm DKIM MẶC ĐỊNH BẬT** (`INGEST_REQUIRE_DKIM`, chỉ đặt `0` tạm khi chẩn đoán): chỉ tin dòng `Authentication-Results` TRÊN CÙNG do máy nhận tin cậy
  (`INGEST_TRUSTED_AUTHSERV`, mặc định `mx.cloudflare.net`) chèn, miền DKIM so khớp chính xác; ARC/X-Original và dòng kẻ gửi tự nhét bị bỏ qua.
  Thư không đạt → bỏ qua + ghi `mail-log` (an toàn khi lỗi). Nếu Cloudflare không gắn header này thì mọi thư sẽ bị bỏ qua → xem log, đừng tắt cho tới khi hiểu header thật.
- Dựng Cloudflare: `python3 mail-worker/setup.py` (3T tự chạy; `--teardown` để gỡ). Deploy CT107: `bash deploy-ct107-ingest.sh`.
- **Chống trùng chéo nguồn**: cùng 1 lần trả mà có 2 thư (vd Apple + MoMo) chỉ ghi 1 giao dịch. **Chủ hộp thư tự chuyển tiếp tay** 1 thư chi tiêu tới địa chỉ `sotc-…` cũng được đọc (cần `INGEST_OWNER_EMAIL` + dkim gmail.com) — dùng để nạp thư cũ/thử nghiệm.
- Xem log: `GET /api/mail-log` (cần đăng nhập Access) — chỉ chứa trạng thái, không chứa nội dung thư.
