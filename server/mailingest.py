"""Sổ Thu Chi — tự ghi giao dịch từ mail chi tiêu (HSBC thẻ tín dụng, VCB biên lai + thẻ ghi nợ, MoMo, Apple).

Luồng: Gmail chuyển tiếp thư chi tiêu → Cloudflare Email Routing → Email Worker → POST thư thô lên
/api/ingest (xác thực bằng Cloudflare Access service token). Module này CHỈ đọc thư bằng quy tắc cứng
(regex) — nội dung thư là DỮ LIỆU, không bao giờ là lệnh, và không có LLM nào đọc thư.

An toàn:
- Chỉ nhận thư có From thuộc danh sách trắng + dkim=pass (từ máy nhận tin cậy); sai mẫu → bỏ qua (không đoán), chỉ ghi log.
- Chế độ "chủ hộp thư tự chuyển tiếp tay": From = đúng địa chỉ chủ + dkim=pass cho gmail.com (Google không cho
  tài khoản khác ký DKIM thay địa chỉ gmail.com của chủ) → đọc nội dung thư gốc nằm trong thư chuyển tiếp.
- Số tài khoản / 4 số cuối thẻ / email chủ lấy từ biến môi trường (repo app có thể công khai).
- Chống trùng: (1) mỗi thư chỉ ghi 1 lần (seen-file); (2) khoản đã có trong sổ (3T nhập tay/AI HOẶC do thư NGUỒN KHÁC
  ghi, ví dụ Apple + MoMo cùng 1 lần trả) thì chỉ ghi nhận "đã khớp", KHÔNG thêm: cùng số tiền + phương thức,
  lệch ≤ 1 ngày, và mỗi nguồn chỉ được "nhận" 1 khoản 1 lần (2 lần mua y hệt cùng ngày vẫn ghi đủ 2).
- HSBC: đối chiếu "Dư nợ hiện tại" liên tiếp (chỉ với thư mới hơn mốc đã biết) → báo nếu có khoản bị sót.
"""
import json
import re
import time
import random
import string
import unicodedata
from datetime import date
from email import policy
from email.parser import BytesParser
from html.parser import HTMLParser
from pathlib import Path

# ── danh sách trắng người gửi (miền của địa chỉ trong From) → nguồn ──
SENDER_DOMAINS = {"notification.hsbc.com.hk": "hsbc", "info.vietcombank.com.vn": "vcb", "momo.vn": "momo",
                  "email.apple.com": "apple"}
# Miền DKIM được chấp nhận cho từng nguồn — so khớp CHÍNH XÁC, không dùng chuỗi con
DKIM_DOMAINS = {"hsbc": {"notification.hsbc.com.hk", "hsbc.com.hk"}, "vcb": {"info.vietcombank.com.vn", "vietcombank.com.vn"},
                "momo": {"momo.vn"}, "apple": {"email.apple.com", "apple.com"}, "owner": {"gmail.com"}}
MAX_AMOUNT = 200_000_000  # chặn số vô lý (thư giả/lỗi parse)
USD_RATE_MIN, USD_RATE_MAX = 20_000, 35_000  # VND/USD ngầm định cho khoản ngoại tệ (chênh dư nợ / USD) — ngoài khoảng này là nghi sót

# ── quy tắc phân loại: (từ khoá KHÔNG DẤU viết hoa, category, priority) — khớp đầu tiên thắng ──
RULES = [
    (("VINAMILK", "CON CUNG", "BIBOMART", "KIDS PLAZA", "TA BIM"), "ta-sua-cua-con", "essential"),
    (("PLX", "PETROLIMEX", "XANG", "SHELL", "CALTEX"), "tien-xang-bao-tri-xe", "essential"),
    (("DOFA", "NHA THUOC", "PHONG KHAM", "LONG CHAU", "PHARMACITY", "BENH VIEN", " BV "), "quy-suc-khoe", "essential"),
    # 22/10 3T chốt: mọi khoản ăn uống → tiền ăn sáng chiều. Đứng trước SHOPEE để SHOPEEFOOD không lọt sang đồ dùng.
    (("PIZZA", "KFC", "LOTTERIA", "JOLLIBEE", "MCDONALD", "BURGER", "TEXAS CHICKEN", "POPEYES", "HIGHLANDS", "PHUC LONG",
      "STARBUCKS", "KATINAT", "COFFEE", "CAFE", " CA PHE", "TRA SUA", "GONG CHA", "NHA HANG", "QUAN AN", "BANH MI",
      "BANH TRANG", "COM TAM", "BUN BO", "PHO BO", "PHO GA", " LAU ", "GRABFOOD", "SHOPEEFOOD", "BAEMIN"),
     "tien-an-sang-chieu", "essential"),
    (("EVN", "DIEN LUC", "NUOC", "VNPT", "FPT TELECOM", "VIETTEL"), "dien-nuoc-internet", "essential"),
    (("BACH HOA XANH", "WINMART", "WIN MART", "CO.OP", "COOPMART", "MM MEGA", "LOTTE MART", "GO!", "SIEU THI"), "tien-cho", "essential"),
    (("SHOPEE", "LAZADA", "TIKI", "TIKTOK SHOP"), "do-dung-gia-dinh", "nice"),
    (("APPLE", "ICLOUD", "GOOGLE ONE", "GOOGLE PLAY", "NETFLIX", "SPOTIFY", "YOUTUBE", "ANTHROPIC", "CLAUDE", "OPENAI"), "tien-ich-dt-dich-vu", "nice"),
    (("VIETLOTT",), "chi-ca-nhan", "unnecessary"),
]
DEFAULT_CAT = ("chi-ca-nhan", "nice")  # khoản lạ: ghi kèm "[?]" để 3T tìm và sửa


class Skip(Exception):
    """Thư đúng nguồn nhưng chủ ý bỏ qua (giao dịch thất bại, ngoại tệ, thiếu thông tin...) — kèm lý do để ghi log."""


def _noaccent(s: str) -> str:
    s = unicodedata.normalize("NFD", s.replace("đ", "d").replace("Đ", "D"))
    return "".join(c for c in s if unicodedata.category(c) != "Mn").upper()


def classify(text: str):
    t = " " + re.sub(r"[^A-Z0-9]+", " ", _noaccent(text)) + " "  # đệm khoảng trắng để từ khoá " BV " khớp nguyên từ
    for keys, cat, pr in RULES:
        if any(k in t for k in keys):
            return cat, pr, True
    return DEFAULT_CAT[0], DEFAULT_CAT[1], False


# ── thư → văn bản ──
class _Html2Text(HTMLParser):
    def __init__(self):
        super().__init__()
        self.out = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "head"):
            self._skip += 1
        if tag in ("br", "p", "div", "tr", "li"):
            self.out.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style", "head"):
            self._skip = max(0, self._skip - 1)
        if tag in ("td", "th"):
            self.out.append(" | ")
        if tag in ("tr", "p", "div", "li", "table"):
            self.out.append("\n")

    def handle_data(self, data):
        if not self._skip:
            self.out.append(data)


def html_to_text(html: str) -> str:
    p = _Html2Text()
    p.feed(html)
    lines = [re.sub(r"[ \t\xa0]+", " ", ln).strip() for ln in "".join(p.out).split("\n")]
    return "\n".join(ln for ln in lines if ln and ln != "|")


def message_texts(msg) -> list:
    """Mọi phần có chữ của thư (text/plain rồi html→text) — có thư phần plain chỉ là câu giữ chỗ, nội dung nằm ở html."""
    out = []
    for pref in ("plain", "html"):
        part = msg.get_body(preferencelist=(pref,))
        if part is None:
            continue
        t = part.get_content()
        if pref == "html" or re.match(r"\s*(<!doctype|<html)", t or "", re.I):  # phần plain đôi khi chính là mã HTML
            t = html_to_text(t)
        if t and t.strip():
            out.append(t)
    return out


def sender_addr(msg) -> str:
    m = re.search(r"([\w.+-]+@[\w.-]+)>?\s*$", str(msg.get("From", "")).strip())
    return (m.group(1) if m else "").lower()


def sender_domain(msg) -> str:
    a = sender_addr(msg)
    return a.split("@", 1)[1] if "@" in a else ""


def dkim_ok(msg, kind: str, trusted_authserv) -> bool:
    """Chỉ tin dòng Authentication-Results TRÊN CÙNG (máy nhận tin cậy luôn chèn lên đầu) và authserv-id phải thuộc danh sách
    tin cậy. Dòng Authentication-Results do kẻ gửi tự nhét vào thân thư nằm bên dưới nên bị bỏ qua; ARC/X-Original cũng bỏ qua."""
    hdrs = msg.get_all("Authentication-Results", [])
    if not hdrs:
        return False
    v = str(hdrs[0]).lower()
    authserv = (v.split(";", 1)[0].split() or [""])[0]
    if authserv not in {a.lower() for a in trusted_authserv}:
        return False
    for res in v.split(";")[1:]:
        if re.match(r"\s*dkim=pass\b", res):
            # Cloudflare có lúc chỉ ghi header.i=@miền (thư VCB 21/10), không có header.d. Theo RFC 6376 miền của i= luôn
            # bằng hoặc là con của d= nên dùng i= khi thiếu d= vẫn an toàn (vẫn so khớp chính xác danh sách trắng).
            d = re.search(r"header\.d=@?([^\s;]+)", res) or re.search(r"header\.i=[^\s;@]*@([^\s;]+)", res)
            if d and d.group(1).rstrip(".") in DKIM_DOMAINS.get(kind, set()):
                return True
    return False


def auth_summary(msg) -> str:
    h = msg.get_all("Authentication-Results", [])
    return re.sub(r"\s+", " ", str(h[0]))[:160] if h else "không có Authentication-Results"


def _num(s: str) -> int:
    return int(re.sub(r"[^\d]", "", s))


def _dmy(s: str) -> str:
    d, m, y = re.split(r"[/-]", s)
    return f"{y}-{m}-{d}"


def _vnd(n: int) -> str:
    return f"{n:,}".replace(",", ".")


# ── parser từng nguồn ──
def parse_hsbc(text: str, card_suffix: str):
    t = re.sub(r"\s+", " ", text)
    m = re.search(r"thẻ tín dụng X(\d{4}) của Quý khách vừa thực hiện giao dịch với số tiền ([\d.,]+) VND tại (.+?) vào ngày "
                  r"(\d{2}/\d{2}/\d{4})\.\s*Dư nợ hiện tại là ([\d.,]+) VND", t)
    if not m:  # bản tiếng Anh cùng trong thư
        m = re.search(r"your card X(\d{4}) has been charged VND([\d.,]+) at merchant (.+?) on (\d{2}/\d{2}/\d{4})\.\s*"
                      r"Your current balance is VND([\d.,]+)", t)
        if not m:
            return _parse_hsbc_usd(t, card_suffix)
    card, amount, merchant, d, balance = m.group(1), _num(m.group(2)), m.group(3).strip(), _dmy(m.group(4)), _num(m.group(5))
    if card_suffix and card != card_suffix:
        return None
    cat, pr, known = classify(merchant)
    note = merchant.replace("_", " ").strip()
    return {"kind": "hsbc", "key": f"hsbc:{d}:{amount}:{balance}", "date": d, "amount": amount, "pm": "the-tin-dung",
            "category": cat, "priority": pr, "known": known, "note": f"{note} (HSBC)" if known else f"[?] {note} (HSBC)",
            "balance": balance}


def _parse_hsbc_usd(t: str, card_suffix: str):
    """Thẻ HSBC quẹt ngoại tệ (vd ANTHROPIC* CLAUDE TEAM 16.92 USD 26/10): thư chỉ ghi USD, không ghi VND. Số VND thật = chênh
    lệch dư nợ so với thư trước (apply_entry tính, có kiểm tỉ giá hợp lý) nên entry này mang amount=0 + usd."""
    m = re.search(r"thẻ tín dụng X(\d{4}) của Quý khách vừa thực hiện giao dịch với số tiền ([\d.,]+) USD tại (.+?) vào ngày "
                  r"(\d{2}/\d{2}/\d{4})\.\s*Dư nợ hiện tại là ([\d.,]+) VND", t)
    if not m:
        m = re.search(r"your card X(\d{4}) has been charged USD([\d.,]+) at merchant (.+?) on (\d{2}/\d{2}/\d{4})\.\s*"
                      r"Your current balance is VND([\d.,]+)", t)
    if not m:
        return None
    card, usd, merchant, d, balance = m.group(1), m.group(2).replace(",", ""), m.group(3).strip(), _dmy(m.group(4)), _num(m.group(5))
    if card_suffix and card != card_suffix:
        return None
    cat, pr, known = classify(merchant)
    note = merchant.replace("_", " ").strip()
    return {"kind": "hsbc", "key": f"hsbc:{d}:USD{usd}:{balance}", "date": d, "amount": 0, "usd": float(usd), "pm": "the-tin-dung",
            "category": cat, "priority": pr, "known": known, "note": f"{note} (HSBC, {usd} USD)" if known else f"[?] {note} (HSBC, {usd} USD)",
            "balance": balance}


def parse_vcb_card(flat: str, own_account: str):
    """Thông báo giao dịch thẻ ghi nợ VCB. Chỉ nhận giao dịch THÀNH CÔNG bằng VND."""
    when = re.search(r"Trans\. Date, Time\s*\|?\s*(\d{2}-\d{2}-\d{4}) (\d{2}:\d{2}:\d{2})", flat)
    amt = re.search(r"Transaction Amount\s*\|?\s*([\d.,]+)\s*([A-Z]{3})", flat)
    shop = re.search(r"Sử dụng tại At\s*\|?\s*(.+?)\s*\|", flat)
    acct = re.search(r"Debit Account\s*\|?\s*(\d+)", flat)
    status = re.search(r"Status of Transaction\s*\|?\s*(.+?)\s*(?:\||$)", flat)
    if not (when and amt and shop and acct):
        return None
    if not own_account or acct.group(1) != own_account:
        return None
    st = _noaccent(status.group(1)) if status else ""
    if "KHONG THANH CONG" in st or "THANH CONG" not in st:
        raise Skip(f"giao dịch thẻ VCB không thành công/không rõ trạng thái ({status.group(1)[:30] if status else 'trống'})")
    if amt.group(2) != "VND":
        raise Skip(f"giao dịch thẻ VCB ngoại tệ ({amt.group(1)} {amt.group(2)}) — cần quy đổi VND, nhập tay hoặc qua sao kê")
    amount, d = _num(amt.group(1)), _dmy(when.group(1))
    if amount == 0:
        raise Skip("giao dịch thẻ VCB 0đ (xác thực thẻ)")
    merchant = re.sub(r"\s+[+]?\d{6,}.*$", "", shop.group(1)).strip()  # bỏ số điện thoại/mã đuôi
    cat, pr, known = classify(merchant)
    return {"kind": "vcb", "key": f"vcbcard:{d}T{when.group(2)}:{amount}:{merchant[:24]}", "date": d, "amount": amount,
            "pm": "ngan-hang", "category": cat, "priority": pr, "known": known,
            "note": f"{merchant} (thẻ VCB)" if known else f"[?] {merchant} (thẻ VCB)"}


def _is_hsbc_card_payment(flat: str, hsbc_card: str) -> bool:
    """Biên lai VCB chuyển tiền vào thẻ HSBC của nhà: 4 số cuối thẻ hưởng khớp INGEST_HSBC_CARD,
    hoặc ngân hàng hưởng là HSBC VÀ nội dung có chữ "hsbc" (tránh nhầm chuyển cho người khác có TK HSBC)."""
    cred = re.search(r"Credit Account/ ?Card\s*\|?\s*([\d.…*xX]+)", flat)
    if hsbc_card and cred and re.sub(r"\D", "", cred.group(1))[-len(hsbc_card):] == hsbc_card:
        return True
    bank = re.search(r"Beneficiary Bank Name\s*\|?\s*(.+?)\s*(?:\||Số tiền|Amount|Loại phí|$)", flat)
    det = re.search(r"Details of Payment\s*\|?\s*(.+?)\s*(?:\||$)", flat)
    return bool(bank and det and "HSBC" in _noaccent(bank.group(1)) and "HSBC" in _noaccent(det.group(1)))


def parse_vcb(text: str, own_account: str, hsbc_card: str = ""):
    flat = re.sub(r"\s+", " ", re.sub(r"[ \t]+", " ", text))
    if "card transaction notification" in flat:
        return parse_vcb_card(flat, own_account)
    order = re.search(r"Order Number\s*\|?\s*(\d{6,})", flat)
    amt = re.search(r"Số tiền\s+Amount\s*\|?\s*([\d.,]+)\s*VND", flat)
    when = re.search(r"Date, Time\s*\|?\s*\d{2}:\d{2}[^\d]*?(\d{2}/\d{2}/\d{4})", flat)
    acct = re.search(r"Debit Account\s*\|?\s*(\d+)", flat)
    if not (order and amt and when and acct):
        return None
    if not own_account or acct.group(1) != own_account:
        return None  # chỉ ghi khoản chi từ tài khoản của mình
    amount, d = _num(amt.group(1)), _dmy(when.group(1))
    fee = re.search(r"Số tiền phí\s+Transaction Fee\s*\|?\s*([\d.,]+)\s*VND", flat)
    fee_v = _num(fee.group(1)) if fee else 0
    if _is_hsbc_card_payment(flat, hsbc_card):  # 30/10: chuyển tiền trả thẻ HSBC là TRẢ NỢ THẺ (transfer), không phải chi tiêu
        return {"kind": "vcb", "key": f"vcb:{order.group(1)}", "date": d, "amount": amount, "pm": "ngan-hang", "type": "transfer",
                "to": "the-tin-dung", "category": None, "priority": None, "known": True, "note": "Trả thẻ HSBC (VCB)"}
    # phần text/plain (Gmail chuyển tiếp) không có "|" giữa các ô → dừng ở nhãn kế tiếp
    # 23/10: biên lai chuyển tiền có thêm ô "Tên ngân hàng hưởng Beneficiary Bank Name" ngay sau tên người hưởng
    ben = re.search(r"Beneficiary Name\s*\|?\s*(.+?)\s*(?:\||Mã hóa đơn|[Tt]ên ngân hàng hưởng|Ngân hàng hưởng|Beneficiary Bank|"
                    r"Số tiền|Nội dung|Loại phí|$)", flat)
    title = re.search(r"(Giao dịch thanh toán .+?|Biên lai chuyển tiền qua tài khoản)\s*\(Payment Receipt\)", flat)
    who = re.sub(r"^(HO KINH DOANH|CONG TY TNHH|CONG TY CP)\s+", "", ben.group(1).strip()) if ben else (
        title.group(1).replace("Giao dịch thanh toán", "").strip() if title else "")
    cat, pr, known = classify(who + " " + (title.group(1) if title else ""))
    if not ben and who:  # biên lai thanh toán dịch vụ (VietlottSMS...) — ghi rõ tiền gốc + phí
        note = f"{who} ({_vnd(amount)}" + (f" + phí {_vnd(fee_v)}" if fee_v else "") + ")"
    else:
        note = f"{who} (VCB)"
    amount += fee_v
    if not known:
        note = f"[?] {note}"
    return {"kind": "vcb", "key": f"vcb:{order.group(1)}", "date": d, "amount": amount, "pm": "ngan-hang",
            "category": cat, "priority": pr, "known": known, "note": note}


def parse_momo(text: str):
    """Hóa đơn điện tử MoMo ("Giao dịch thành công") — khoản trả bằng Ví MoMo → phương thức vi-tra-sau."""
    flat = re.sub(r"\s+", " ", text)
    m = re.search(r"Dịch vụ\s*\|?\s*(.+?)\s*\|?\s*Nguồn tiền\s*\|?\s*(.+?)\s*\|?\s*Thời gian\s*\|?\s*(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}:\d{2}"
                  r"\s*\|?\s*Mã giao dịch\s*\|?\s*(\d{6,})", flat)
    if not m:
        return None
    total = re.search(r"Tổng cộng\s*\|?\s*([\d.,]+)", flat) or re.search(r"Khoản thanh toán\s*\|?\s*([\d.,]+)", flat)
    if not total:
        return None
    service, src, d, code = m.group(1).strip(), m.group(2).strip(), m.group(3), m.group(4)
    if "MOMO" not in _noaccent(src):
        raise Skip(f"MoMo: nguồn tiền '{src[:20]}' không phải Ví MoMo — không biết ghi vào phương thức nào")
    amount = _num(total.group(1))
    cat, pr, known = classify(service)
    return {"kind": "momo", "key": f"momo:{code}", "date": d, "amount": amount, "pm": "vi-tra-sau",
            "category": cat, "priority": pr, "known": known,
            "note": f"{service} (MoMo)" if known else f"[?] {service} (MoMo)"}


def parse_apple(text: str, card_suffix: str):
    """Biên nhận Apple — phương thức thanh toán đọc từ chính biên nhận (MoMo → vi-tra-sau, thẻ HSBC → the-tin-dung)."""
    flat = re.sub(r"\s+", " ", text)
    order = re.search(r"ID đơn hàng:?\s*\|?\s*([A-Z0-9]{8,})", flat)
    when = re.search(r"Ngày\s+(\d{1,2}) tháng (\d{1,2}) năm (\d{4})", flat)
    if not (order and when):
        return None
    pay = re.search(r"Hóa Đơn Và Thanh Toán(.+?)(?:Nếu bạn có bất cứ|$)", flat)
    block = pay.group(1) if pay else flat
    amts = re.findall(r"([\d.]+)\s*₫", block)
    if not amts:
        return None
    if "MOMO" in _noaccent(block):
        pm = "vi-tra-sau"
    elif card_suffix and card_suffix in block:
        pm = "the-tin-dung"
    else:
        raise Skip("Apple: không xác định được phương thức thanh toán trong biên nhận")
    item = (re.search(r"(iCloud[^|]{0,60}?\(Hàng (?:tháng|năm)\))", flat)
            or re.search(r"((?:\S+\s+){1,6}\(Hàng (?:tháng|năm)\))", flat))
    name = re.sub(r"\s+", " ", item.group(1)).strip() if item else "Apple"
    d = f"{when.group(3)}-{int(when.group(2)):02d}-{int(when.group(1)):02d}"
    cat, pr, _ = classify("APPLE " + name)
    return {"kind": "apple", "key": f"apple:{order.group(1)}", "date": d, "amount": _num(amts[-1]), "pm": pm,
            "category": cat, "priority": pr, "known": True, "note": f"{name[:60]} (Apple)"}


def _parse_by_kind(kind: str, text: str, own_vcb: str, hsbc_card: str):
    if kind == "hsbc":
        return parse_hsbc(text, hsbc_card)
    if kind == "vcb":
        return parse_vcb(text, own_vcb, hsbc_card)
    if kind == "momo":
        return parse_momo(text)
    if kind == "apple":
        return parse_apple(text, hsbc_card)
    return None


def parse_mail(raw: bytes, own_vcb: str = "", hsbc_card: str = "", require_dkim: bool = True,
               trusted_authserv=("mx.cloudflare.net",), owner_email: str = "", disabled=()):
    """→ (entry|None, lý do). entry là dict giao dịch chuẩn bị ghi. `disabled`: nguồn tắt (vd "apple" — luôn trùng MoMo/thẻ)."""
    msg = BytesParser(policy=policy.default).parsebytes(raw)
    addr, dom = sender_addr(msg), sender_domain(msg)
    if owner_email and addr == owner_email.lower():  # chủ hộp thư tự chuyển tiếp tay thư chi tiêu cũ/mới
        if require_dkim and not dkim_ok(msg, "owner", trusted_authserv):
            return None, f"thư của chủ không có dkim=pass (gmail.com) từ máy nhận tin cậy [AR: {auth_summary(msg)}]"
        kinds, how = [k for k in ("hsbc", "vcb", "momo", "apple") if k not in disabled], "owner"
    else:
        kind = next((v for k, v in SENDER_DOMAINS.items() if dom == k or dom.endswith("." + k)), None)
        if not kind:
            return None, f"người gửi không trong danh sách trắng ({dom or 'trống'})"
        if kind in disabled:
            return None, f"nguồn {kind} đã tắt (cùng khoản đã có thư từ nguồn khác — công tắc INGEST_DISABLED_KINDS)"
        if require_dkim and not dkim_ok(msg, kind, trusted_authserv):
            return None, f"không có dkim=pass (từ máy nhận tin cậy) cho miền người gửi [AR: {auth_summary(msg)}]"
        kinds, how = [kind], kind
    entry, skip, fallback = None, None, None
    for text in message_texts(msg):
        for k in kinds:
            try:
                entry = _parse_by_kind(k, text, own_vcb, hsbc_card)
            except Skip as e:
                skip = str(e)
                continue
            if entry:
                break
        if entry and not entry["known"]:  # phần text này đọc thiếu tên nơi chi → thử phần còn lại (html) trước khi chịu "[?]"
            fallback, entry = fallback or entry, None
            continue
        if entry:
            break
    entry = entry or fallback
    if not entry:
        return None, skip or f"thư {how} không khớp mẫu giao dịch chi (bỏ qua, không đoán)"
    if not entry.get("usd") and not (0 < entry["amount"] <= MAX_AMOUNT):  # khoản USD: amount tính sau ở apply_entry
        return None, f"số tiền ngoài ngưỡng ({entry['amount']})"
    entry["via"] = how
    return entry, "ok"


# ── ghi sổ ──
def _b36(n: int) -> str:
    a = string.digits + string.ascii_lowercase
    s = ""
    while n:
        n, r = divmod(n, 36)
        s = a[r] + s
    return s


def _new_id() -> str:
    return "tx-%s-%s" % (_b36(int(time.time() * 1000)), "".join(random.choices(string.ascii_lowercase + string.digits, k=6)))


def _load_seen(p: Path) -> dict:
    seen = json.loads(p.read_text()) if p.is_file() else {}
    seen.setdefault("keys", {})
    seen.setdefault("claims", {})  # id giao dịch → danh sách nguồn đã "nhận" khoản đó
    seen.setdefault("hsbc_balance", None)
    seen.setdefault("hsbc_date", "")
    for old in seen.pop("claimed", []):  # tương thích bản cũ
        seen["claims"].setdefault(old, ["hsbc"])
    return seen


def apply_entry(entry: dict, repo: Path, seen_path: Path, commit) -> dict:
    """Ghi 1 giao dịch vào repo (gọi trong khoá của app). commit(path_rel, message) → thực hiện git add/commit."""
    seen = _load_seen(seen_path)
    if entry["key"] in seen["keys"]:
        return {"status": "duplicate-mail", "key": entry["key"]}
    month = entry["date"][:7]
    rel = f"transactions/{month}.json"
    path = repo / rel
    data = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else []
    warn = None
    if entry.get("usd"):  # VND thật = dư nợ mới − dư nợ lần trước; chỉ tin khi tỉ giá ngầm trong khoảng hợp lý
        last = seen.get("hsbc_balance")
        if last is None or entry["date"] < (seen.get("hsbc_date") or ""):
            return {"status": "ignored", "reason": f"khoản USD {entry['usd']}: chưa có mốc dư nợ để suy ra VND"}
        vnd = entry["balance"] - last
        if not (entry["usd"] * USD_RATE_MIN <= vnd <= entry["usd"] * USD_RATE_MAX):
            return {"status": "ignored", "reason": f"khoản USD {entry['usd']}: chênh dư nợ {vnd} VND không khớp tỉ giá hợp lý "
                                                   f"(có thể sót khoản khác) — nhập tay"}
        entry = {**entry, "amount": vnd}
        seen["hsbc_balance"], seen["hsbc_date"] = entry["balance"], entry["date"]
        if not (0 < vnd <= MAX_AMOUNT):
            return {"status": "ignored", "reason": f"số tiền ngoài ngưỡng ({vnd})"}
    elif entry["kind"] == "hsbc" and entry["date"] >= (seen.get("hsbc_date") or ""):  # chỉ thư mới hơn mốc đã biết
        last = seen.get("hsbc_balance")
        if last is not None and last + entry["amount"] != entry["balance"]:
            diff = entry["balance"] - last - entry["amount"]
            warn = f"dư nợ HSBC lệch {'+' if diff > 0 else '-'}{_vnd(abs(diff))}đ so với lần trước → có thể sót/hoàn khoản"
        seen["hsbc_balance"], seen["hsbc_date"] = entry["balance"], entry["date"]
    # khoản y hệt đã có: cùng số tiền + phương thức, lệch ≤ 1 ngày, nguồn này chưa "nhận" khoản đó
    d0 = date.fromisoformat(entry["date"])
    is_tr = entry.get("type") == "transfer"  # trả thẻ: chỉ khớp với transfer cùng chiều đã có (nhập tay), không khớp khoản chi
    cand = [t for t in data if t["amount"] == entry["amount"]
            and ((t.get("type") == "transfer" and t.get("fromPayment") == entry["pm"] and t.get("toPayment") == entry["to"]) if is_tr
                 else (t.get("type") == "expense" and t.get("paymentMethod") == entry["pm"]))
            and entry["kind"] not in seen["claims"].get(t["id"], [])
            and abs((date.fromisoformat(t["date"]) - d0).days) <= 1]
    if cand:
        t = sorted(cand, key=lambda x: (abs((date.fromisoformat(x["date"]) - d0).days), x["date"]))[0]
        seen["claims"].setdefault(t["id"], []).append(entry["kind"])
        seen["keys"][entry["key"]] = t["id"]
        seen_path.write_text(json.dumps(seen, ensure_ascii=False))
        return {"status": "matched-existing", "id": t["id"], "note": t["note"], "kind": entry["kind"], "warn": warn}
    if is_tr:  # cùng dạng với form "Chuyển khoản" của app (js/add.js)
        tx = {"id": _new_id(), "date": entry["date"], "type": "transfer", "fromPayment": entry["pm"], "toPayment": entry["to"],
              "amount": entry["amount"], "note": entry["note"]}
    else:
        tx = {"id": _new_id(), "date": entry["date"], "type": "expense", "category": entry["category"],
              "amount": entry["amount"], "note": entry["note"], "paymentMethod": entry["pm"], "priority": entry["priority"]}
    data.append(tx)
    data.sort(key=lambda t: t["date"])
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)
    commit(rel, f"Thêm giao dịch (mail {entry['kind'].upper()}): {entry['note']}")
    seen["claims"].setdefault(tx["id"], []).append(entry["kind"])
    seen["keys"][entry["key"]] = tx["id"]
    seen_path.write_text(json.dumps(seen, ensure_ascii=False))
    return {"status": "added", "id": tx["id"], "note": tx["note"], "category": tx.get("category"),
            "amount": tx["amount"], "known": entry["known"], "warn": warn}
