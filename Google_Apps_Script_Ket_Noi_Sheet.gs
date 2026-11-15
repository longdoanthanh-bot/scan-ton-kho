/**
 * ============================================================================
 * BỘ KẾT NỐI TỰ ĐỘNG APP QUÉT TỒN KHO (ĐIỆN THOẠI & PDA) <-> GOOGLE SHEET
 * ============================================================================
 * HƯỚNG DẪN GẮN VÀO GOOGLE SHEET MỚI (CHỈ LÀM 1 LẦN - MẤT 1 PHÚT):
 * 1. Mở một file Google Sheet mới (gõ địa chỉ: sheets.new trên trình duyệt).
 * 2. Trên thanh menu trên cùng, bấm: Tiện ích mở rộng (Extensions) -> Apps Script.
 * 3. Xóa hết chữ mặc định trong khung soạn thảo, DÁN (Paste) toàn bộ đoạn mã này vào, bấm Lưu (Ctrl+S).
 * 4. Bấm nút màu xanh góc trên phải: "Triển khai" (Deploy) -> "Tùy chọn triển khai mới" (New deployment).
 * 5. Ở mục "Chọn loại" (hình bánh răng bên trái), chọn: "Ứng dụng web" (Web app).
 * 6. Thiết lập 2 dòng quan trọng:
 *    - Thực thi dưới dạng (Execute as): "Tôi" (Me)
 *    - Ai có quyền truy cập (Who has access): "Bất kỳ ai" (Anyone)
 * 7. Bấm "Triển khai" (Deploy) -> Cấp quyền truy cập tài khoản Google -> Sao chép đường link Web App (có đuôi /exec).
 * 8. Dán đường link đó vào mục "Kết nối Google Sheet" trên App Điện thoại / PDA là XONG!
 * ============================================================================
 */

const TARGET_SPREADSHEET_ID = '1jmwE8LBV4XroBIKVohHFDXwWjEhDwSHZnUb-ziLrDgk';
const SHEET_CHI_TIET = 'Chi_Tiet_Scan';
const SHEET_TONG_HOP = 'Tong_Hop_Ton';
const SHEET_DANH_MUC = 'Danh_Muc_SP';

function getTargetSpreadsheet() {
  try {
    const active = SpreadsheetApp.getActiveSpreadsheet();
    if (active) return active;
  } catch (e) {}
  return SpreadsheetApp.openById(TARGET_SPREADSHEET_ID);
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('📦 Quản Lý Quét Tồn')
    .addItem('1. Khởi tạo / Chuẩn hóa các trang bảng tính', 'initAllSheets')
    .addItem('2. Tính toán & Làm mới lại bảng Tổng hợp', 'rebuildTotalsAndSummary')
    .addToUi();
}

function doGet(e) {
  try {
    const action = (e && e.parameter && e.parameter.action) ? String(e.parameter.action) : 'status';
    const ss = getTargetSpreadsheet();
    ensureSheetsExist(ss);

    if (action === 'ping') {
      const sh = ss.getSheetByName(SHEET_CHI_TIET);
      const count = Math.max(0, sh.getLastRow() - 1);
      return jsonResponse({
        ok: true,
        sheetName: ss.getName(),
        sheetUrl: ss.getUrl(),
        totalRows: count,
        serverTime: formatDateTimeVN(new Date())
      });
    }

    if (action === 'pull') {
      const records = readAllScanRecords(ss);
      const catalog = readCatalogRecords(ss);
      return jsonResponse({
        ok: true,
        sheetName: ss.getName(),
        sheetUrl: ss.getUrl(),
        records: records,
        catalog: catalog,
        serverTime: formatDateTimeVN(new Date())
      });
    }

    if (action === 'json_status') {
      return jsonResponse({
        ok: true,
        message: 'Kết nối Google Sheet Quét Tồn Kho đang hoạt động tốt!',
        sheetName: ss.getName(),
        sheetUrl: ss.getUrl()
      });
    }

    // Khi mở trực tiếp link /exec trên Điện thoại hoặc PDA -> Hiển thị ngay Giao diện App Quét Tồn Kho!
    return HtmlService.createHtmlOutput(buildEmbeddedAppHtml(ss.getUrl()))
      .setTitle('Quét Tồn Kho Tem Mã Vạch (PDA & Điện Thoại)')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no');
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    const rawBody = (e && e.postData && e.postData.contents) ? e.postData.contents : '{}';
    const payload = JSON.parse(rawBody);
    const action = String(payload.action || '');
    const ss = getTargetSpreadsheet();
    ensureSheetsExist(ss);

    if (action === 'ping') {
      const sh = ss.getSheetByName(SHEET_CHI_TIET);
      return jsonResponse({
        ok: true,
        sheetName: ss.getName(),
        sheetUrl: ss.getUrl(),
        totalRows: Math.max(0, sh.getLastRow() - 1)
      });
    }

    if (action === 'sync_catalog' && Array.isArray(payload.catalog)) {
      writeCatalogRecords(ss, payload.catalog);
      return jsonResponse({
        ok: true,
        catalogCount: payload.catalog.length,
        sheetUrl: ss.getUrl()
      });
    }

    if (action === 'replace_all' && Array.isArray(payload.records)) {
      writeAllScanRecords(ss, payload.records);
      if (Array.isArray(payload.catalog) && payload.catalog.length > 0) {
        const shCat = ss.getSheetByName(SHEET_DANH_MUC);
        if (shCat.getLastRow() <= 1) {
          writeCatalogRecords(ss, payload.catalog);
        }
      }
      const summary = rebuildTotalsAndSummaryInternal(ss);
      return jsonResponse({
        ok: true,
        summary: summary,
        sheetUrl: ss.getUrl()
      });
    }

    if (action === 'sync_ops' && Array.isArray(payload.ops)) {
      applyOperations(ss, payload.ops);
      if (Array.isArray(payload.catalog) && payload.catalog.length > 0) {
        const shCat = ss.getSheetByName(SHEET_DANH_MUC);
        if (shCat.getLastRow() <= 1) {
          writeCatalogRecords(ss, payload.catalog);
        }
      }
      const summary = rebuildTotalsAndSummaryInternal(ss);
      return jsonResponse({
        ok: true,
        summary: summary,
        sheetUrl: ss.getUrl()
      });
    }

    return jsonResponse({ ok: false, error: 'Hành động không hợp lệ: ' + action });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err && err.message ? err.message : err) });
  } finally {
    lock.releaseLock();
  }
}

function initAllSheets() {
  const ss = getTargetSpreadsheet();
  ensureSheetsExist(ss);
  rebuildTotalsAndSummaryInternal(ss);
}

function rebuildTotalsAndSummary() {
  const ss = getTargetSpreadsheet();
  ensureSheetsExist(ss);
  rebuildTotalsAndSummaryInternal(ss);
}

function ensureSheetsExist(ss) {
  // 1. Trang Chi_Tiet_Scan — tận dụng luôn tab đầu tiên (gid=0) nếu đang trống để link ?gid=0#gid=0 mở thẳng ra bảng số liệu!
  let shDetail = ss.getSheetByName(SHEET_CHI_TIET);
  if (!shDetail) {
    const sheets = ss.getSheets();
    if (sheets.length > 0 && sheets[0].getLastRow() === 0) {
      shDetail = sheets[0];
      shDetail.setName(SHEET_CHI_TIET);
    } else {
      shDetail = ss.insertSheet(SHEET_CHI_TIET, 0);
    }
  }
  if (shDetail.getLastRow() === 0) {
    const headers = [[
      'Ngày giờ scan',
      'Tên sản phẩm',
      'Mã sản phẩm',
      'Số ký tem vừa scan',
      'Tổng số tem đã scan',
      'Tổng số sản phẩm đã scan',
      'Tổng số ký đã scan',
      'Mã vạch gốc / Ghi chú',
      'Mã dòng đồng bộ'
    ]];
    shDetail.getRange(1, 1, 1, 9).setValues(headers)
      .setBackground('#1B365D')
      .setFontColor('#FFFFFF')
      .setFontWeight('bold')
      .setHorizontalAlignment('center')
      .setVerticalAlignment('middle');
    shDetail.setFrozenRows(1);
    shDetail.setRowHeight(1, 36);
    shDetail.setColumnWidth(1, 165);
    shDetail.setColumnWidth(2, 250);
    shDetail.setColumnWidth(3, 120);
    shDetail.setColumnWidth(4, 150);
    shDetail.setColumnWidth(5, 155);
    shDetail.setColumnWidth(6, 185);
    shDetail.setColumnWidth(7, 155);
    shDetail.setColumnWidth(8, 210);
    shDetail.setColumnWidth(9, 150);
  }

  // 2. Trang Tong_Hop_Ton
  let shSum = ss.getSheetByName(SHEET_TONG_HOP);
  if (!shSum) {
    shSum = ss.insertSheet(SHEET_TONG_HOP, 1);
  }

  // 3. Trang Danh_Muc_SP
  let shCat = ss.getSheetByName(SHEET_DANH_MUC);
  if (!shCat) {
    shCat = ss.insertSheet(SHEET_DANH_MUC, 2);
  }
  if (shCat.getLastRow() === 0) {
    shCat.getRange(1, 1, 1, 4).setValues([[
      'Mã sản phẩm (5 số)',
      'Tên sản phẩm hiển thị',
      'Tên đầy đủ hệ thống',
      'Mã Inventory ID'
    ]]).setBackground('#1B365D')
       .setFontColor('#FFFFFF')
       .setFontWeight('bold');
    shCat.setFrozenRows(1);
    shCat.setColumnWidth(1, 140);
    shCat.setColumnWidth(2, 260);
    shCat.setColumnWidth(3, 300);
    shCat.setColumnWidth(4, 150);
  }
}

function applyOperations(ss, ops) {
  const existing = readAllScanRecords(ss);
  const mapById = {};
  const orderedIds = [];

  for (let i = 0; i < existing.length; i++) {
    const rec = existing[i];
    mapById[rec.id] = rec;
    orderedIds.push(rec.id);
  }

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (!op || !op.type) continue;

    if (op.type === 'clear_all') {
      orderedIds.length = 0;
      for (const k in mapById) delete mapById[k];
      continue;
    }

    if (op.type === 'delete' && op.id) {
      if (mapById[op.id]) {
        delete mapById[op.id];
        const idx = orderedIds.indexOf(op.id);
        if (idx >= 0) orderedIds.splice(idx, 1);
      }
      continue;
    }

    if ((op.type === 'add' || op.type === 'update') && op.record && op.record.id) {
      const r = op.record;
      const grams = Math.round(Number(r.grams !== undefined ? r.grams : Math.round(Number(r.weightKg) * 1000)));
      const cleanRec = {
        id: String(r.id),
        scannedAt: String(r.scannedAt || ''),
        productName: (r.productName && String(r.productName).trim() !== '') ? String(r.productName).trim() : '—',
        productCode: String(r.productCode || '').trim(),
        grams: grams,
        weightKg: grams / 1000,
        rawBarcode: String(r.rawBarcode || '').trim(),
        note: String(r.note || '').trim()
      };
      if (!mapById[cleanRec.id]) {
        orderedIds.push(cleanRec.id);
      }
      mapById[cleanRec.id] = cleanRec;
    }
  }

  const finalList = [];
  for (let i = 0; i < orderedIds.length; i++) {
    const item = mapById[orderedIds[i]];
    if (item) finalList.push(item);
  }

  writeAllScanRecords(ss, finalList);
}

function readAllScanRecords(ss) {
  const sh = ss.getSheetByName(SHEET_CHI_TIET);
  const lastRow = sh.getLastRow();
  if (lastRow <= 1) return [];

  const values = sh.getRange(2, 1, lastRow - 1, 9).getDisplayValues();
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    if (!row[0] && !row[2] && !row[8]) continue;
    const rawKg = String(row[3] || '0').replace(/,/g, '').trim();
    const grams = Math.round(parseFloat(rawKg || '0') * 1000);
    const noteCell = String(row[7] || '');
    const parts = noteCell.split(' | ');
    const rawBc = parts[0] || '';
    const note = parts.slice(1).join(' | ');
    out.push({
      id: String(row[8] || ('row_' + (i + 2))),
      scannedAt: String(row[0] || ''),
      productName: String(row[1] || '—'),
      productCode: String(row[2] || ''),
      grams: isNaN(grams) ? 0 : grams,
      weightKg: (isNaN(grams) ? 0 : grams) / 1000,
      rawBarcode: rawBc,
      note: note
    });
  }
  return out;
}

function writeAllScanRecords(ss, records) {
  const sh = ss.getSheetByName(SHEET_CHI_TIET);
  const lastRow = sh.getLastRow();
  if (lastRow > 1) {
    sh.getRange(2, 1, lastRow - 1, 9).clearContent();
  }
  if (!records || records.length === 0) return;

  const seenCodes = {};
  let distinctCount = 0;
  let runningGrams = 0;
  const rows = [];

  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const code = String(r.productCode || '').trim();
    const name = (r.productName && String(r.productName).trim() !== '') ? String(r.productName).trim() : '—';
    const grams = Math.round(Number(r.grams !== undefined ? r.grams : Math.round(Number(r.weightKg || 0) * 1000)));
    runningGrams += grams;

    if (code && !seenCodes[code]) {
      seenCodes[code] = true;
      distinctCount += 1;
    }

    const bcAndNote = [String(r.rawBarcode || '').trim(), String(r.note || '').trim()]
      .filter(function(x) { return x !== ''; })
      .join(' | ');

    rows.push([
      String(r.scannedAt || ''),
      name,
      code,
      grams / 1000,
      i + 1,
      distinctCount,
      runningGrams / 1000,
      bcAndNote,
      String(r.id || ('scan_' + (i + 1)))
    ]);
  }

  // Định dạng cột văn bản trước khi ghi để bảo toàn số 0 đầu (ví dụ 02860, 1010040051985)
  sh.getRange(2, 1, rows.length, 1).setNumberFormat('@');
  sh.getRange(2, 3, rows.length, 1).setNumberFormat('@');
  sh.getRange(2, 8, rows.length, 2).setNumberFormat('@');

  sh.getRange(2, 1, rows.length, 9).setValues(rows);

  sh.getRange(2, 4, rows.length, 1).setNumberFormat('#,##0.000');
  sh.getRange(2, 5, rows.length, 2).setNumberFormat('#,##0');
  sh.getRange(2, 7, rows.length, 1).setNumberFormat('#,##0.000');
  sh.getRange(2, 3, rows.length, 1).setHorizontalAlignment('center');
  sh.getRange(2, 5, rows.length, 2).setHorizontalAlignment('center');
}

function rebuildTotalsAndSummaryInternal(ss) {
  const records = readAllScanRecords(ss);
  // Ghi lại lũy kế chuẩn xác trên Chi_Tiet_Scan
  writeAllScanRecords(ss, records);

  const byProduct = {};
  let totalGrams = 0;

  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const key = r.productCode || 'CHUA_RO';
    if (!byProduct[key]) {
      byProduct[key] = {
        code: r.productCode || '—',
        name: r.productName || '—',
        count: 0,
        grams: 0
      };
    }
    if (byProduct[key].name === '—' && r.productName && r.productName !== '—') {
      byProduct[key].name = r.productName;
    }
    byProduct[key].count += 1;
    byProduct[key].grams += r.grams;
    totalGrams += r.grams;
  }

  const productList = Object.keys(byProduct).map(function(k) { return byProduct[k]; });
  productList.sort(function(a, b) { return b.grams - a.grams; });

  const totalScans = records.length;
  const totalProducts = productList.length;
  const totalKg = totalGrams / 1000;

  const shSum = ss.getSheetByName(SHEET_TONG_HOP);
  shSum.clear();

  // Tiêu đề & Khối KPI Tổng quan
  shSum.getRange('A1:G1').merge()
    .setValue('BÁO CÁO TỔNG HỢP KIỂM TỒN KHO QUÉT TEM MÃ VẠCH')
    .setBackground('#1B365D')
    .setFontColor('#FFFFFF')
    .setFontSize(13)
    .setFontWeight('bold')
    .setHorizontalAlignment('center');
  shSum.setRowHeight(1, 38);

  shSum.getRange('A2:G2').merge()
    .setValue('Cập nhật mới nhất: ' + formatDateTimeVN(new Date()))
    .setBackground('#EEF2F6')
    .setFontColor('#334155')
    .setHorizontalAlignment('center');

  shSum.getRange('A4:B4').merge().setValue('TỔNG SỐ TEM ĐÃ SCAN').setBackground('#E0F2FE').setFontWeight('bold').setHorizontalAlignment('center');
  shSum.getRange('C4:D4').merge().setValue('TỔNG SỐ SẢN PHẨM ĐÃ SCAN').setBackground('#FEF3C7').setFontWeight('bold').setHorizontalAlignment('center');
  shSum.getRange('E4:G4').merge().setValue('TỔNG SỐ KÝ ĐÃ SCAN (Kg)').setBackground('#DCFCE7').setFontWeight('bold').setHorizontalAlignment('center');

  shSum.getRange('A5:B5').merge().setValue(totalScans).setNumberFormat('#,##0').setFontSize(16).setFontWeight('bold').setHorizontalAlignment('center');
  shSum.getRange('C5:D5').merge().setValue(totalProducts).setNumberFormat('#,##0').setFontSize(16).setFontWeight('bold').setHorizontalAlignment('center');
  shSum.getRange('E5:G5').merge().setValue(totalKg).setNumberFormat('#,##0.000').setFontSize(16).setFontWeight('bold').setHorizontalAlignment('center');
  shSum.setRowHeight(5, 36);

  // Bảng tổng hợp theo từng mã sản phẩm
  const sumHeaders = [[
    'STT',
    'Mã sản phẩm',
    'Tên sản phẩm',
    'Tổng số tem đã scan',
    'Tổng số ký đã scan (Kg)',
    'Bình quân (Kg/tem)',
    'Tỷ trọng khối lượng (%)'
  ]];
  shSum.getRange(7, 1, 1, 7).setValues(sumHeaders)
    .setBackground('#1B365D')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold')
    .setHorizontalAlignment('center');
  shSum.setRowHeight(7, 32);

  if (productList.length > 0) {
    const sumRows = [];
    for (let i = 0; i < productList.length; i++) {
      const p = productList[i];
      const kg = p.grams / 1000;
      const avgKg = p.count > 0 ? (kg / p.count) : 0;
      const share = totalGrams > 0 ? (p.grams / totalGrams) : 0;
      sumRows.push([
        i + 1,
        String(p.code),
        String(p.name),
        p.count,
        kg,
        avgKg,
        share
      ]);
    }
    shSum.getRange(8, 2, sumRows.length, 1).setNumberFormat('@');
    shSum.getRange(8, 1, sumRows.length, 7).setValues(sumRows);
    shSum.getRange(8, 1, sumRows.length, 2).setHorizontalAlignment('center');
    shSum.getRange(8, 4, sumRows.length, 1).setNumberFormat('#,##0').setHorizontalAlignment('center');
    shSum.getRange(8, 5, sumRows.length, 2).setNumberFormat('#,##0.000');
    shSum.getRange(8, 7, sumRows.length, 1).setNumberFormat('0.0%');

    const totalRowIdx = 8 + sumRows.length;
    shSum.getRange(totalRowIdx, 1, 1, 7).setValues([[
      '',
      'TỔNG CỘNG',
      totalProducts + ' mã sản phẩm',
      totalScans,
      totalKg,
      totalScans > 0 ? (totalKg / totalScans) : 0,
      totalGrams > 0 ? 1 : 0
    ]]).setBackground('#E2E8F0').setFontWeight('bold');
    shSum.getRange(totalRowIdx, 4, 1, 1).setNumberFormat('#,##0').setHorizontalAlignment('center');
    shSum.getRange(totalRowIdx, 5, 1, 2).setNumberFormat('#,##0.000');
    shSum.getRange(totalRowIdx, 7, 1, 1).setNumberFormat('0.0%');
  }

  shSum.setColumnWidth(1, 60);
  shSum.setColumnWidth(2, 120);
  shSum.setColumnWidth(3, 270);
  shSum.setColumnWidth(4, 155);
  shSum.setColumnWidth(5, 175);
  shSum.setColumnWidth(6, 150);
  shSum.setColumnWidth(7, 165);

  return {
    totalScans: totalScans,
    totalProducts: totalProducts,
    totalKg: totalKg
  };
}

function readCatalogRecords(ss) {
  const sh = ss.getSheetByName(SHEET_DANH_MUC);
  const lastRow = sh.getLastRow();
  if (lastRow <= 1) return [];
  const vals = sh.getRange(2, 1, lastRow - 1, 4).getDisplayValues();
  const out = [];
  for (let i = 0; i < vals.length; i++) {
    const code = String(vals[i][0] || '').trim();
    const name = String(vals[i][1] || '').trim();
    if (code && name) {
      out.push({
        code: code,
        name: name,
        fullName: String(vals[i][2] || name).trim(),
        inventoryId: String(vals[i][3] || '').trim()
      });
    }
  }
  return out;
}

function writeCatalogRecords(ss, catalog) {
  const sh = ss.getSheetByName(SHEET_DANH_MUC);
  const lastRow = sh.getLastRow();
  if (lastRow > 1) {
    sh.getRange(2, 1, lastRow - 1, 4).clearContent();
  }
  if (!catalog || catalog.length === 0) return;
  const rows = catalog.map(function(c) {
    return [
      String(c.code || '').trim(),
      String(c.name || '').trim(),
      String(c.fullName || c.name || '').trim(),
      String(c.inventoryId || '').trim()
    ];
  });
  sh.getRange(2, 1, rows.length, 4).setNumberFormat('@');
  sh.getRange(2, 1, rows.length, 4).setValues(rows);
}

function formatDateTimeVN(d) {
  return Utilities.formatDate(d, 'Asia/Ho_Chi_Minh', 'dd/MM/yyyy HH:mm:ss');
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}


// Các hàm gọi trực tiếp từ giao diện Web App nhúng trên Google (google.script.run)
function clientPullData() {
  const ss = getTargetSpreadsheet();
  ensureSheetsExist(ss);
  return {
    ok: true,
    sheetUrl: ss.getUrl(),
    records: readAllScanRecords(ss),
    catalog: readCatalogRecords(ss)
  };
}

function clientPushOps(ops) {
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    const ss = getTargetSpreadsheet();
    ensureSheetsExist(ss);
    applyOperations(ss, ops);
    const summary = rebuildTotalsAndSummaryInternal(ss);
    return {
      ok: true,
      summary: summary,
      records: readAllScanRecords(ss)
    };
  } finally {
    lock.releaseLock();
  }
}

function buildEmbeddedAppHtml(sheetUrl) {
  const defaultMapJson = "{\"01167\": \"Ba rọi heo\", \"01169\": \"Cốt lết heo\", \"01171\": \"Thịt heo xay\", \"02173\": \"Mỡ heo tảng\", \"02730\": \"Da heo\", \"02860\": \"Mỡ heo cắt sẵn\", \"02868\": \"Cốt lết heo có mỡ\", \"02919\": \"Nạc nọng heo thượng hạng (Premium)\", \"02920\": \"Nạc dăm heo đầu giòn (Premium)\", \"02921\": \"Ba rọi heo thượng hạng (Premium)\", \"02922\": \"Sườn non cắt nướng BBQ (Premium)\", \"02923\": \"Đuôi heo (Premium)\", \"02924\": \"Sụn mặt trăng (Premium)\", \"02926\": \"Sườn non heo (Premium)\", \"02927\": \"Giò heo trước cắt khoanh (Premium)\", \"02928\": \"Móng giò heo cắt khoanh (Premium)\", \"02929\": \"Bắp giò heo cuộn (Premium)\", \"02930\": \"Sườn vai heo\", \"02931\": \"Nạc dăm heo\", \"02933\": \"Thăn chuột heo\", \"02934\": \"Ba rọi heo\", \"02935\": \"Cốt lết heo\", \"02936\": \"Thịt đùi heo\", \"02937\": \"Xương ống heo\", \"02938\": \"Xương heo\", \"02970\": \"Sườn chìa heo (Premium)\", \"02971\": \"Thăn nõn heo (Premium)\", \"02972\": \"Bắp hoa heo (Premium)\", \"05576\": \"Nạc nọng heo thượng hạng (Premium)\", \"05577\": \"Nạc dăm heo đầu giòn (Premium)\", \"05578\": \"Ba rọi heo thượng hạng (Premium)\", \"05579\": \"Sườn non cắt nướng BBQ (Premium)\", \"05580\": \"Đuôi heo (Premium)\", \"05581\": \"Sụn mặt trăng (Premium)\", \"05582\": \"Thịt heo xay đặc biệt ít mỡ (Premium)\", \"05583\": \"Bắp giò heo cuộn (Premium)\", \"05584\": \"Sườn non heo (Premium)\", \"05585\": \"Giò heo trước cắt khoanh (Premium)\", \"05586\": \"Móng giò heo cắt khoanh (Premium)\", \"05587\": \"Sườn vai heo\", \"05588\": \"Nạc dăm heo\", \"05589\": \"Ba rọi heo\", \"05590\": \"Cốt lết heo\", \"05591\": \"Thịt đùi heo\", \"05592\": \"Xương ống heo\", \"05593\": \"Xương heo\", \"05594\": \"Thịt heo xay\", \"05595\": \"Thăn chuột heo\", \"05598\": \"Sườn chìa heo (Premium)\", \"05599\": \"Thăn nõn heo (Premium)\", \"05600\": \"Bắp hoa heo (Premium)\", \"10009\": \"Sụn mặt trăng (Premium)\", \"10017\": \"Sườn vai heo\", \"10020\": \"Thăn chuột heo\", \"10021\": \"Ba rọi heo\", \"10026\": \"Xương ống heo\", \"10028\": \"Thịt heo xay\", \"10038\": \"Xương ống heo\", \"10039\": \"Xương cổ heo\", \"10040\": \"Chân giò heo trước\", \"10041\": \"Thịt đùi heo\", \"10044\": \"Sườn vai heo\", \"10045\": \"Nạc dăm\", \"10046\": \"Ba rọi heo\", \"10047\": \"Đuôi heo\", \"10049\": \"Sườn non\", \"10050\": \"Nạc nọng heo thượng hạng\", \"10053\": \"Xương vá heo\", \"10054\": \"Nạc đùi heo\", \"10055\": \"Da heo\", \"10059\": \"Thăn chuột heo\", \"10060\": \"Móng giò heo kinh tế\", \"10061\": \"Giò heo trước cắt khoanh\", \"10062\": \"Phụ phẩm heo\", \"10064\": \"Da vụn heo có mỡ\", \"10065\": \"Thịt nọng vụn\", \"10069\": \"Xương hom\", \"10070\": \"Xương ống trơ\", \"10071\": \"Thịt vai heo\", \"10072\": \"Xương heo\", \"10073\": \"Nạc thăn heo\", \"10075\": \"Thịt nách heo\", \"10076\": \"Thịt heo xay đặc biệt\", \"10078\": \"Chân giò heo sau\", \"10081\": \"Mỡ bụng heo (mỡ sa)\", \"10082\": \"Mỡ lưng\", \"10084\": \"Da tảng heo có mỡ\", \"10085\": \"Thịt vụn cốt lết\", \"10087\": \"Nạc vai heo\", \"10089\": \"Dựng heo\", \"10090\": \"Cốt lết heo có mỡ\", \"10091\": \"Cốt lết heo\", \"10092\": \"Thịt heo xay\", \"10093\": \"Mỡ heo tảng\", \"10096\": \"Ba rọi heo cắt miếng\", \"10097\": \"Thịt đùi heo cắt miếng\", \"10098\": \"Thịt vai heo cắt miếng\", \"10099\": \"Cốt lết nguyên tảng\", \"10100\": \"Cốt lết có mỡ nguyên tảng\", \"10101\": \"Dựng heo cắt khoanh\", \"10102\": \"Xương ống heo nhiều thịt\", \"10103\": \"Xương cổ heo nhiều thịt\", \"10104\": \"Xương ống ngắn\", \"10105\": \"Xương ống dài\", \"10133\": \"Nạc đùi heo lọc tinh\", \"10134\": \"Thịt đùi heo không da\", \"10135\": \"Thịt đùi gọ heo\", \"10136\": \"Thịt vai heo không da\", \"10141\": \"Xương heo cắt miếng\", \"10142\": \"Xương giá heo cắt miếng\", \"10143\": \"Xương ống heo cắt đôi\", \"10144\": \"Xương ống heo nhiều thịt cắt miếng\", \"10145\": \"Xương ống dài cắt đôi\", \"10146\": \"Xương hom cắt miếng\", \"10149\": \"Bắp giò heo cuộn\", \"10151\": \"Nạc thăn heo lọc tinh\", \"10152\": \"Thịt vụn nạc thăn\", \"10159\": \"Thịt vụn\", \"10169\": \"Phần bụng heo\", \"10178\": \"Sườn non không sụn\"}";
  return [
    '<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8">',
    '<style>',
    'body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f1f5f9;color:#0f172a;padding-bottom:40px}',
    '.hdr{background:#0f2942;color:#fff;padding:10px 12px;display:flex;justify-content:space-between;align-items:center}',
    '.wrap{max-width:680px;margin:0 auto;padding:10px}',
    '.kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:10px}',
    '.kpi{background:#fff;border-radius:10px;padding:9px 6px;text-align:center;border:1px solid #cbd5e1;border-top:4px solid #0284c7}',
    '.kpi.w{border-top-color:#16a34a;background:#f0fdf4}',
    '.kpi-l{font-size:11px;font-weight:700;color:#475569;text-transform:uppercase}',
    '.kpi-v{font-size:21px;font-weight:900;color:#0f2942;margin-top:2px}',
    '.card{background:#fff;border-radius:12px;padding:12px;border:1.5px solid #cbd5e1;margin-bottom:10px}',
    '.inp{width:100%;box-sizing:border-box;padding:10px 12px;font-size:16px;font-weight:700;border:1.5px solid #94a3b8;border-radius:9px}',
    '.btn{border:none;border-radius:9px;padding:10px 13px;font-weight:700;font-size:13.5px;cursor:pointer;background:#0284c7;color:#fff}',
    '.btn-g{background:#15803d}.btn-w{background:#d97706}.btn-r{background:#b91c1c}.btn-o{background:#e2e8f0;color:#0f172a}',
    '.row{border:1px solid #e2e8f0;border-left:4px solid #0284c7;border-radius:9px;padding:8px 10px;margin-bottom:7px;display:flex;justify-content:space-between;align-items:center;gap:8px}',
    '</style>',
    '<script src="https://cdn.jsdelivr.net/npm/zxing-wasm@3.1.6/dist/iife/reader/index.js"><\/script>',
    '</head><body>',
    '<div class="hdr"><div><strong>📦 QUÉT TỒN KHO TEM MÃ VẠCH</strong><div style="font-size:11.5px;color:#bae6fd">Đã kết nối trực tiếp Google Sheet</div></div>',
    '<a href="' + sheetUrl + '" target="_blank" style="color:#fff;background:rgba(255,255,255,0.18);padding:6px 10px;border-radius:99px;text-decoration:none;font-size:12px;font-weight:700">📊 Mở Sheet</a></div>',
    '<div class="wrap">',
    '<div class="kpis">',
    '<div class="kpi"><div class="kpi-l">Tổng số tem đã scan</div><div id="kScans" class="kpi-v">0</div></div>',
    '<div class="kpi" style="border-top-color:#d97706"><div class="kpi-l">Tổng số SP đã scan</div><div id="kProds" class="kpi-v">0</div></div>',
    '<div class="kpi w"><div class="kpi-l">Tổng số ký đã scan</div><div id="kKg" class="kpi-v" style="color:#15803d">0.000</div></div>',
    '</div>',
    '<div id="msg" style="display:none;padding:9px 12px;border-radius:9px;margin-bottom:10px;font-weight:700;font-size:13px"></div>',
    '<div class="card" style="border-color:#0284c7">',
    '<div style="display:flex;gap:6px;margin-bottom:8px">',
    '<input id="bcInp" class="inp" inputmode="none" placeholder="Bấm tia quét PDA hoặc nhập mã 13 số...">',
    '<button class="btn" onclick="submitBc()">Quét</button>',
    '</div>',
    '<div style="display:flex;gap:6px;flex-wrap:wrap">',
    '<button class="btn btn-o" onclick="toggleKb()" id="kbBtn">⌨️ Bật bàn phím số</button>',
    '<button class="btn btn-g" onclick="document.getElementById(\'camFile\').click()">📷 Chụp / Quét ảnh mã vạch sọc</button>',
    '<button class="btn btn-w" onclick="manualAdd()">➕ Nhập điều chỉnh</button>',
    '<input type="file" id="camFile" accept="image/*" capture="environment" style="display:none" onchange="scanPhoto(this)">',
    '</div></div>',
    '<div class="card" id="latestBox">',
    '<div style="display:flex;justify-content:space-between;font-size:12.5px;color:#475569;margin-bottom:4px"><strong style="color:#15803d">✅ TEM VỪA SCAN</strong><span>🕒 Ngày giờ: <strong id="lTime">—</strong></span></div>',
    '<div style="font-size:12px;color:#475569">Tên sản phẩm:</div><div id="lName" style="font-size:19px;font-weight:900;color:#0f2942;margin-bottom:8px">Chưa quét tem nào</div>',
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">',
    '<div style="background:#f8fafc;padding:8px;border-radius:8px;border:1px solid #e2e8f0"><div style="font-size:11.5px;color:#475569">Mã sản phẩm</div><div id="lCode" style="font-size:19px;font-weight:900">—</div></div>',
    '<div style="background:#f8fafc;padding:8px;border-radius:8px;border:1px solid #e2e8f0"><div style="font-size:11.5px;color:#475569">Số ký tem vừa scan</div><div id="lKg" style="font-size:19px;font-weight:900;color:#15803d">0.000 Kg</div></div>',
    '</div></div>',
    '<div class="card"><div style="font-weight:800;margin-bottom:8px">📋 Danh sách đã quét (Bấm Sửa / Xóa đồng bộ ngay lên Sheet)</div><div id="listArea">Đang tải dữ liệu từ Google Sheet...</div></div>',
    '</div>',
    '<script>',
    'const CAT = ' + defaultMapJson + ';',
    'let RECS = []; let kbOn = false;',
    'function showMsg(t,err){const el=document.getElementById("msg");el.style.display="block";el.style.background=err?"#fee2e2":"#dcfce7";el.style.color=err?"#b91c1c":"#15803d";el.textContent=t;}',
    'function toggleKb(){kbOn=!kbOn;const i=document.getElementById("bcInp");i.setAttribute("inputmode",kbOn?"numeric":"none");document.getElementById("kbBtn").textContent=kbOn?"🔫 Chế độ PDA (Ẩn phím)":"⌨️ Bật bàn phím số";i.focus();}',
    'function eanOk(s){let sum=0;for(let i=0;i<12;i++){sum+=(i%2===0?1:3)*(s.charCodeAt(i)-48);}return((10-(sum%10))%10)===(s.charCodeAt(12)-48);}',
    'function nowStr(){const d=new Date(),p=n=>n<10?"0"+n:""+n;return p(d.getDate())+"/"+p(d.getMonth()+1)+"/"+d.getFullYear()+" "+p(d.getHours())+":"+p(d.getMinutes())+":"+p(d.getSeconds());}',
    'function submitBc(){const i=document.getElementById("bcInp");const v=i.value.replace(/\\s+/g,"");i.value="";if(!v)return;if(!/^\\d{13}$/.test(v)||!eanOk(v)){showMsg("Mã vạch "+v+" không đúng chuẩn 13 số hoặc sai số kiểm tra!",true);return;}',
    'const pfx=v.slice(0,2);if(["10","11","20","21","22","23","24","25","26","27","28","29"].indexOf(pfx)===-1){showMsg("Mã "+v+" không phải tem cân ký!",true);return;}',
    'const code=v.slice(2,7);const grams=parseInt(v.slice(7,12),10);if(grams<=0){showMsg("Số ký bằng 0 không hợp lệ!",true);return;}',
    'const rec={id:"scan_"+Date.now()+"_"+Math.random().toString(36).slice(2,6),scannedAt:nowStr(),productCode:code,productName:CAT[code]||"—",grams:grams,weightKg:grams/1000,rawBarcode:v,note:""};',
    'RECS.push(rec);render();syncOps([{type:"add",record:rec}]);i.focus();}',
    'document.getElementById("bcInp").addEventListener("keydown",e=>{if(e.key==="Enter"||e.key==="Tab"){e.preventDefault();submitBc();}});',
    'function syncOps(ops){showMsg("Đang lưu lên Google Sheet...",false);google.script.run.withSuccessHandler(r=>{if(r&&r.records){RECS=r.records;render();showMsg("✅ Đã lưu đồng bộ lên Google Sheet!",false);}}).withFailureHandler(e=>showMsg("Lỗi lưu Sheet: "+e.message,true)).clientPushOps(ops);}',
    'function editRow(id){const r=RECS.find(x=>x.id===id);if(!r)return;const nc=prompt("Mã sản phẩm (5 số):",r.productCode);if(nc===null)return;const code=nc.trim();const nn=prompt("Tên sản phẩm:",CAT[code]||r.productName);if(nn===null)return;const nk=prompt("Số ký (Kg):",((r.grams||0)/1000).toFixed(3));if(nk===null)return;const g=Math.round(parseFloat(nk.replace(",","."))*1000);if(!g||g<=0){alert("Số ký không hợp lệ!");return;}r.productCode=code;r.productName=nn.trim()||"—";r.grams=g;r.weightKg=g/1000;r.note="Đã điều chỉnh";CAT[code]=r.productName;render();syncOps([{type:"update",record:r}]);}',
    'function delRow(id){if(!confirm("Xóa dòng quét này trên cả App và Google Sheet?"))return;RECS=RECS.filter(x=>x.id!==id);render();syncOps([{type:"delete",id:id}]);}',
    'function manualAdd(){const c=prompt("Nhập Mã sản phẩm 5 số (VD: 10040):");if(!c)return;const code=c.trim();const n=prompt("Tên sản phẩm:",CAT[code]||"");if(n===null)return;const k=prompt("Nhập Số ký (VD: 5.198):");if(!k)return;const g=Math.round(parseFloat(k.replace(",","."))*1000);if(!g||g<=0){alert("Số ký không hợp lệ!");return;}const rec={id:"scan_"+Date.now(),scannedAt:nowStr(),productCode:code,productName:n.trim()||"—",grams:g,weightKg:g/1000,rawBarcode:"",note:"Nhập tay"};RECS.push(rec);render();syncOps([{type:"add",record:rec}]);}',
    'async function scanPhoto(inp){const f=inp.files&&inp.files[0];inp.value="";if(!f)return;showMsg("⚡ Đang đọc mã vạch siêu tốc...",false);try{const opts={formats:["EAN-13","Code128","EAN-8","ITF","UPC-A"],tryHarder:true,tryRotate:true,tryInvert:true,tryDownscale:true,binarizer:"LocalAverage"};let hits=await ZXingWASM.readBarcodes(f,opts);if(hits&&hits.length>0){document.getElementById("bcInp").value=hits[0].text;submitBc();return;}showMsg("Không thấy rõ dải mã vạch 13 số. Hãy chụp cách tem 20cm cho nét!",true);}catch(e){showMsg("Lỗi đọc ảnh: "+e.message,true);}}',
    'function render(){let tg=0;const seen={};RECS.forEach(r=>{tg+=Math.round(r.grams||0);if(r.productCode)seen[r.productCode]=true;});document.getElementById("kScans").textContent=RECS.length;document.getElementById("kProds").textContent=Object.keys(seen).length;document.getElementById("kKg").textContent=(tg/1000).toFixed(3);if(RECS.length>0){const l=RECS[RECS.length-1];document.getElementById("lTime").textContent=l.scannedAt;document.getElementById("lName").textContent=l.productName||"—";document.getElementById("lCode").textContent=l.productCode;document.getElementById("lKg").textContent=((l.grams||0)/1000).toFixed(3)+" Kg";}const area=document.getElementById("listArea");if(!RECS.length){area.innerHTML="Chưa có tem nào được quét.";return;}area.innerHTML=RECS.slice().reverse().map((r,idx)=>"<div class=\"row\"><div><div style=\"font-size:12px;color:#475569\">#"+(RECS.length-idx)+" • <strong>"+r.productCode+"</strong> • "+r.scannedAt+"</div><div style=\"font-weight:800\">"+(r.productName||"—")+"</div></div><div style=\"text-align:right\"><div style=\"font-weight:900;color:#15803d;font-size:16px\">"+((r.grams||0)/1000).toFixed(3)+" Kg</div><div style=\"margin-top:4px;display:flex;gap:4px\"><button class=\"btn btn-o\" style=\"padding:4px 8px;font-size:12px\" onclick=\"editRow('"+r.id+"')\">✏️ Sửa</button><button class=\"btn btn-r\" style=\"padding:4px 8px;font-size:12px\" onclick=\"delRow('"+r.id+"')\">🗑️</button></div></div></div>").join("");}',
    'google.script.run.withSuccessHandler(d=>{if(d&&d.records){RECS=d.records;if(d.catalog)d.catalog.forEach(c=>{if(c.code&&c.name)CAT[c.code]=c.name;});render();}}).clientPullData();',
    'document.getElementById("bcInp").focus();',
    '<\/script></body></html>'
  ].join('\n');
}
