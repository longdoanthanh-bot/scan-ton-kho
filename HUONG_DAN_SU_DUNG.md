# 📦 HƯỚNG DẪN SỬ DỤNG APP QUÉT TỒN KHO TEM MÃ VẠCH — BẢN v13 SIÊU TỐC

Ứng dụng quét **dải mã vạch sọc 13 số** kết hợp **tự động đọc Ngày sản xuất (NSX) & Hạn sử dụng (HSD)** trên tem cân (ví dụ: `1010040051985` → Mã sản phẩm `10040` - *Chân giò heo trước*, Khối lượng `5.198 Kg`, `NSX: 12/11/2026`, `HSD: 15/11/2026`), **khóa cứng không quét nhầm ô vuông ở góc tem**, hoạt động **100% cả khi mất mạng** và **tự động đồng bộ 2 chiều với Google Sheet `SCAN TỒN`**.

---

## 🌐 1. ĐƯỜNG LINK MỞ DÙNG NGAY (KHÔNG CẦN CÙNG MẠNG WI-FI, KHÔNG CẦN BẬT MÁY TÍNH)

Chỉ cần điện thoại hoặc máy kiểm kho cầm tay (PDA) có 4G / 5G / bất kỳ Wi-Fi nào ở lần mở đầu tiên:
- **Dành cho Điện thoại (iPhone / Samsung / Oppo / Xiaomi...)**:
  👉 `https://longdoanthanh-bot.github.io/scan-ton-kho/#camera`
- **Dành cho Máy kiểm kho cầm tay PDA (Zebra / Urovo / Sunmi / Honeywell / iData / Newland...)**:
  👉 `https://longdoanthanh-bot.github.io/scan-ton-kho/`

> 💡 **Mẹo cài ra màn hình chính để mở nhanh khi kho lạnh mất sạch mạng**:
> - Vào mục **`⚙️ Cài Đặt`** ở thanh dưới cùng → bấm **`📲 Cài Ứng Dụng Ra Màn Hình Chính`**.
> - Trên **iPhone (Safari)**: Bấm nút **Chia sẻ (ô vuông có mũi tên lên)** → chọn **Thêm vào MH chính (Add to Home Screen)**.

---

## 📸 2. CÁCH CẦM ĐIỆN THOẠI QUÉT LẤY TRỌN MÃ SP + SỐ KÝ + NSX + HSD

1. Đưa **trọn vẹn cả tem trắng** (gồm cả dải sọc ở trên và 2 dòng chữ `NSX / HSD` ở dưới) vào trong khung ngắm trên màn hình.
   - Nếu đưa quá sát làm mép dưới khung cắt mất dòng ngày, thanh nhắc dưới khung sẽ báo: *`📐 Đã thấy mã ... — Hạ nhẹ khung xuống để thấy trọn dòng NSX/HSD bên dưới!`*.
2. Bấm **nút tròn `📸 QUÉT`** (hoặc bật nút **`⚡ Tự chốt: BẬT`** để lướt tem vào khung là máy tự quét luôn không cần bấm tay):
   - Máy **kêu bíp & chốt ngay Mã SP + Số ký trong `~0.1 giây`**.
   - Hai dòng **`NSX` & `HSD`** được tự động đọc ngay phía sau (`~0.3–0.8 giây`) rồi **gộp chung đẩy thẳng lên bảng tính Google Sheet `SCAN TỒN`**.
3. **Trường hợp túi thịt bị nhăn gập làm che chữ ngày lúc quét**:
   - **Tự bù rảnh tay (không cần bấm nút)**: Chỉ cần vuốt phẳng tem và giữ trước ống kính khoảng nửa giây, máy sẽ **tự động đọc bù `NSX / HSD` điền thẳng vào dòng vừa quét** (không tạo dòng trùng rỗng) và đẩy lên Google Sheet!
   - Hoặc bấm nút xanh **`📷 Bù ngày`** hiện nổi trên góc phải khung Camera và soi vào 2 dòng `NSX / HSD`.

---

## 📊 3. KẾT NỐI SẴN GOOGLE SHEET "SCAN TỒN" & TỰ ĐỘNG KHỚP 2 CHIỀU

- Ứng dụng đã gắn sẵn trực tiếp vào bảng tính **`SCAN TỒN`**:
  👉 `https://docs.google.com/spreadsheets/d/1jmwE8LBV4XroBIKVohHFDXwWjEhDwSHZnUb-ziLrDgk/edit?gid=0#gid=0`
- Khi bạn xóa hoặc sửa dòng trực tiếp trên trang **`Chi_Tiet_Scan`** của Google Sheet, màn hình điện thoại đang mở sẽ **tự động cập nhật lại số tem và số ký theo dữ liệu thực trên bảng tính** trong vòng vài giây mà không cần bấm nút làm mới.

---

## 📴 4. CƠ CHẾ QUÉT KHI MẤT MẠNG & TỰ ĐỘNG CẬP NHẬT KHI CÓ MẠNG

- Khi nhân viên đi vào kho lạnh kín sóng (mất cả Wi-Fi lẫn 4G):
  - Thanh thông báo cam hiện chữ **`📴 Đang không có mạng`** — nhân viên cứ quét tem (gồm cả đọc `NSX / HSD`), sửa hoặc xóa bình thường 100%.
  - Mọi tem vừa quét được khóa an toàn vào **2 lớp bộ nhớ riêng trên máy** (kể cả đóng trình duyệt hay tắt nguồn bật lại cũng không mất dữ liệu).
- Ngay khi bước ra khu vực có sóng 4G hoặc Wi-Fi:
  - Ứng dụng **tự động phát hiện có mạng** và đẩy toàn bộ các tem đang chờ (kèm đủ `NSX / HSD`) lên Google Sheet hoàn toàn tự động.
