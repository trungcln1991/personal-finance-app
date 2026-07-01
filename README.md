# Sổ Thu Chi — Personal Finance App

App quản lý tài chính cá nhân, chạy hoàn toàn trên trình duyệt (không có server), host miễn phí
qua GitHub Pages. Dữ liệu (giao dịch/danh mục/ngân sách) lưu dưới dạng JSON trong repo private
[`personal-finance-data`](https://github.com/trungcln1991/personal-finance-data), ghi trực tiếp
qua GitHub API — mỗi lần thêm/sửa giao dịch là một commit, nên có lịch sử chỉnh sửa và backup
tự động, miễn phí.

## Chạy thử ngay (production)

👉 **https://trungcln1991.github.io/personal-finance-app/**

Lần đầu mở app sẽ yêu cầu nhập token GitHub (xem hướng dẫn bên dưới).

## Bước 1 — Tạo Personal Access Token

1. Vào **github.com → avatar góc phải → Settings → Developer settings → Personal access tokens
   → Fine-grained tokens → Generate new token**
2. **Repository access**: chọn *Only select repositories* → chọn `personal-finance-data`
3. **Permissions → Repository permissions → Contents**: chọn **Read and write**
   (không cấp thêm quyền nào khác — token này không cần đụng tới repo `personal-finance-app`)
4. Generate token, copy lại (chỉ hiện 1 lần)

## Bước 2 — Kết nối app

1. Mở app → tab **Cài đặt**
2. Dán token vào ô "Fine-grained Personal Access Token" → **Lưu token**
3. Bấm **Kiểm tra kết nối** để xác nhận OK

Token chỉ lưu trong `localStorage` của trình duyệt đang dùng — không gửi lên đâu khác ngoài
GitHub API, và không được commit vào bất kỳ repo nào. Mỗi thiết bị/trình duyệt cần nhập token
riêng (có thể dùng chung 1 token fine-grained cho nhiều thiết bị nếu muốn).

## Kiến trúc

```
personal-finance-app (repo public, chỉ chứa code)
  └── GitHub Pages host static site (HTML/CSS/JS thuần, không build step)

personal-finance-data (repo private, chỉ chứa data)
  ├── categories.json
  ├── budget.json
  └── transactions/YYYY-MM.json
```

Browser gọi thẳng GitHub REST Contents API (`GET`/`PUT`
`/repos/trungcln1991/personal-finance-data/contents/...`) bằng token ở trên. Không có backend
riêng, không có database — Git chính là database.

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
settings.html       Token GitHub, quản lý danh mục/PP thanh toán/ngân sách
js/config.js        Owner/repo GitHub chứa data
js/github-api.js    Wrapper GitHub Contents API (đọc/ghi file JSON, base64 UTF-8 an toàn)
js/store.js         Lớp nghiệp vụ: CRUD giao dịch, format tiền VNĐ, tính tháng
js/nav.js           Thanh điều hướng dưới, chặn truy cập khi chưa có token
```
