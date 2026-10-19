// Cloudflare Email Worker — chuyển thư ngân hàng (qua Gmail forward) sang backend Sổ Thu Chi (CT107).
// KHÔNG phân tích gì ở đây: chỉ chuyển nguyên thư thô; backend (mailingest.py) đọc bằng quy tắc cứng + danh sách trắng người gửi.
// Địa chỉ nhận là địa chỉ ngẫu nhiên khó đoán; xác thực lên backend bằng Access service token (secret CF_ID / CF_SECRET).
export default {
  async email(message, env, ctx) {
    if (message.rawSize > 400000) { console.log("bo qua: thu qua lon", message.rawSize); return; }
    // Thư xác nhận địa chỉ chuyển tiếp của Gmail (cần để tạo bộ lọc) → chuyển về hộp thư chủ để bấm xác nhận; KHÔNG đưa lên backend
    if ((message.from || "").toLowerCase() === "forwarding-noreply@google.com") {
      await message.forward(env.OWNER_EMAIL);
      console.log("chuyen thu xac nhan Gmail ve hop thu chu");
      return;
    }
    try {
      const raw = await new Response(message.raw).arrayBuffer();
      const res = await fetch(env.INGEST_URL, {
        method: "POST",
        headers: {
          "Content-Type": "message/rfc822",
          "CF-Access-Client-Id": env.CF_ID,
          "CF-Access-Client-Secret": env.CF_SECRET,
        },
        body: raw,
      });
      console.log("ingest", res.status, (await res.text()).slice(0, 200));
    } catch (e) {
      console.log("ingest loi", String(e));  // thư gốc vẫn còn trong Gmail (filter chỉ chuyển tiếp, không xoá)
    }
  },
};
