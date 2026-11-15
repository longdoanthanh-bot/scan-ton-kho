# 📦 HƯỚNG DẪN SỬ DỤNG APP QUÉT TỒN KHO TEM MÃ VẠCH (MỌI ĐIỆN THOẠI & MÁY PDA)

Ứng dụng quét **dải mã vạch sọc 13 số** trên tem cân (ví dụ: `1010040051985` → Mã sản phẩm `10040` - *Chân giò heo trước*, Khối lượng `5.198 Kg`), **khóa cứng không quét nhầm ô vuông mã QR**, hoạt động **100% cả khi mất mạng (Offline)** và **tự động cập nhật lên Google Sheet ngay khi có mạng trở lại**.

---

## 🌐 1. ĐƯỜNG LINK MỞ DÙNG NGAY (KHÔNG CẦN CÙNG MẠNG WI-FI, KHÔNG CẦN BẬT MÁY TÍNH)

Chỉ cần điện thoại hoặc máy PDA có 4G / 5G / bất kỳ Wi-Fi nào ở lần mở đầu tiên:
- **Dành cho Điện thoại (iPhone / Samsung / Oppo / Xiaomi...)**:
  👉 `https://longdoanthanh-bot.github.io/scan-ton-kho/#camera`
- **Dành cho Máy kiểm kho cầm tay PDA (Zebra / Urovo / Sunmi / Honeywell / iData / Newland...)**:
  👉 `https://longdoanthanh-bot.github.io/scan-ton-kho/`

> 💡 **Mẹo cài ra màn hình chính để mở nhanh khi kho lạnh mất sạch mạng**:
> - Trên **Android / Máy PDA**: Bấm nút **`📲 Cài Offline`** trên góc phải thanh tiêu đề (hoặc menu 3 chấm Chrome → *Thêm vào màn hình chính*).
> - Trên **iPhone (Safari)**: Bấm nút **Chia sẻ (ô vuông có mũi tên lên)** → chọn **Thêm vào MH chính (Add to Home Screen)**.

---

## 📊 2. KẾT NỐI VỚI GOOGLE SHEET & CHIA SẺ 1 CHẠM CHO CẢ ĐỘI KHO (CHỈ LÀM 1 LẦN)

1. Mở một file Google Sheet trắng mới (gõ **`sheets.new`** trên máy tính).
2. Trên ứng dụng, bấm nút **`⚙️ Kết nối GG Sheet`** ở góc trên phải → bấm **`📋 Bước 1: Sao chép Mã Kết Nối Google Sheet`**.
3. Trên file Google Sheet, vào menu **Tiện ích mở rộng (Extensions) → Apps Script**, xóa chữ mặc định và **Dán (Ctrl+V)** mã vừa chép vào → bấm **Lưu (Ctrl+S)**.
4. Bấm nút xanh **Triển khai (Deploy) → Tùy chọn triển khai mới → Ứng dụng web (Web app)**.
   - *Thực thi dưới dạng*: **Tôi (Me)**
   - *Ai có quyền truy cập*: **Bất kỳ ai (Anyone)**
5. Bấm **Triển khai** → Sao chép đường link (có đuôi `/exec`) dán vào ô trong mục **`⚙️ Kết nối GG Sheet`** của App → bấm **Lưu & Đồng bộ ngay**.
6. Bấm nút xanh **`🔗 Sao chép Link dùng chung cho mọi ĐT & PDA`** ngay trong hộp thoại đó rồi gửi qua Zalo cho anh em kho — ai bấm vào link đó cũng **tự động kết nối chung vào đúng file Google Sheet** mà không phải cài đặt lại!

---

## 📴 3. CƠ CHẾ QUÉT KHI MẤT MẠNG (OFFLINE) & TỰ ĐỘNG CẬP NHẬT KHI CÓ MẠNG

- Khi nhân viên đi vào kho lạnh kín sóng (mất cả Wi-Fi lẫn 4G):
  - Thanh thông báo cam hiện chữ **`📴 Đang không có mạng (Offline)`** — nhân viên cứ quét tem, sửa hoặc xóa bình thường 100%.
  - Mọi tem vừa quét được khóa an toàn vào **2 lớp bộ nhớ riêng trên máy** (kể cả lỡ tay đóng trình duyệt hay tắt nguồn máy bật lại cũng không mất 1 tem nào).
- Ngay khi nhân viên bước ra khu vực có sóng 4G hoặc Wi-Fi:
  - Ứng dụng **tự động phát hiện có mạng** và đẩy toàn bộ các tem đang chờ lên Google Sheet hoàn toàn tự động (kèm cơ chế khóa chống ghi trùng dòng 100%).
