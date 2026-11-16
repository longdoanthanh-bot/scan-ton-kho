# 📦 HƯỚNG DẪN SỬ DỤNG APP QUÉT TỒN KHO TEM MÃ VẠCH — BẢN v17 SIÊU TỐC (CHỤP LOẠT HÌNH & TẢI LÊN 1 LẦN)

Ứng dụng quét **dải mã vạch sọc 13 số** kết hợp **tự động đọc Ngày sản xuất (NSX) & Hạn sử dụng (HSD)** trên tem cân (ví dụ: `1010040051985` → Mã sản phẩm `10040` - *Chân giò heo trước*, Khối lượng `5.198 Kg`, `NSX: 12/11/2026`, `HSD: 15/11/2026`), hỗ trợ **chụp hàng loạt ảnh bằng Máy ảnh gốc điện thoại rồi tải lên 1 lần**, **khóa cứng không quét nhầm ô vuông ở góc tem**, hoạt động **100% cả khi mất mạng** và **tự động đồng bộ 2 chiều với Google Sheet `SCAN TỒN`**.

---

## 🌐 1. ĐƯỜNG LINK MỞ DÙNG NGAY (KHÔNG CẦN CÙNG MẠNG WI-FI, KHÔNG CẦN BẬT MÁY TÍNH)

Chỉ cần điện thoại hoặc máy kiểm kho cầm tay (PDA) có 4G / 5G / bất kỳ Wi-Fi nào ở lần mở đầu tiên:
- **Dành cho Điện thoại — Chụp 1 loạt hình sắc nét rồi tải lên (Khuyên dùng số 1 cho cả khay nhỏ 300g & bao lớn 8 Kg)**:
  👉 `https://longdoanthanh-bot.github.io/scan-ton-kho/#batch`
- **Dành cho Điện thoại — Quét trực tiếp bằng khung Camera**:
  👉 `https://longdoanthanh-bot.github.io/scan-ton-kho/#camera`
- **Dành cho Máy kiểm kho cầm tay PDA (Zebra / Urovo / Sunmi / Honeywell / iData / Newland...)**:
  👉 `https://longdoanthanh-bot.github.io/scan-ton-kho/`

> 💡 **Mẹo cài ra màn hình chính để mở nhanh khi kho lạnh mất sạch mạng**:
> - Vào mục **`⚙️ Cài Đặt`** ở thanh dưới cùng → bấm **`📲 Cài Ứng Dụng Ra Màn Hình Chính`**.
> - Trên **iPhone (Safari)**: Bấm nút **Chia sẻ (ô vuông có mũi tên lên)** → chọn **Thêm vào MH chính (Add to Home Screen)**.

---

## 📚 2. CÁCH NHANH & NÉT TUYỆT ĐỐI 100%: CHỤP 1 LOẠT HÌNH BẰNG MÁY ẢNH GỐC ĐIỆN THOẠI → TẢI LÊN 1 LẦN

Khi kiểm kho các khay nhỏ `300g` hoặc bao thịt trong kho lạnh, trình duyệt web trên nhiều dòng điện thoại bị khóa vào 1 ống kính cố định nên không tự chuyển sang chế độ lấy nét sát gần như ứng dụng **Máy ảnh gốc của điện thoại**. Giải pháp **`📚 Loạt ảnh`** giải quyết triệt để 100%:

1. **Bước 1 (Chụp liên hoàn bằng Máy ảnh gốc)**:
   - Mở ứng dụng **Máy ảnh có sẵn trên điện thoại** (tự động lấy nét cận cảnh cực nét như mắt nhìn).
   - Đi dọc kệ/pallet bấm chụp liên tục **10, 30, 50 hoặc 200+ tấm hình mặt tem** (kể cả khi đang ở sâu trong kho lạnh mất sạch sóng mạng).
2. **Bước 2 (Tải cả loạt ảnh lên 1 lần)**:
   - Mở ứng dụng ở mục **`📚 Loạt ảnh`** → bấm nút xanh lớn **`📚 CHỌN 1 LOẠT ẢNH TEM TẢI LÊN (CHỌN NHIỀU HÌNH)`**.
   - Đánh dấu chọn toàn bộ loạt ảnh vừa chụp → bấm **Xong / Thêm**.
   - Máy **tự động đọc lần lượt từng tấm** (lấy trọn **Mã sản phẩm + Số ký + NSX + HSD**), hiện thanh tiến trình kèm bảng kiểm đếm rõ ràng từng tấm (`Đủ Mã+Ngày` / `Thiếu Ngày` / `Chưa rõ mã`) và **tự động đẩy toàn bộ lên Google Sheet `SCAN TỒN`**!
   - Nếu cần chụp lẻ ngay 1 tấm bằng Máy ảnh gốc, bấm nút **`📷 Mở Máy Ảnh Gốc ĐT chụp lẻ 1 tấm`**.

---

## 📊 3. BÁO CÁO TỔNG HỢP TỒN THEO SKU & THEO DATE TRÊN GOOGLE SHEET "SCAN TỒN"

- Ứng dụng đã gắn sẵn trực tiếp vào bảng tính **`SCAN TỒN`**:
  👉 `https://docs.google.com/spreadsheets/d/1jmwE8LBV4XroBIKVohHFDXwWjEhDwSHZnUb-ziLrDgk/edit?gid=0#gid=0`
- Trang **`Tong_Hop_Ton`** trên Google Sheet (cũng như tab **`📊 SKU / Date`** ngay trên màn hình điện thoại) tự động tổng hợp tồn kho theo **3 chiều đầy đủ**:
  1. **Theo Mã SKU × Theo Date (`NSX / HSD`)**: Chi tiết từng mã hàng ở từng lô hạn dùng kèm cảnh báo số ngày còn lại.
  2. **Gộp Theo Mã Sản Phẩm (`SKU`)**: Tổng số tem, tổng số ký, bình quân Kg/tem và chi tiết từng Date của mỗi mã.
  3. **Gộp Theo Date (`HSD / NSX`)**: Sắp xếp hạn dùng sớm lên đầu để ưu tiên xuất trước, kèm danh sách các mã hàng thuộc từng Date.
- Khi bạn xóa hoặc sửa dòng trực tiếp trên trang **`Chi_Tiet_Scan`** của Google Sheet, màn hình điện thoại đang mở sẽ **tự động cập nhật lại số tem và số ký theo dữ liệu thực trên bảng tính** trong vòng vài giây mà không cần bấm nút làm mới.

---

## 📴 4. CƠ CHẾ QUÉT KHI MẤT MẠNG & TỰ ĐỘNG CẬP NHẬT KHI CÓ MẠNG

- Khi nhân viên đi vào kho lạnh kín sóng (mất cả Wi-Fi lẫn 4G):
  - Thanh thông báo cam hiện chữ **`📴 Đang không có mạng`** — nhân viên cứ quét tem (gồm cả đọc `NSX / HSD`), sửa hoặc xóa bình thường 100%.
  - Mọi tem vừa quét được khóa an toàn vào **2 lớp bộ nhớ riêng trên máy** (kể cả đóng trình duyệt hay tắt nguồn bật lại cũng không mất dữ liệu).
- Ngay khi bước ra khu vực có sóng 4G hoặc Wi-Fi:
  - Ứng dụng **tự động phát hiện có mạng** và đẩy toàn bộ các tem đang chờ (kèm đủ `NSX / HSD`) lên Google Sheet hoàn toàn tự động.
