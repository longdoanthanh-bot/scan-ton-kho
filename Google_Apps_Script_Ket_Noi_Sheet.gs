/**
 * ============================================================================
 * BỘ KẾT NỐI TỰ ĐỘNG 2 CHIỀU APP QUÉT TỒN KHO <-> GOOGLE SHEET (v11)
 * Hỗ trợ trường tùy chọn Barcode Khách Hàng (có thể bỏ qua không bắt buộc)
 * + Tự động đọc NSX & HSD + Báo cáo Tổng hợp Tồn 4 chiều (SKU × Date, Theo SKU, Theo Date, Theo Khách hàng)
 * + Đồng bộ tức thì khi xóa/sửa dòng trực tiếp trên Sheet
 * ============================================================================
 * - Google Sheet gắn cố định: https://docs.google.com/spreadsheets/d/1jmwE8LBV4XroBIKVohHFDXwWjEhDwSHZnUb-ziLrDgk/edit?gid=0#gid=0
 * - Đường truyền Web App (/exec): https://script.google.com/macros/s/AKfycbw_vz2A35sbBHaPgDSkCuUFl_fW7QIsghCsACc92aDs_kyOiC9ea39ZpyWu3_MaccTn/exec
 * ============================================================================
 */

const TARGET_SPREADSHEET_ID = '1jmwE8LBV4XroBIKVohHFDXwWjEhDwSHZnUb-ziLrDgk';
const SHEET_CHI_TIET = 'Du_Lieu_Scan';
const SHEET_TONG_HOP = 'Tong_Hop_Moi';
const SHEET_DANH_MUC = 'Danh_Muc_SP';
const APP_ONLINE_URL = 'https://longdoanthanh-bot.github.io/scan-ton-kho/';
const SCRIPT_VERSION = 'v14_dup_warning_6_fields';

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
    .addItem('2. Tính toán & Làm mới lại bảng Tổng hợp (SKU • Date • Khách hàng)', 'rebuildTotalsAndSummary')
    .addToUi();
}

function onEdit(e) {
  try {
    if (!e || !e.range) return;
    const sh = e.range.getSheet();
    if (!sh || sh.getName() !== SHEET_CHI_TIET) return;
    if (e.range.getRow() <= 1) return;
    const lock = LockService.getScriptLock();
    if (lock.tryLock(5000)) {
      try {
        rebuildTotalsAndSummaryInternal(sh.getParent());
      } finally {
        lock.releaseLock();
      }
    }
  } catch (err) {}
}

function isCustomerHeader(title) {
  const t = String(title || '').trim().toLowerCase();
  return t === 'tên khách' || t === 'khách hàng' || t === 'barcode khách hàng' || t.indexOf('khách') >= 0;
}

function isCodeFirstHeader(col3Title) {
  const t = String(col3Title || '').trim().toLowerCase();
  return t === 'mã hàng' || t === 'mã sản phẩm' || t.indexOf('mã ') === 0;
}

function sheetNeedsSelfHeal(ss, parsedRecords) {
  try {
    const shDetail = ss.getSheetByName(SHEET_CHI_TIET);
    const shSum = ss.getSheetByName(SHEET_TONG_HOP);
    if (!shDetail || !shSum) return false;

    const col2Title = String(shDetail.getRange(1, 2).getDisplayValue() || '').trim();
    const col3Title = String(shDetail.getRange(1, 3).getDisplayValue() || '').trim();
    if (!isCustomerHeader(col2Title) || !isCodeFirstHeader(col3Title)) {
      return true;
    }

    const physicalRows = Math.max(0, shDetail.getLastRow() - 1);
    if (physicalRows !== parsedRecords.length) {
      return true;
    }
    if (parsedRecords.length > 0) {
      const lastSeq = Number(shDetail.getRange(parsedRecords.length + 1, 8).getValue());
      if (lastSeq !== parsedRecords.length) {
        return true;
      }
    }
    const sumCountVal = shSum.getRange('A5').getValue();
    if (sumCountVal === '' || Number(sumCountVal) !== parsedRecords.length) {
      return true;
    }
    const sumBanner = String(shSum.getRange('A1').getValue() || '');
    if (sumBanner.indexOf('KHÁCH HÀNG') === -1) {
      return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

function doGet(e) {
  try {
    const action = (e && e.parameter && e.parameter.action) ? String(e.parameter.action) : 'status';
    const ss = getTargetSpreadsheet();
    ensureSheetsExist(ss);

    if (action === 'ping') {
      const recs = readAllScanRecords(ss);
      return jsonResponse({
        ok: true,
        version: SCRIPT_VERSION,
        sheetName: ss.getName(),
        sheetUrl: ss.getUrl(),
        totalRows: recs.length,
        serverTime: formatDateTimeVN(new Date())
      });
    }

    if (action === 'pull') {
      let recs = readAllScanRecords(ss);
      if (sheetNeedsSelfHeal(ss, recs)) {
        const lock = LockService.getScriptLock();
        if (lock.tryLock(8000)) {
          try {
            ensureSheetsExist(ss);
            rebuildTotalsAndSummaryInternal(ss);
            recs = readAllScanRecords(ss);
          } finally {
            lock.releaseLock();
          }
        }
      }
      const includeCat = !(e && e.parameter && String(e.parameter.lite || '') === '1');
      return jsonResponse({
        ok: true,
        version: SCRIPT_VERSION,
        sheetName: ss.getName(),
        sheetUrl: ss.getUrl(),
        records: recs,
        catalog: includeCat ? readCatalogRecords(ss) : undefined,
        serverTime: formatDateTimeVN(new Date())
      });
    }

    if (action === 'json_status') {
      return jsonResponse({
        ok: true,
        version: SCRIPT_VERSION,
        message: 'Kết nối 2 chiều Google Sheet Quét Tồn Kho (Hỗ trợ Barcode Khách Hàng tùy chọn + SKU & Date) đang hoạt động tốt!',
        sheetName: ss.getName(),
        sheetUrl: ss.getUrl()
      });
    }

    const html = [
      '<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8">',
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
      '<style>body{font-family:Segoe UI,Roboto,sans-serif;background:#f1f5f9;padding:24px;text-align:center;color:#0f172a}',
      '.box{max-width:480px;margin:20px auto;background:#fff;border-radius:14px;padding:22px;border:1.5px solid #cbd5e1;box-shadow:0 4px 14px rgba(0,0,0,.06)}',
      '.btn{display:block;padding:12px 16px;margin-top:10px;border-radius:10px;text-decoration:none;font-weight:700;color:#fff;background:#0284c7}',
      '.btn.g{background:#15803d}</style></head><body><div class="box">',
      '<h2 style="margin:0 0 8px;color:#0f2942">✅ Cổng Đồng Bộ 2 Chiều Google Sheet Đang Hoạt Động</h2>',
      '<p style="font-size:14px;color:#475569">Đã kết nối trực tiếp bảng tính <strong>' + ss.getName() + '</strong> (Hỗ trợ Barcode Khách hàng tùy chọn, Mã SKU, Số Ký, NSX, HSD, Tổng hợp 4 chiều và đồng bộ ngược khi xóa/sửa dòng trên Sheet).</p>',
      '<a class="btn g" href="' + APP_ONLINE_URL + '" target="_top">📷 Mở Ứng Dụng Quét Tồn Kho</a>',
      '<a class="btn" href="' + ss.getUrl() + '" target="_blank">📊 Mở Bảng Tính Google Sheet</a>',
      '</div></body></html>'
    ].join('');
    return HtmlService.createHtmlOutput(html).setTitle('Kết Nối Google Sheet Quét Tồn Kho');
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
      const recs = readAllScanRecords(ss);
      return jsonResponse({
        ok: true,
        version: SCRIPT_VERSION,
        sheetName: ss.getName(),
        sheetUrl: ss.getUrl(),
        totalRows: recs.length
      });
    }

    if (action === 'sync_catalog' && Array.isArray(payload.catalog)) {
      writeCatalogRecords(ss, payload.catalog);
      return jsonResponse({ ok: true, catalogCount: payload.catalog.length, sheetUrl: ss.getUrl() });
    }

    if (action === 'replace_all' && Array.isArray(payload.records)) {
      writeAllScanRecords(ss, payload.records);
      if (Array.isArray(payload.catalog) && payload.catalog.length > 0) {
        const shCat = ss.getSheetByName(SHEET_DANH_MUC);
        if (shCat.getLastRow() <= 1) writeCatalogRecords(ss, payload.catalog);
      }
      const summary = rebuildTotalsAndSummaryInternal(ss);
      const finalRecords = readAllScanRecords(ss);
      return jsonResponse({
        ok: true,
        version: SCRIPT_VERSION,
        summary: summary,
        records: finalRecords,
        sheetUrl: ss.getUrl()
      });
    }

    if (action === 'sync_ops' && Array.isArray(payload.ops)) {
      applyOperations(ss, payload.ops);
      if (Array.isArray(payload.catalog) && payload.catalog.length > 0) {
        const shCat = ss.getSheetByName(SHEET_DANH_MUC);
        if (shCat.getLastRow() <= 1) writeCatalogRecords(ss, payload.catalog);
      }
      const summary = rebuildTotalsAndSummaryInternal(ss);
      const finalRecords = readAllScanRecords(ss);
      return jsonResponse({
        ok: true,
        version: SCRIPT_VERSION,
        summary: summary,
        records: finalRecords,
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

function formatDetailHeader(shDetail) {
  const headers = [[
    'Ngày giờ scan',
    'Tên khách', // Hỗ trợ 3 dạng: Quét mã vạch • Tự nhập • Bỏ qua (Barcode khách hàng)
    'Mã hàng',
    'Tên hàng',
    'Khối lượng (Kg)',
    'NSX',
    'HSD',
    'Tổng số tem',
    'Tổng số mặt hàng',
    'Tổng khối lượng (Kg)',
    'Mã vạch gốc / Ghi chú',
    'Mã dòng đồng bộ'
  ]];
  shDetail.getRange(1, 1, 1, 12).setValues(headers)
    .setBackground('#1B365D')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');
  shDetail.setFrozenRows(1);
  shDetail.setRowHeight(1, 36);
  const widths = [155, 165, 110, 230, 135, 115, 115, 120, 145, 155, 200, 150];
  for (let c = 0; c < widths.length; c++) {
    shDetail.setColumnWidth(c + 1, widths[c]);
  }
}

function ensureSheetsExist(ss) {
  let shDetail = ss.getSheetByName(SHEET_CHI_TIET);
  if (!shDetail) {
    shDetail = ss.insertSheet(SHEET_CHI_TIET, 0);
  }

  let shSum = ss.getSheetByName(SHEET_TONG_HOP);
  if (!shSum) shSum = ss.insertSheet(SHEET_TONG_HOP, 1);

  let shCat = ss.getSheetByName(SHEET_DANH_MUC);
  if (!shCat) shCat = ss.insertSheet(SHEET_DANH_MUC, 2);
  if (shCat.getLastRow() === 0) {
    shCat.getRange(1, 1, 1, 4).setValues([[
      'Mã sản phẩm (5 số)',
      'Tên sản phẩm hiển thị',
      'Tên đầy đủ hệ thống',
      'Mã Inventory ID'
    ]]).setBackground('#1B365D').setFontColor('#FFFFFF').setFontWeight('bold');
    shCat.setFrozenRows(1);
    shCat.setColumnWidth(1, 140);
    shCat.setColumnWidth(2, 260);
    shCat.setColumnWidth(3, 300);
    shCat.setColumnWidth(4, 150);
  }

  if (shDetail.getLastRow() === 0) {
    formatDetailHeader(shDetail);
  } else {
    const col2Title = String(shDetail.getRange(1, 2).getDisplayValue() || '').trim();
    const col3Title = String(shDetail.getRange(1, 3).getDisplayValue() || '').trim();
    const col5Title = String(shDetail.getRange(1, 5).getDisplayValue() || '').trim();
    if (!isCustomerHeader(col2Title)) {
      const migratedRecords = (col5Title === 'NSX')
        ? readLegacy11ColRecords(shDetail)
        : readLegacy9ColRecords(shDetail);
      formatDetailHeader(shDetail);
      writeAllScanRecords(ss, migratedRecords);
      rebuildTotalsAndSummaryInternal(ss);
    } else if (!isCodeFirstHeader(col3Title)) {
      const migratedRecords = readAllScanRecords(ss);
      formatDetailHeader(shDetail);
      writeAllScanRecords(ss, migratedRecords);
      rebuildTotalsAndSummaryInternal(ss);
    }
  }
}

function readLegacy9ColRecords(sh) {
  const lastRow = sh.getLastRow();
  if (lastRow <= 1) return [];
  const values = sh.getRange(2, 1, lastRow - 1, 9).getDisplayValues();
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    const code = String(row[2] || '').trim();
    const rawKg = String(row[3] || '').replace(/,/g, '').trim();
    const grams = Math.round(parseFloat(rawKg || '0') * 1000);
    if (!code && (isNaN(grams) || grams <= 0)) continue;
    if (isNaN(grams) || grams <= 0) continue;
    const parts = String(row[7] || '').split(' | ');
    out.push({
      id: String(row[8] || ('row_' + (i + 2))),
      scannedAt: String(row[0] || ''),
      customerBarcode: '',
      productName: String(row[1] || '—'),
      productCode: code,
      grams: grams,
      weightKg: grams / 1000,
      nsx: '',
      hsd: '',
      rawBarcode: parts[0] || '',
      note: parts.slice(1).join(' | ')
    });
  }
  return out;
}

function readLegacy11ColRecords(sh) {
  const lastRow = sh.getLastRow();
  if (lastRow <= 1) return [];
  const values = sh.getRange(2, 1, lastRow - 1, 11).getDisplayValues();
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    const code = String(row[2] || '').trim();
    const rawKg = String(row[3] || '').replace(/,/g, '').trim();
    const grams = Math.round(parseFloat(rawKg || '0') * 1000);
    if ((!code && !String(row[0] || '').trim()) || isNaN(grams) || grams <= 0) {
      continue;
    }
    const parts = String(row[9] || '').split(' | ');
    out.push({
      id: String(row[10] || '').trim() || ('sheet_row_' + (i + 2) + '_' + code + '_' + grams),
      scannedAt: String(row[0] || '').trim(),
      customerBarcode: '',
      productName: String(row[1] || '—').trim() || '—',
      productCode: code,
      grams: grams,
      weightKg: grams / 1000,
      nsx: cleanDateField(row[4]),
      hsd: cleanDateField(row[5]),
      rawBarcode: (parts[0] || '').trim(),
      note: parts.slice(1).join(' | ').trim()
    });
  }
  return out;
}

function cleanCustomerField(v) {
  const s = String(v || '').replace(/[\r\n\t]+/g, ' ').trim();
  if (!s || s === '—' || s === '-' || s === 'null' || s === 'undefined') return '';
  return s.slice(0, 64);
}

function cleanDateField(v) {
  const s = String(v || '').trim();
  if (!s || s === '—' || s === '-' || s === 'null' || s === 'undefined') return '';
  return s;
}

function parseDateVNToUtc(rawStr) {
  const s = cleanDateField(rawStr);
  if (!s) return { ok: false, utc: Number.MAX_SAFE_INTEGER, display: '—' };
  const m = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/.exec(s);
  if (!m) return { ok: false, utc: Number.MAX_SAFE_INTEGER - 1, display: s };
  const d = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const y = parseInt(m[3], 10);
  if (y < 2020 || y > 2045 || mo < 1 || mo > 12 || d < 1 || d > 31) {
    return { ok: false, utc: Number.MAX_SAFE_INTEGER - 1, display: s };
  }
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== (mo - 1) || dt.getUTCDate() !== d) {
    return { ok: false, utc: Number.MAX_SAFE_INTEGER - 1, display: s };
  }
  const pad2 = function (n) { return n < 10 ? ('0' + n) : String(n); };
  return {
    ok: true,
    utc: dt.getTime(),
    display: pad2(d) + '/' + pad2(mo) + '/' + y
  };
}

function getTodayUtcVN() {
  const parts = Utilities.formatDate(new Date(), 'Asia/Ho_Chi_Minh', 'yyyy-MM-dd').split('-');
  return Date.UTC(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
}

function evaluateShelfLifeStatus(hsdStr, todayUtc) {
  const p = parseDateVNToUtc(hsdStr);
  // Nguyên tắc Fail-Closed: Thiếu ngày thì trả về '—', tuyệt đối không tự đoán hạn dùng!
  if (!p.ok) {
    return { text: '—', level: 'unknown', bg: '#F8FAFC', fg: '#64748B' };
  }
  const diffDays = Math.round((p.utc - todayUtc) / 86400000);
  if (diffDays < 0) {
    return {
      text: 'Quá hạn ' + Math.abs(diffDays) + ' ngày',
      level: 'expired',
      bg: '#FEE2E2',
      fg: '#991B1B'
    };
  }
  if (diffDays === 0) {
    return {
      text: 'Hết hạn hôm nay',
      level: 'today',
      bg: '#FEF3C7',
      fg: '#92400E'
    };
  }
  if (diffDays <= 2) {
    return {
      text: 'Còn ' + diffDays + ' ngày (Cận date)',
      level: 'near',
      bg: '#FEF3C7',
      fg: '#92400E'
    };
  }
  return {
    text: 'Còn ' + diffDays + ' ngày',
    level: 'ok',
    bg: '#DCFCE7',
    fg: '#166534'
  };
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
      const prev = mapById[String(r.id)] || null;
      // Nếu là thao tác 'update' trên dòng đã bị người dùng xóa trực tiếp trên Google Sheet -> tôn trọng quyết định xóa trên Sheet, không tự hồi sinh!
      if (op.type === 'update' && !prev) {
        continue;
      }
      const grams = Math.round(Number(r.grams !== undefined ? r.grams : Math.round(Number(r.weightKg) * 1000)));
      const incomingCust = (r.customerBarcode !== undefined)
        ? cleanCustomerField(r.customerBarcode)
        : (prev ? cleanCustomerField(prev.customerBarcode) : '');
      const incomingNsx = (r.nsx !== undefined) ? cleanDateField(r.nsx) : (prev ? prev.nsx : '');
      const incomingHsd = (r.hsd !== undefined) ? cleanDateField(r.hsd) : (prev ? prev.hsd : '');
      const cleanRec = {
        id: String(r.id),
        scannedAt: String(r.scannedAt || (prev ? prev.scannedAt : '')),
        customerBarcode: incomingCust,
        productName: (r.productName && String(r.productName).trim() !== '') ? String(r.productName).trim() : '—',
        productCode: String(r.productCode || '').trim(),
        grams: grams,
        weightKg: grams / 1000,
        nsx: incomingNsx,
        hsd: incomingHsd,
        rawBarcode: String(r.rawBarcode !== undefined ? r.rawBarcode : (prev ? prev.rawBarcode : '')).trim(),
        note: String(r.note !== undefined ? r.note : (prev ? prev.note : '')).trim()
      };
      if (!mapById[cleanRec.id]) orderedIds.push(cleanRec.id);
      mapById[cleanRec.id] = cleanRec;
    }
  }

  const finalList = [];
  for (let i = 0; i < orderedIds.length; i++) {
    const item = mapById[orderedIds[i]];
    if (item) finalList.push(item);
  }
  writeAllScanRecords(ss, finalList);
  return finalList;
}

function readAllScanRecords(ss) {
  const sh = ss.getSheetByName(SHEET_CHI_TIET);
  const lastRow = sh.getLastRow();
  if (lastRow <= 1) return [];

  const col2Title = String(sh.getRange(1, 2).getDisplayValue() || '').trim();
  const col3Title = String(sh.getRange(1, 3).getDisplayValue() || '').trim();
  const col5Title = String(sh.getRange(1, 5).getDisplayValue() || '').trim();
  if (!isCustomerHeader(col2Title)) {
    return (col5Title === 'NSX') ? readLegacy11ColRecords(sh) : readLegacy9ColRecords(sh);
  }

  const codeFirst = isCodeFirstHeader(col3Title);
  const values = sh.getRange(2, 1, lastRow - 1, 12).getDisplayValues();
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    const code = String((codeFirst ? row[2] : row[3]) || '').trim();
    const name = String((codeFirst ? row[3] : row[2]) || '—').trim() || '—';
    const rawKg = String(row[4] || '').replace(/,/g, '').trim();
    const grams = Math.round(parseFloat(rawKg || '0') * 1000);
    // Nếu người dùng xóa dòng hoặc bôi đen bấm Delete xóa Mã SP / Số ký trên Sheet -> ghi nhận dòng đó đã bị xóa!
    if ((!code && !String(row[0] || '').trim()) || isNaN(grams) || grams <= 0) {
      continue;
    }
    const parts = String(row[10] || '').split(' | ');
    out.push({
      id: String(row[11] || '').trim() || ('sheet_row_' + (i + 2) + '_' + code + '_' + grams),
      scannedAt: String(row[0] || '').trim(),
      customerBarcode: cleanCustomerField(row[1]),
      productName: name,
      productCode: code,
      grams: grams,
      weightKg: grams / 1000,
      nsx: cleanDateField(row[5]),
      hsd: cleanDateField(row[6]),
      rawBarcode: (parts[0] || '').trim(),
      note: parts.slice(1).join(' | ').trim()
    });
  }
  return out;
}

function writeAllScanRecords(ss, records) {
  const sh = ss.getSheetByName(SHEET_CHI_TIET);
  const lastRow = sh.getLastRow();
  const maxCol = Math.max(12, sh.getLastColumn());
  if (lastRow > 1) {
    sh.getRange(2, 1, lastRow - 1, maxCol).clearContent();
  }
  if (!records || records.length === 0) return;

  const seenCodes = {};
  const dupCodeWeightCounts = {};
  const dupCustCodeWeightCounts = {};
  for (let k = 0; k < records.length; k++) {
    const rk = records[k];
    const ck = String(rk.productCode || '').trim();
    const gk = Math.round(Number(rk.grams !== undefined ? rk.grams : Math.round(Number(rk.weightKg || 0) * 1000)));
    const custk = cleanCustomerField(rk.customerBarcode).toLowerCase();
    if (ck && gk > 0) {
      const pairKey = ck + '|' + gk;
      dupCodeWeightCounts[pairKey] = (dupCodeWeightCounts[pairKey] || 0) + 1;
      if (custk) {
        const triKey = custk + '|' + ck + '|' + gk;
        dupCustCodeWeightCounts[triKey] = (dupCustCodeWeightCounts[triKey] || 0) + 1;
      }
    }
  }

  let distinctCount = 0;
  let runningGrams = 0;
  const rows = [];
  const rowBgs = [];
  const rowFgs = [];

  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const custRaw = cleanCustomerField(r.customerBarcode);
    const custDisp = custRaw || '—';
    const code = String(r.productCode || '').trim();
    const name = (r.productName && String(r.productName).trim() !== '') ? String(r.productName).trim() : '—';
    const grams = Math.round(Number(r.grams !== undefined ? r.grams : Math.round(Number(r.weightKg || 0) * 1000)));
    const nsxDisp = cleanDateField(r.nsx) || '—';
    const hsdDisp = cleanDateField(r.hsd) || '—';
    runningGrams += grams;

    if (code && !seenCodes[code]) {
      seenCodes[code] = true;
      distinctCount += 1;
    }

    const pairCount = (code && grams > 0) ? (dupCodeWeightCounts[code + '|' + grams] || 0) : 0;
    const triCount = (custRaw && code && grams > 0) ? (dupCustCodeWeightCounts[custRaw.toLowerCase() + '|' + code + '|' + grams] || 0) : 0;
    const isDupRow = pairCount >= 2;
    let noteClean = String(r.note || '').trim();
    if (isDupRow && noteClean.indexOf('TRÙNG') === -1) {
      const warnTxt = (triCount >= 2)
        ? ('⚠️ CẢNH BÁO TRÙNG KHÁCH + MÃ + SỐ KÝ (x' + pairCount + ')')
        : ('⚠️ CẢNH BÁO TRÙNG MÃ + SỐ KÝ (x' + pairCount + ')');
      noteClean = noteClean ? (warnTxt + ' | ' + noteClean) : warnTxt;
    }

    const bcAndNote = [String(r.rawBarcode || '').trim(), noteClean]
      .filter(function (x) { return x !== ''; })
      .join(' | ');

    rows.push([
      String(r.scannedAt || ''),
      custDisp,
      code,
      name,
      grams / 1000,
      nsxDisp,
      hsdDisp,
      i + 1,
      distinctCount,
      runningGrams / 1000,
      bcAndNote,
      String(r.id || ('scan_' + (i + 1)))
    ]);

    const bg = isDupRow ? '#FEE2E2' : '#FFFFFF';
    const fg = isDupRow ? '#991B1B' : '#0F172A';
    rowBgs.push([bg, bg, bg, bg, bg, bg, bg, bg, bg, bg, bg, bg]);
    rowFgs.push([fg, fg, fg, fg, fg, fg, fg, fg, fg, fg, fg, fg]);
  }

  sh.getRange(2, 1, rows.length, 3).setNumberFormat('@');
  sh.getRange(2, 6, rows.length, 2).setNumberFormat('@');
  sh.getRange(2, 11, rows.length, 2).setNumberFormat('@');

  const dataRange = sh.getRange(2, 1, rows.length, 12);
  dataRange.setValues(rows);
  dataRange.setBackgrounds(rowBgs);
  dataRange.setFontColors(rowFgs);

  sh.getRange(2, 5, rows.length, 1).setNumberFormat('#,##0.000');
  sh.getRange(2, 8, rows.length, 2).setNumberFormat('#,##0');
  sh.getRange(2, 10, rows.length, 1).setNumberFormat('#,##0.000');
  sh.getRange(2, 2, rows.length, 2).setHorizontalAlignment('center');
  sh.getRange(2, 6, rows.length, 4).setHorizontalAlignment('center');
}

function rebuildTotalsAndSummaryInternal(ss) {
  const records = readAllScanRecords(ss);
  writeAllScanRecords(ss, records);

  const todayUtc = getTodayUtcVN();
  const bySku = {};
  const byDate = {};
  const bySkuDate = {};
  const byCustomer = {};
  const knownDateKeyMap = {};
  const knownCustomerMap = {};
  let totalGrams = 0;

  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const custClean = cleanCustomerField(r.customerBarcode);
    const custDisp = custClean || '—';
    const hasCustomer = Boolean(custClean !== '');
    const codeKey = String(r.productCode || '').trim() || 'CHUA_RO';
    const dispCode = String(r.productCode || '').trim() || '—';
    const dispName = (r.productName && r.productName !== '—') ? String(r.productName).trim() : '—';
    const pNsx = parseDateVNToUtc(r.nsx);
    const pHsd = parseDateVNToUtc(r.hsd);
    const nsxDisp = pNsx.ok ? pNsx.display : (cleanDateField(r.nsx) || '—');
    const hsdDisp = pHsd.ok ? pHsd.display : (cleanDateField(r.hsd) || '—');
    const hasAnyDate = Boolean(nsxDisp !== '—' || hsdDisp !== '—');
    const datePairKey = hsdDisp + '|' + nsxDisp;
    const skuDateKey = codeKey + '|' + datePairKey;
    const g = Math.round(Number(r.grams || 0));

    totalGrams += g;
    if (hasAnyDate) {
      knownDateKeyMap[datePairKey] = true;
    }
    if (hasCustomer) {
      knownCustomerMap[custClean] = true;
    }

    // 1. Nhóm theo SKU × Date (NSX / HSD)
    if (!bySkuDate[skuDateKey]) {
      bySkuDate[skuDateKey] = {
        code: dispCode,
        name: dispName,
        nsx: nsxDisp,
        hsd: hsdDisp,
        nsxUtc: pNsx.utc,
        hsdUtc: pHsd.utc,
        hasDate: hasAnyDate,
        count: 0,
        grams: 0
      };
    }
    if (bySkuDate[skuDateKey].name === '—' && dispName !== '—') {
      bySkuDate[skuDateKey].name = dispName;
    }
    bySkuDate[skuDateKey].count += 1;
    bySkuDate[skuDateKey].grams += g;

    // 2. Nhóm gộp theo SKU (Mã sản phẩm)
    if (!bySku[codeKey]) {
      bySku[codeKey] = {
        code: dispCode,
        name: dispName,
        count: 0,
        grams: 0,
        missingDateCount: 0,
        dateBreakdown: {}
      };
    }
    if (bySku[codeKey].name === '—' && dispName !== '—') {
      bySku[codeKey].name = dispName;
    }
    bySku[codeKey].count += 1;
    bySku[codeKey].grams += g;
    if (!hasAnyDate) {
      bySku[codeKey].missingDateCount += 1;
    }
    if (!bySku[codeKey].dateBreakdown[datePairKey]) {
      bySku[codeKey].dateBreakdown[datePairKey] = {
        nsx: nsxDisp,
        hsd: hsdDisp,
        hsdUtc: pHsd.utc,
        nsxUtc: pNsx.utc,
        hasDate: hasAnyDate,
        count: 0,
        grams: 0
      };
    }
    bySku[codeKey].dateBreakdown[datePairKey].count += 1;
    bySku[codeKey].dateBreakdown[datePairKey].grams += g;

    // 3. Nhóm gộp theo Date (HSD / NSX)
    if (!byDate[datePairKey]) {
      byDate[datePairKey] = {
        nsx: nsxDisp,
        hsd: hsdDisp,
        nsxUtc: pNsx.utc,
        hsdUtc: pHsd.utc,
        hasDate: hasAnyDate,
        count: 0,
        grams: 0,
        skuBreakdown: {}
      };
    }
    byDate[datePairKey].count += 1;
    byDate[datePairKey].grams += g;
    if (!byDate[datePairKey].skuBreakdown[codeKey]) {
      byDate[datePairKey].skuBreakdown[codeKey] = {
        code: dispCode,
        name: dispName,
        count: 0,
        grams: 0
      };
    }
    if (byDate[datePairKey].skuBreakdown[codeKey].name === '—' && dispName !== '—') {
      byDate[datePairKey].skuBreakdown[codeKey].name = dispName;
    }
    byDate[datePairKey].skuBreakdown[codeKey].count += 1;
    byDate[datePairKey].skuBreakdown[codeKey].grams += g;

    // 4. Nhóm gộp theo Barcode Khách hàng (tùy chọn — bỏ qua thì gom về '—')
    const custKey = hasCustomer ? ('KH_' + custClean) : '__SKIPPED__';
    if (!byCustomer[custKey]) {
      byCustomer[custKey] = {
        customer: custDisp,
        hasCustomer: hasCustomer,
        count: 0,
        grams: 0,
        dateLots: {},
        skuBreakdown: {}
      };
    }
    byCustomer[custKey].count += 1;
    byCustomer[custKey].grams += g;
    if (hasAnyDate) {
      byCustomer[custKey].dateLots[datePairKey] = true;
    }
    if (!byCustomer[custKey].skuBreakdown[codeKey]) {
      byCustomer[custKey].skuBreakdown[codeKey] = {
        code: dispCode,
        name: dispName,
        count: 0,
        grams: 0
      };
    }
    if (byCustomer[custKey].skuBreakdown[codeKey].name === '—' && dispName !== '—') {
      byCustomer[custKey].skuBreakdown[codeKey].name = dispName;
    }
    byCustomer[custKey].skuBreakdown[codeKey].count += 1;
    byCustomer[custKey].skuBreakdown[codeKey].grams += g;
  }

  // Sắp xếp Bảng 1 (Theo SKU × Date): theo Mã SKU tăng dần, cùng SKU ưu tiên HSD gần nhất lên đầu (FEFO), chưa rõ date xếp cuối
  const skuDateList = Object.keys(bySkuDate).map(function (k) { return bySkuDate[k]; });
  skuDateList.sort(function (a, b) {
    if (a.code !== b.code) return String(a.code).localeCompare(String(b.code));
    if (a.hsdUtc !== b.hsdUtc) return a.hsdUtc - b.hsdUtc;
    if (a.nsxUtc !== b.nsxUtc) return a.nsxUtc - b.nsxUtc;
    return b.grams - a.grams;
  });

  // Sắp xếp Bảng 2 (Gộp Theo SKU): theo Tổng số ký giảm dần
  const skuList = Object.keys(bySku).map(function (k) { return bySku[k]; });
  skuList.sort(function (a, b) {
    if (b.grams !== a.grams) return b.grams - a.grams;
    return String(a.code).localeCompare(String(b.code));
  });

  // Sắp xếp Bảng 3 (Gộp Theo Date): ưu tiên HSD hết hạn sớm lên đầu (FEFO), dòng chưa rõ NSX/HSD xếp cuối
  const dateList = Object.keys(byDate).map(function (k) { return byDate[k]; });
  dateList.sort(function (a, b) {
    if (a.hasDate !== b.hasDate) return a.hasDate ? -1 : 1;
    if (a.hsdUtc !== b.hsdUtc) return a.hsdUtc - b.hsdUtc;
    if (a.nsxUtc !== b.nsxUtc) return a.nsxUtc - b.nsxUtc;
    return b.grams - a.grams;
  });

  // Sắp xếp Bảng 4 (Gộp Theo Barcode Khách hàng): ưu tiên dòng có gán KH lên đầu theo số ký giảm dần, dòng bỏ qua ('—') xếp cuối
  const customerList = Object.keys(byCustomer).map(function (k) { return byCustomer[k]; });
  customerList.sort(function (a, b) {
    if (a.hasCustomer !== b.hasCustomer) return a.hasCustomer ? -1 : 1;
    if (b.grams !== a.grams) return b.grams - a.grams;
    return String(a.customer).localeCompare(String(b.customer));
  });

  const totalScans = records.length;
  const totalProducts = skuList.length;
  const knownDateLotsCount = Object.keys(knownDateKeyMap).length;
  const knownCustomerCount = Object.keys(knownCustomerMap).length;
  const totalKg = totalGrams / 1000;

  // Cầu dao tự ngắt KCS kiểm tra chéo tổng số tem & tổng số ký giữa cả 4 chiều báo cáo
  let chk1Cnt = 0, chk1G = 0, chk2Cnt = 0, chk2G = 0, chk3Cnt = 0, chk3G = 0, chk4Cnt = 0, chk4G = 0;
  for (let i = 0; i < skuDateList.length; i++) { chk1Cnt += skuDateList[i].count; chk1G += skuDateList[i].grams; }
  for (let i = 0; i < skuList.length; i++) { chk2Cnt += skuList[i].count; chk2G += skuList[i].grams; }
  for (let i = 0; i < dateList.length; i++) { chk3Cnt += dateList[i].count; chk3G += dateList[i].grams; }
  for (let i = 0; i < customerList.length; i++) { chk4Cnt += customerList[i].count; chk4G += customerList[i].grams; }
  if (chk1Cnt !== totalScans || chk2Cnt !== totalScans || chk3Cnt !== totalScans || chk4Cnt !== totalScans ||
      chk1G !== totalGrams || chk2G !== totalGrams || chk3G !== totalGrams || chk4G !== totalGrams) {
    throw new Error('KCS FAIL: Lệch số liệu đối chiếu chéo giữa 4 chiều tổng hợp SKU × Date × Khách hàng!');
  }

  const shSum = ss.getSheetByName(SHEET_TONG_HOP);
  shSum.clear();

  // Tiêu đề & Thời gian cập nhật (Cột A..I)
  shSum.getRange('A1:I1').merge()
    .setValue('BÁO CÁO TỔNG HỢP TỒN KHO QUÉT TEM MÃ VẠCH (THEO SKU & THEO DATE & KHÁCH HÀNG)')
    .setBackground('#1B365D')
    .setFontColor('#FFFFFF')
    .setFontSize(13)
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');
  shSum.setRowHeight(1, 38);

  shSum.getRange('A2:I2').merge()
    .setValue(
      'Cập nhật mới nhất: ' + formatDateTimeVN(new Date()) +
      ' • Tự động đối soát 4 chiều: SKU × Date | Theo SKU | Theo Date | Theo Khách hàng (' +
      (knownCustomerCount > 0 ? (knownCustomerCount + ' mã KH') : 'Chưa gán KH') + ')'
    )
    .setBackground('#EEF2F6')
    .setFontColor('#334155')
    .setHorizontalAlignment('center');

  // 4 Thẻ chỉ số tổng quan (Giữ nguyên ô A5 = Tổng số tem để tự động kiểm tra đồng bộ!)
  shSum.getRange('A4:B4').merge().setValue('TỔNG SỐ TEM ĐÃ SCAN').setBackground('#E0F2FE').setFontWeight('bold').setHorizontalAlignment('center');
  shSum.getRange('C4:D4').merge().setValue('TỔNG SỐ MÃ SKU').setBackground('#FEF3C7').setFontWeight('bold').setHorizontalAlignment('center');
  shSum.getRange('E4:F4').merge().setValue('SỐ LÔ DATE ĐÃ GHI NHẬN').setBackground('#EDE9FE').setFontWeight('bold').setHorizontalAlignment('center');
  shSum.getRange('G4:I4').merge().setValue('TỔNG SỐ KÝ ĐÃ SCAN (Kg)').setBackground('#DCFCE7').setFontWeight('bold').setHorizontalAlignment('center');

  shSum.getRange('A5:B5').merge().setValue(totalScans).setNumberFormat('#,##0').setFontSize(16).setFontWeight('bold').setHorizontalAlignment('center');
  shSum.getRange('C5:D5').merge().setValue(totalProducts).setNumberFormat('#,##0').setFontSize(16).setFontWeight('bold').setHorizontalAlignment('center');
  shSum.getRange('E5:F5').merge().setValue(knownDateLotsCount).setNumberFormat('#,##0').setFontSize(16).setFontWeight('bold').setHorizontalAlignment('center');
  shSum.getRange('G5:I5').merge().setValue(totalKg).setNumberFormat('#,##0.000').setFontSize(16).setFontWeight('bold').setHorizontalAlignment('center');
  shSum.setRowHeight(5, 36);

  let curRow = 7;

  // =========================================================================
  // BẢNG 1: TỔNG HỢP TỒN CHI TIẾT THEO MÃ SKU × THEO DATE (NSX / HSD)
  // =========================================================================
  shSum.getRange(curRow, 1, 1, 9).merge()
    .setValue('I. TỔNG HỢP TỒN CHI TIẾT THEO MÃ SKU × THEO DATE (NSX / HSD)')
    .setBackground('#0F2942')
    .setFontColor('#FFFFFF')
    .setFontSize(11)
    .setFontWeight('bold')
    .setVerticalAlignment('middle');
  shSum.setRowHeight(curRow, 30);
  curRow += 1;

  shSum.getRange(curRow, 1, 1, 9).setValues([[
    'STT',
    'Mã SKU',
    'Tên sản phẩm',
    'NSX',
    'HSD (Date)',
    'Tình trạng hạn dùng',
    'Tổng số tem',
    'Tổng số ký (Kg)',
    'Tỷ trọng KL (%)'
  ]]).setBackground('#1B365D').setFontColor('#FFFFFF').setFontWeight('bold').setHorizontalAlignment('center').setVerticalAlignment('middle');
  shSum.setRowHeight(curRow, 30);
  curRow += 1;

  if (skuDateList.length > 0) {
    const rows1 = [];
    const statusBgs1 = [];
    const statusFgs1 = [];
    for (let i = 0; i < skuDateList.length; i++) {
      const item = skuDateList[i];
      const kg = item.grams / 1000;
      const share = totalGrams > 0 ? (item.grams / totalGrams) : 0;
      const st = evaluateShelfLifeStatus(item.hsd, todayUtc);
      rows1.push([
        i + 1,
        String(item.code),
        String(item.name),
        String(item.nsx),
        String(item.hsd),
        st.text,
        item.count,
        kg,
        share
      ]);
      statusBgs1.push([st.bg]);
      statusFgs1.push([st.fg]);
    }
    shSum.getRange(curRow, 2, rows1.length, 1).setNumberFormat('@');
    shSum.getRange(curRow, 4, rows1.length, 3).setNumberFormat('@');
    shSum.getRange(curRow, 1, rows1.length, 9).setValues(rows1).setVerticalAlignment('middle');
    shSum.getRange(curRow, 1, rows1.length, 2).setHorizontalAlignment('center');
    shSum.getRange(curRow, 4, rows1.length, 4).setHorizontalAlignment('center');
    shSum.getRange(curRow, 6, rows1.length, 1).setBackgrounds(statusBgs1).setFontColors(statusFgs1).setFontWeight('bold');
    shSum.getRange(curRow, 7, rows1.length, 1).setNumberFormat('#,##0');
    shSum.getRange(curRow, 8, rows1.length, 1).setNumberFormat('#,##0.000');
    shSum.getRange(curRow, 9, rows1.length, 1).setNumberFormat('0.0%');
    curRow += rows1.length;

    shSum.getRange(curRow, 1, 1, 9).setValues([[
      '',
      'TỔNG CỘNG',
      skuDateList.length + ' dòng (SKU × Date)',
      '—',
      '—',
      '—',
      totalScans,
      totalKg,
      totalGrams > 0 ? 1 : 0
    ]]).setBackground('#E2E8F0').setFontWeight('bold').setVerticalAlignment('middle');
    shSum.getRange(curRow, 2, 1, 1).setHorizontalAlignment('center');
    shSum.getRange(curRow, 4, 1, 4).setHorizontalAlignment('center');
    shSum.getRange(curRow, 7, 1, 1).setNumberFormat('#,##0');
    shSum.getRange(curRow, 8, 1, 1).setNumberFormat('#,##0.000');
    shSum.getRange(curRow, 9, 1, 1).setNumberFormat('0.0%');
    curRow += 2;
  } else {
    shSum.getRange(curRow, 1, 1, 9).merge().setValue('Chưa có tem nào được quét trong phiên hiện tại.').setHorizontalAlignment('center').setFontColor('#64748B');
    curRow += 2;
  }

  // =========================================================================
  // BẢNG 2: TỔNG HỢP TỒN GỘP THEO MÃ SẢN PHẨM (THEO SKU)
  // =========================================================================
  shSum.getRange(curRow, 1, 1, 9).merge()
    .setValue('II. TỔNG HỢP TỒN GỘP THEO MÃ SẢN PHẨM (THEO SKU)')
    .setBackground('#1E3A8A')
    .setFontColor('#FFFFFF')
    .setFontSize(11)
    .setFontWeight('bold')
    .setVerticalAlignment('middle');
  shSum.setRowHeight(curRow, 30);
  curRow += 1;

  shSum.getRange(curRow, 1, 1, 9).setValues([[
    'STT',
    'Mã SKU',
    'Tên sản phẩm',
    'Số lô Date',
    'Tổng số tem',
    'Tổng số ký (Kg)',
    'Bình quân (Kg/tem)',
    'Tỷ trọng KL (%)',
    'Chi tiết tồn theo từng Date (HSD / NSX)'
  ]]).setBackground('#1B365D').setFontColor('#FFFFFF').setFontWeight('bold').setHorizontalAlignment('center').setVerticalAlignment('middle');
  shSum.setRowHeight(curRow, 30);
  curRow += 1;

  if (skuList.length > 0) {
    const rows2 = [];
    for (let i = 0; i < skuList.length; i++) {
      const p = skuList[i];
      const kg = p.grams / 1000;
      const avgKg = p.count > 0 ? (kg / p.count) : 0;
      const share = totalGrams > 0 ? (p.grams / totalGrams) : 0;
      const dItems = Object.keys(p.dateBreakdown).map(function (k) { return p.dateBreakdown[k]; });
      dItems.sort(function (a, b) {
        if (a.hasDate !== b.hasDate) return a.hasDate ? -1 : 1;
        if (a.hsdUtc !== b.hsdUtc) return a.hsdUtc - b.hsdUtc;
        return a.nsxUtc - b.nsxUtc;
      });
      let knownLotsForSku = 0;
      const detailParts = [];
      for (let dIdx = 0; dIdx < dItems.length; dIdx++) {
        const di = dItems[dIdx];
        const diKg = (di.grams / 1000).toFixed(3);
        if (di.hasDate) {
          knownLotsForSku += 1;
          detailParts.push('HSD ' + di.hsd + ' (NSX ' + di.nsx + '): ' + di.count + ' tem • ' + diKg + ' Kg');
        } else {
          detailParts.push('Chưa rõ date (—): ' + di.count + ' tem • ' + diKg + ' Kg');
        }
      }
      const lotCountDisp = knownLotsForSku > 0
        ? (knownLotsForSku + ' lô date' + (p.missingDateCount > 0 ? ' (+' + p.missingDateCount + ' tem —)' : ''))
        : '—';

      rows2.push([
        i + 1,
        String(p.code),
        String(p.name),
        lotCountDisp,
        p.count,
        kg,
        avgKg,
        share,
        detailParts.join('; ')
      ]);
    }
    shSum.getRange(curRow, 2, rows2.length, 1).setNumberFormat('@');
    shSum.getRange(curRow, 4, rows2.length, 1).setNumberFormat('@');
    shSum.getRange(curRow, 9, rows2.length, 1).setNumberFormat('@').setWrap(true);
    shSum.getRange(curRow, 1, rows2.length, 9).setValues(rows2).setVerticalAlignment('middle');
    shSum.getRange(curRow, 1, rows2.length, 2).setHorizontalAlignment('center');
    shSum.getRange(curRow, 4, rows2.length, 2).setHorizontalAlignment('center');
    shSum.getRange(curRow, 5, rows2.length, 1).setNumberFormat('#,##0');
    shSum.getRange(curRow, 6, rows2.length, 2).setNumberFormat('#,##0.000');
    shSum.getRange(curRow, 8, rows2.length, 1).setNumberFormat('0.0%');
    curRow += rows2.length;

    shSum.getRange(curRow, 1, 1, 9).setValues([[
      '',
      'TỔNG CỘNG',
      totalProducts + ' mã SKU',
      knownDateLotsCount > 0 ? (knownDateLotsCount + ' lô date') : '—',
      totalScans,
      totalKg,
      totalScans > 0 ? (totalKg / totalScans) : 0,
      totalGrams > 0 ? 1 : 0,
      ''
    ]]).setBackground('#E2E8F0').setFontWeight('bold').setVerticalAlignment('middle');
    shSum.getRange(curRow, 2, 1, 1).setHorizontalAlignment('center');
    shSum.getRange(curRow, 4, 1, 2).setHorizontalAlignment('center');
    shSum.getRange(curRow, 5, 1, 1).setNumberFormat('#,##0');
    shSum.getRange(curRow, 6, 1, 2).setNumberFormat('#,##0.000');
    shSum.getRange(curRow, 8, 1, 1).setNumberFormat('0.0%');
    curRow += 2;
  } else {
    shSum.getRange(curRow, 1, 1, 9).merge().setValue('Chưa có dữ liệu tổng hợp theo SKU.').setHorizontalAlignment('center').setFontColor('#64748B');
    curRow += 2;
  }

  // =========================================================================
  // BẢNG 3: TỔNG HỢP TỒN GỘP THEO DATE (HSD / NSX — ƯU TIÊN XUẤT TRƯỚC)
  // =========================================================================
  shSum.getRange(curRow, 1, 1, 9).merge()
    .setValue('III. TỔNG HỢP TỒN GỘP THEO DATE (HSD / NSX — SẮP XẾP HẠN DÙNG SỚM LÊN ĐẦU)')
    .setBackground('#065F46')
    .setFontColor('#FFFFFF')
    .setFontSize(11)
    .setFontWeight('bold')
    .setVerticalAlignment('middle');
  shSum.setRowHeight(curRow, 30);
  curRow += 1;

  shSum.getRange(curRow, 1, 1, 9).setValues([[
    'STT',
    'HSD (Date)',
    'NSX',
    'Tình trạng hạn dùng',
    'Số mã SKU',
    'Tổng số tem',
    'Tổng số ký (Kg)',
    'Tỷ trọng KL (%)',
    'Chi tiết các SKU thuộc Date này'
  ]]).setBackground('#1B365D').setFontColor('#FFFFFF').setFontWeight('bold').setHorizontalAlignment('center').setVerticalAlignment('middle');
  shSum.setRowHeight(curRow, 30);
  curRow += 1;

  if (dateList.length > 0) {
    const rows3 = [];
    const statusBgs3 = [];
    const statusFgs3 = [];
    for (let i = 0; i < dateList.length; i++) {
      const dg = dateList[i];
      const kg = dg.grams / 1000;
      const share = totalGrams > 0 ? (dg.grams / totalGrams) : 0;
      const st = dg.hasDate
        ? evaluateShelfLifeStatus(dg.hsd, todayUtc)
        : { text: '— (Chưa ghi nhận NSX/HSD)', bg: '#F8FAFC', fg: '#64748B' };
      const sItems = Object.keys(dg.skuBreakdown).map(function (k) { return dg.skuBreakdown[k]; });
      sItems.sort(function (a, b) { return b.grams - a.grams; });
      const skuParts = [];
      for (let sIdx = 0; sIdx < sItems.length; sIdx++) {
        const si = sItems[sIdx];
        skuParts.push(si.code + ' - ' + si.name + ' (' + si.count + ' tem • ' + (si.grams / 1000).toFixed(3) + ' Kg)');
      }
      rows3.push([
        i + 1,
        String(dg.hsd),
        String(dg.nsx),
        st.text,
        sItems.length,
        dg.count,
        kg,
        share,
        skuParts.join('; ')
      ]);
      statusBgs3.push([st.bg]);
      statusFgs3.push([st.fg]);
    }
    shSum.getRange(curRow, 2, rows3.length, 3).setNumberFormat('@');
    shSum.getRange(curRow, 9, rows3.length, 1).setNumberFormat('@').setWrap(true);
    shSum.getRange(curRow, 1, rows3.length, 9).setValues(rows3).setVerticalAlignment('middle');
    shSum.getRange(curRow, 1, rows3.length, 6).setHorizontalAlignment('center');
    shSum.getRange(curRow, 2, rows3.length, 1).setFontWeight('bold');
    shSum.getRange(curRow, 4, rows3.length, 1).setBackgrounds(statusBgs3).setFontColors(statusFgs3).setFontWeight('bold');
    shSum.getRange(curRow, 5, rows3.length, 2).setNumberFormat('#,##0');
    shSum.getRange(curRow, 7, rows3.length, 1).setNumberFormat('#,##0.000');
    shSum.getRange(curRow, 8, rows3.length, 1).setNumberFormat('0.0%');
    curRow += rows3.length;

    shSum.getRange(curRow, 1, 1, 9).setValues([[
      '',
      'TỔNG CỘNG',
      '—',
      dateList.length + ' nhóm Date',
      totalProducts,
      totalScans,
      totalKg,
      totalGrams > 0 ? 1 : 0,
      ''
    ]]).setBackground('#E2E8F0').setFontWeight('bold').setVerticalAlignment('middle');
    shSum.getRange(curRow, 2, 1, 5).setHorizontalAlignment('center');
    shSum.getRange(curRow, 5, 1, 2).setNumberFormat('#,##0');
    shSum.getRange(curRow, 7, 1, 1).setNumberFormat('#,##0.000');
    shSum.getRange(curRow, 8, 1, 1).setNumberFormat('0.0%');
    curRow += 2;
  } else {
    shSum.getRange(curRow, 1, 1, 9).merge().setValue('Chưa có dữ liệu tổng hợp theo Date.').setHorizontalAlignment('center').setFontColor('#64748B');
    curRow += 2;
  }

  // =========================================================================
  // BẢNG 4: TỔNG HỢP TỒN GỘP THEO BARCODE KHÁCH HÀNG (TÙY CHỌN — CÓ THỂ BỎ QUA)
  // =========================================================================
  shSum.getRange(curRow, 1, 1, 9).merge()
    .setValue('IV. TỔNG HỢP TỒN GỘP THEO BARCODE KHÁCH HÀNG (TÙY CHỌN — DÒNG BỎ QUA HIỂN THỊ "—")')
    .setBackground('#7C2D12')
    .setFontColor('#FFFFFF')
    .setFontSize(11)
    .setFontWeight('bold')
    .setVerticalAlignment('middle');
  shSum.setRowHeight(curRow, 30);
  curRow += 1;

  shSum.getRange(curRow, 1, 1, 9).setValues([[
    'STT',
    'Barcode khách hàng',
    'Phân loại gán KH',
    'Số mã SKU',
    'Số lô Date',
    'Tổng số tem',
    'Tổng số ký (Kg)',
    'Tỷ trọng KL (%)',
    'Chi tiết các SKU thuộc Khách hàng này'
  ]]).setBackground('#1B365D').setFontColor('#FFFFFF').setFontWeight('bold').setHorizontalAlignment('center').setVerticalAlignment('middle');
  shSum.setRowHeight(curRow, 30);
  curRow += 1;

  if (customerList.length > 0) {
    const rows4 = [];
    for (let i = 0; i < customerList.length; i++) {
      const cg = customerList[i];
      const kg = cg.grams / 1000;
      const share = totalGrams > 0 ? (cg.grams / totalGrams) : 0;
      const sItems = Object.keys(cg.skuBreakdown).map(function (k) { return cg.skuBreakdown[k]; });
      sItems.sort(function (a, b) { return b.grams - a.grams; });
      const skuParts = [];
      for (let sIdx = 0; sIdx < sItems.length; sIdx++) {
        const si = sItems[sIdx];
        skuParts.push(si.code + ' - ' + si.name + ' (' + si.count + ' tem • ' + (si.grams / 1000).toFixed(3) + ' Kg)');
      }
      const dateLotCnt = Object.keys(cg.dateLots).length;
      rows4.push([
        i + 1,
        cg.hasCustomer ? String(cg.customer) : '—',
        cg.hasCustomer ? 'Đã quét mã KH' : '— (Bỏ qua mã KH)',
        sItems.length,
        dateLotCnt > 0 ? (dateLotCnt + ' lô date') : '—',
        cg.count,
        kg,
        share,
        skuParts.join('; ')
      ]);
    }
    shSum.getRange(curRow, 2, rows4.length, 2).setNumberFormat('@');
    shSum.getRange(curRow, 5, rows4.length, 1).setNumberFormat('@');
    shSum.getRange(curRow, 9, rows4.length, 1).setNumberFormat('@').setWrap(true);
    shSum.getRange(curRow, 1, rows4.length, 9).setValues(rows4).setVerticalAlignment('middle');
    shSum.getRange(curRow, 1, rows4.length, 6).setHorizontalAlignment('center');
    shSum.getRange(curRow, 2, rows4.length, 1).setFontWeight('bold');
    shSum.getRange(curRow, 4, rows4.length, 1).setNumberFormat('#,##0');
    shSum.getRange(curRow, 6, rows4.length, 1).setNumberFormat('#,##0');
    shSum.getRange(curRow, 7, rows4.length, 1).setNumberFormat('#,##0.000');
    shSum.getRange(curRow, 8, rows4.length, 1).setNumberFormat('0.0%');
    curRow += rows4.length;

    shSum.getRange(curRow, 1, 1, 9).setValues([[
      '',
      'TỔNG CỘNG',
      knownCustomerCount > 0 ? (knownCustomerCount + ' mã khách hàng') : '— (Chưa gán KH)',
      totalProducts,
      knownDateLotsCount > 0 ? (knownDateLotsCount + ' lô date') : '—',
      totalScans,
      totalKg,
      totalGrams > 0 ? 1 : 0,
      ''
    ]]).setBackground('#E2E8F0').setFontWeight('bold').setVerticalAlignment('middle');
    shSum.getRange(curRow, 2, 1, 5).setHorizontalAlignment('center');
    shSum.getRange(curRow, 4, 1, 1).setNumberFormat('#,##0');
    shSum.getRange(curRow, 6, 1, 1).setNumberFormat('#,##0');
    shSum.getRange(curRow, 7, 1, 1).setNumberFormat('#,##0.000');
    shSum.getRange(curRow, 8, 1, 1).setNumberFormat('0.0%');
  } else {
    shSum.getRange(curRow, 1, 1, 9).merge().setValue('Chưa có dữ liệu tổng hợp theo Khách hàng.').setHorizontalAlignment('center').setFontColor('#64748B');
  }

  const sumWidths = [55, 145, 235, 165, 125, 165, 150, 135, 360];
  for (let c = 0; c < sumWidths.length; c++) {
    shSum.setColumnWidth(c + 1, sumWidths[c]);
  }

  return {
    totalScans: totalScans,
    totalProducts: totalProducts,
    totalDateLots: knownDateLotsCount,
    totalCustomers: knownCustomerCount,
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
  if (lastRow > 1) sh.getRange(2, 1, lastRow - 1, 4).clearContent();
  if (!catalog || catalog.length === 0) return;
  const rows = catalog.map(function (c) {
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
/* END_OF_CODE_GS_V11 */
