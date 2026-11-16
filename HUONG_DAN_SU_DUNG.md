# 📦 HƯỚNG DẪN SỬ DỤNG APP CHỤP TEM TỒN KHO — BẢN v18 (CHỤP 1 CHẠM • NỔI HÌNH LÊN LÀ ĐÃ GHI NHẬN • BỎ QUA NÚT OK)

Ứng dụng chuyên biệt **1 chế độ duy nhất trên Điện thoại**: dùng **cảm biến chụp ảnh tĩnh 4:3 độ nét gốc** để chụp tem cân hàng, **bấm chụp 1 chạm là nổi hình vừa chụp lên màn hình và TỰ ĐỘNG GHI NHẬN ngay lập tức** (**bỏ qua hoàn toàn màn hình bấm nút `OK / Sử dụng ảnh`**), tự lấy trọn **Mã sản phẩm + Tên hàng + Số ký + NSX + HSD**, **khóa cứng không đọc nhầm ô vuông góc tem**, hoạt động **100% cả khi mất mạng** và **tự động đồng bộ 2 chiều với Google Sheet `SCAN TỒN`**.

---

## 🌐 1. ĐƯỜNG LINK DUY NHẤT MỞ DÙNG NGAY TRÊN ĐIỆN THOẠI

👉 `https://longdoanthanh-bot.github.io/scan-ton-kho/`

> 💡 **Mẹo cài ra màn hình chính để mở nhanh khi kho lạnh mất sạch mạng**:
> - Vào mục **`⚙️ Cài Đặt`** ở thanh dưới cùng → bấm **`📲 Cài ứng dụng ra màn hình chính`**.
> - Trên **iPhone (Safari)**: Bấm nút **Chia sẻ (ô vuông có mũi tên lên)** → chọn **Thêm vào MH chính (Add to Home Screen)**.

---

## 📸 2. CÁCH CHỤP 1 CHẠM SIÊU TỐC (KHÔNG QUA NÚT OK XÁC NHẬN)

Đã **loại bỏ sạch toàn bộ các phương thức thừa** (không còn thanh chọn máy PDA, nhập mã tay hay chế độ quét gây rối). Mở ứng dụng lên là vào thẳng **Máy Ảnh Chụp 1 Chạm `v18`**:

1. **Đưa mặt tem vào khung ngắm** (mặc định máy tự bật mức **`1.5x Nét`** giúp bạn cầm điện thoại cách tem `20–25 cm` lấy nét cực căng cả khay nhỏ `300g` lẫn bao lớn `8 Kg`; có thể chạm nhẹ ngón tay vào mặt tem trên màn hình để khóa nét hoặc bấm **`🔄 Ống kính`** trên máy nhiều camera).
2. **Bấm nút tròn `📸 CHỤP` đúng 1 lần duy nhất**:
   - **Tấm hình vừa chụp lập tức nổi lên góc trên màn hình** kèm tiếng *Bíp* — **ĐÃ TỰ ĐỘNG GHI NHẬN NGAY** (gồm **Ảnh thu nhỏ + Tên hàng + Mã SP + Số ký + NSX + HSD**), **tuyệt đối không bắt bấm nút `OK` hay hộp thoại xác nhận**!
   - Bạn **đưa thẳng ống kính sang bao hàng kế tiếp bấm `📸 CHỤP` liên hoàn ngay lập tức** mà không cần chờ!
   - Nếu chẳng may bấm chụp nhầm bao, bấm nút nhỏ **`🗑️ Hủy`** ngay trên tấm hình nổi để xóa tức thì; nếu góc ngày bị khuất bóng, bấm **`📷 Bù ngày`** rồi chụp góc chữ `NSX / HSD`.
3. **Tải loạt ảnh đã chụp sẵn (nếu có)**:
   - Nếu bạn đã chụp sẵn một loạt hình trong Thư viện điện thoại, bấm nút **`📚 Tải ảnh có sẵn`** ở góc phải dưới khung chụp để chọn nhiều hình đọc tự động 1 lần.

---

## 📊 3. BÁO CÁO TỔNG HỢP TỒN THEO MÃ HÀNG (SKU) & THEO HẠN DÙNG (DATE) TRÊN "SCAN TỒN"

- Bảng tính **`SCAN TỒN`** gắn cố định:
  👉 `https://docs.google.com/spreadsheets/d/1jmwE8LBV4XroBIKVohHFDXwWjEhDwSHZnUb-ziLrDgk/edit?gid=0#gid=0`
- Trang **`Tong_Hop_Ton`** trên Google Sheet (và mục **`📊 SKU / Date`** trên điện thoại) tự động tổng hợp tồn kho theo **3 chiều đầy đủ**:
  1. **Theo Mã SP × Theo Hạn dùng (`NSX / HSD`)**: Chi tiết từng mã hàng ở từng lô ngày kèm cảnh báo hạn dùng.
  2. **Gộp Theo Mã Sản Phẩm (`SKU`)**: Tổng số tem, tổng số ký, bình quân Kg/tem của từng mặt hàng.
  3. **Gộp Theo Hạn Dùng (`Date`)**: Sắp xếp lô hạn dùng sớm lên đầu để ưu tiên xuất trước.
- Khi bạn xóa hoặc sửa dòng trực tiếp trên trang **`Chi_Tiet_Scan`** của Google Sheet, màn hình điện thoại đang mở sẽ **tự động cập nhật khớp theo dữ liệu thực** trong vài giây mà không cần bấm nút làm mới.
