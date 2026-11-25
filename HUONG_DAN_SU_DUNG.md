# 📦 HƯỚNG DẪN SỬ DỤNG APP CHỤP TEM TỒN KHO — BẢN v19 (HỖ TRỢ QUÉT BARCODE KHÁCH HÀNG TÙY CHỌN • CHỤP 1 CHẠM BỎ QUA NÚT OK)

Ứng dụng chuyên biệt trên Điện thoại dùng **cảm biến chụp ảnh tĩnh 4:3 độ nét gốc**, có sẵn **trường quét Barcode khách hàng ngay phía trên trước lúc quét sản phẩm (hoàn toàn tùy chọn — có thể bỏ qua không bắt buộc)**, **bấm chụp 1 chạm là nổi hình vừa chụp lên màn hình và TỰ ĐỘNG GHI NHẬN ngay lập tức** (**bỏ qua hoàn toàn màn hình bấm nút `OK / Sử dụng ảnh`**), tự lấy trọn **Barcode khách hàng (nếu có) + Mã sản phẩm + Tên hàng + Số ký + NSX + HSD**, hoạt động **100% cả khi mất mạng** và **tự động đồng bộ 2 chiều với Google Sheet `SCAN TỒN`**.

---

## 🌐 1. ĐƯỜNG LINK DUY NHẤT MỞ DÙNG NGAY TRÊN ĐIỆN THOẠI

👉 `https://longdoanthanh-bot.github.io/scan-ton-kho/`

> 💡 **Mẹo cài ra màn hình chính để mở nhanh khi kho lạnh mất sạch mạng**:
> - Vào mục **`⚙️ Cài Đặt`** ở thanh dưới cùng → bấm **`📲 Cài ứng dụng ra màn hình chính`**.
> - Trên **iPhone (Safari)**: Bấm nút **Chia sẻ (ô vuông có mũi tên lên)** → chọn **Thêm vào MH chính (Add to Home Screen)**.

---

## 👤 2. TRƯỜNG QUÉT BARCODE KHÁCH HÀNG TRƯỚC LÚC QUÉT SẢN PHẨM (CÓ THỂ BỎ QUA)

Ngay đầu màn hình chụp có thanh **`👤 Barcode khách hàng (Không bắt buộc • Có thể bỏ qua)`**:

- **Trường hợp 1 — Không cần gán khách hàng (Bỏ qua luôn)**:
  - Bạn **không cần bấm hay nhập gì vào ô này** — cứ để trống và chụp thẳng các tem sản phẩm như bình thường! Hệ thống tự động để dấu **`—`** ở cột `Barcode khách hàng` (không chặn, không hỏi xác nhận).
- **Trường hợp 2 — Cần quét Barcode khách hàng trước khi quét sản phẩm**:
  1. Bấm nút **`📷 Quét mã KH`** (khung ngắm chuyển sang viền vàng nhạt) → đưa mã vạch khách hàng trên phiếu/rổ vào khung → bấm nút tròn **`📸 CHỤP`** 1 chạm (hoặc gõ trực tiếp vào ô mã khách hàng).
  2. Tấm hình nổi lên báo **`✅ ĐÃ GÁN BARCODE KHÁCH HÀNG`** và **tự động chuyển ngay về chế độ chụp sản phẩm** (không cần bấm `OK`).
  3. Toàn bộ các tem sản phẩm bạn chụp tiếp theo sẽ **tự động gắn kèm mã khách hàng này**.
  4. Khi chuyển sang khách hàng khác, bấm **`📷 Đổi mã KH`** để quét mã mới; hoặc bấm **`✕ Bỏ qua`** để xóa mã khách hàng về trống (`—`).

---

## 📸 3. CÁCH CHỤP SẢN PHẨM 1 CHẠM SIÊU TỐC (KHÔNG QUA NÚT OK XÁC NHẬN)

1. **Đưa mặt tem vào khung ngắm** (mặc định máy tự bật mức **`1.5x Nét`** giúp cầm điện thoại cách tem `20–25 cm` lấy nét cực căng; có thể chạm nhẹ ngón tay vào mặt tem trên màn hình để khóa nét).
2. **Bấm nút tròn `📸 CHỤP` đúng 1 lần duy nhất**:
   - **Tấm hình vừa chụp lập tức nổi lên góc trên màn hình** kèm tiếng *Bíp* — **ĐÃ TỰ ĐỘNG GHI NHẬN NGAY** (gồm **Barcode KH (nếu có) + Ảnh thu nhỏ + Tên hàng + Mã SP + Số ký + NSX + HSD**), **tuyệt đối không bắt bấm nút `OK`**!
   - Đưa thẳng ống kính sang bao hàng kế tiếp bấm **`📸 CHỤP`** liên hoàn ngay lập tức!
   - Nếu bấm nhầm bao, bấm **`🗑️ Hủy`** ngay trên tấm hình nổi để xóa tức thì; nếu góc ngày bị khuất bóng, bấm **`📷 Bù ngày`** rồi chụp góc chữ `NSX / HSD`.
3. **Tải loạt ảnh đã chụp sẵn (nếu có)**:
   - Bấm **`📚 Tải ảnh có sẵn`** ở góc phải dưới khung chụp để chọn nhiều hình đọc tự động 1 lần.

---

## 📊 4. BÁO CÁO TỔNG HỢP TỒN 4 CHIỀU TRÊN "SCAN TỒN"

- Bảng tính **`SCAN TỒN`** gắn cố định:
  👉 `https://docs.google.com/spreadsheets/d/1jmwE8LBV4XroBIKVohHFDXwWjEhDwSHZnUb-ziLrDgk/edit?gid=0#gid=0`
- Trang **`Chi_Tiet_Scan`** ghi chi tiết 12 cột (có cột **`Barcode khách hàng`** ngay cột thứ 2; dòng bỏ qua hiển thị **`—`**).
- Trang **`Tong_Hop_Ton`** (và mục **`📊 SKU / Date`** trên điện thoại) tự động tổng hợp tồn kho theo **4 chiều đối soát khớp 100%**:
  1. **Theo Mã SP × Theo Hạn dùng (`SKU × Date`)**
  2. **Gộp Theo Mã Sản Phẩm (`Theo SKU`)**
  3. **Gộp Theo Hạn Dùng (`Theo Date`)**
  4. **Gộp Theo Barcode Khách Hàng (`Theo KH`)**
