# 📦 HƯỚNG DẪN SỬ DỤNG APP CHỤP TEM TỒN KHO — BẢN v21 (CỘT KHÁCH HÀNG 3 DẠNG GHI NHẬN • MÁY ẢNH 1 CHẠM • ĐỒNG BỘ GOOGLE SHEET)

Ứng dụng chuyên biệt trên Điện thoại dùng **cảm biến chụp ảnh tĩnh 4:3 độ nét gốc**, thiết kế **3 Dạng ghi nhận Khách hàng linh hoạt**:
1. **👉 Dạng 1: Quét mã vạch in sẵn**: Bấm nút **`📷 Quét mã KH`** → Đưa mã vạch hoặc mã vuông QR Code trên phiếu xuất/tem in sẵn vào khung → Bấm nút tròn **`📸 CHỤP`**.
2. **👉 Dạng 2: Tự nhập liệu (Gõ tay)**: Chạm vào ô nhập liệu **`Gõ tên/mã KH...`** → Gõ trực tiếp bằng bàn phím (ví dụ: `KH-VINMART`, `ĐẠI LÝ AN PHÁT`) → Bấm nút **`💾 Ghi nhận`** (hoặc nhấn phím Enter). Hoặc bấm chọn nhanh từ các chip **`🏷️ Khách đã có`**!
3. **👉 Dạng 3: Bỏ qua (Không bắt buộc)**: Để trống hoặc bấm **`⏭️ Bỏ qua`** → Chụp thẳng tem sản phẩm bình thường! Cột khách hàng trên ứng dụng và Google Sheet sẽ tự động ghi nhận là **`—`** (chưa gán khách).
4. **Vị trí lưu trữ dữ liệu trên Google Sheet "SCAN TỒN"**:
   - **Trang `Chi_Tiet_Scan`**: Lưu ngay tại **Cột B — Khách hàng** (đứng trước cột *Tên sản phẩm*).
   - **Trang `Tong_Hop_Ton`**: Lưu tại **Bảng IV — TỔNG HỢP TỒN GỘP THEO KHÁCH HÀNG** (tự động gom số tem, số ký và danh mục hàng theo từng khách).

---

## 🌐 1. ĐƯỜNG LINK DUY NHẤT MỞ DÙNG NGAY TRÊN ĐIỆN THOẠI

👉 `https://longdoanthanh-bot.github.io/scan-ton-kho/`

> 💡 **Mẹo cài ra màn hình chính để mở nhanh khi kho lạnh mất sạch mạng**:
> - Vào mục **`⚙️ Cài Đặt`** ở thanh dưới cùng → bấm **`📲 Cài ứng dụng ra màn hình chính`**.
> - Trên **iPhone (Safari)**: Bấm nút **Chia sẻ (ô vuông có mũi tên lên)** → chọn **Thêm vào MH chính (Add to Home Screen)**.

---

## 👤 2. QUY TRÌNH QUÉT MÃ KHÁCH HÀNG TRƯỚC SẢN PHẨM (2 BƯỚC THÔNG MINH)

### 🟢 Bước 1: Quét mã khách hàng (Tùy chọn)
- **Nếu cần phân loại hàng theo khách**:
  - Bấm nút **`📷 Quét mã KH`** → Đưa mã vạch hoặc mã vuông QR Code trên phiếu xuất/hóa đơn vào khung → Bấm nút tròn **`📸 CHỤP`**.
  - **Đặc biệt (Dual-Auto-Detect)**: Bạn cũng có thể để nguyên máy ảnh chụp thẳng mã khách hàng mà **không cần bấm nút Quét mã KH trước**, hệ thống sẽ tự động phát hiện và gán mã khách ngay lập tức!
  - Ứng dụng kêu *Bíp*, đổi thanh trạng thái màu xanh: **`👤 KHÁCH HÀNG: [MÃ KHÁCH HÀNG]`**.
- **Nếu không cần phân loại theo khách (Bỏ qua)**:
  - Cứ chụp thẳng tem sản phẩm bình thường! Cột khách hàng sẽ tự động để dấu gạch ngang **`—`** (không chặn, không hỏi phiền hà).

### 📦 Bước 2: Chụp các sản phẩm của khách hàng này
- Sau khi có mã khách hàng, bạn chỉ việc đưa camera chụp lần lượt các tem sản phẩm của khách đó.
- Ngay trên thanh khách hàng có sẵn hộp tổng hợp trực quan:
  - **`📦 Đã gán cho khách này: X tem • Y.YYY Kg`**.
  - Bấm nút **`Xem chi tiết ▼`** để thấy danh sách đầy đủ: từng mã sản phẩm, tên hàng, số tem, số ký và các lô hạn dùng (date) của riêng khách đó.
- Khi làm xong đơn của khách này và chuyển sang khách hàng tiếp theo:
  - Bấm nút **`🔄 Khách mới`** → Máy sẵn sàng nhận mã khách hàng mới ngay lập tức.
  - Hoặc bấm **`✕ Bỏ qua`** nếu các bao hàng tiếp theo không gắn với khách nào.

---

## 📸 3. CÁCH CHỤP SẢN PHẨM 1 CHẠM SIÊU TỐC (KHÔNG QUA NÚT OK XÁC NHẬN)

1. **Đưa mặt tem vào khung ngắm** (mặc định máy tự bật mức **`1.5x Nét`** giúp cầm điện thoại cách tem `20–25 cm` lấy nét cực căng; có thể chạm nhẹ ngón tay vào mặt tem trên màn hình để khóa nét).
2. **Bấm nút tròn `📸 CHỤP` đúng 1 lần duy nhất**:
   - **Tấm hình vừa chụp lập tức nổi lên góc trên màn hình** kèm tiếng *Bíp* — **ĐÃ TỰ ĐỘNG GHI NHẬN NGAY** (gồm **Mã khách hàng + Ảnh thu nhỏ + Tên hàng + Mã SP + Số ký + NSX + HSD**), **tuyệt đối không bắt bấm nút `OK`**!
   - Đưa thẳng ống kính sang bao hàng kế tiếp bấm **`📸 CHỤP`** liên hoàn ngay lập tức!
   - Nếu bấm nhầm bao, bấm **`🗑️ Hủy`** ngay trên tấm hình nổi để xóa tức thì; nếu góc ngày bị khuất bóng, bấm **`📷 Bù ngày`** rồi chụp góc chữ `NSX / HSD`.
3. **Bộ lọc xem nhanh theo khách trong "Nhật ký quét"**:
   - Vào mục **`📋 Nhật ký quét`**, các thẻ lọc nhanh xuất hiện: **`[ Tất cả ]`**, **`[ 👤 KH001 (10) ]`**, **`[ 👤 KH002 (5) ]`**, **`[ 👤 Chưa gán (2) ]`**.
   - Bấm vào tên khách nào thì màn hình chỉ hiện các sản phẩm của khách đó!

---

## 📊 4. BÁO CÁO TỔNG HỢP TỒN 4 CHIỀU TRÊN "SCAN TỒN"

- Bảng tính **`SCAN TỒN`** gắn cố định:
  👉 `https://docs.google.com/spreadsheets/d/1jmwE8LBV4XroBIKVohHFDXwWjEhDwSHZnUb-ziLrDgk/edit?gid=0#gid=0`
- Trang **`Chi_Tiet_Scan`** ghi chi tiết 12 cột (có cột **`Barcode khách hàng`** ngay cột thứ 2; dòng bỏ qua hiển thị **`—`**).
- Trang **`Tong_Hop_Ton`** (và mục **`📊 SKU / Date`** trên điện thoại) tự động tổng hợp tồn kho theo **4 chiều đối soát khớp 100%**:
  1. **Theo Mã SP × Theo Hạn dùng (`SKU × Date`)**
  2. **Gộp Theo Mã Sản Phẩm (`Theo SKU`)**
  3. **Gộp Theo Hạn Dùng (`Theo Date`)**
  4. **Gộp Theo Barcode Khách Hàng (`Theo KH`)**: Kê chi tiết từng khách hàng có những sản phẩm gì, số tem, số ký và kèm theo các lô hạn dùng `[Lô Date: NSX ➜ HSD]`.
