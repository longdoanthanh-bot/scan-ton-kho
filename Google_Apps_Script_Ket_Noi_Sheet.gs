/**
 * ============================================================================
 * BỘ KẾT NỐI TỰ ĐỘNG 2 CHIỀU APP QUÉT TỒN KHO <-> GOOGLE SHEET (v9)
 * Hỗ trợ tự động đọc NSX & HSD + Đồng bộ tức thì khi xóa/sửa dòng trực tiếp trên Sheet
 * ============================================================================
 * - Google Sheet gắn cố định: https://docs.google.com/spreadsheets/d/1jmwE8LBV4XroBIKVohHFDXwWjEhDwSHZnUb-ziLrDgk/edit?gid=0#gid=0
 * - Đường truyền Web App (/exec): https://script.google.com/macros/s/AKfycbxlF9UorbWyYzxFA4avEIkloBab44VZzqznaxTXSSTAZtb13QRp5GQoHb_KGCAnAayg/exec
 * ============================================================================
 */

const TARGET_SPREADSHEET_ID = '1jmwE8LBV4XroBIKVohHFDXwWjEhDwSHZnUb-ziLrDgk';
const SHEET_CHI_TIET = 'Chi_Tiet_Scan';
const SHEET_TONG_HOP = 'Tong_Hop_Ton';
const SHEET_DANH_MUC = 'Danh_Muc_SP';
const APP_ONLINE_URL = 'https://longdoanthanh-bot.github.io/scan-ton-kho/';

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

function sheetNeedsSelfHeal(ss, parsedRecords) {
  try {
    const shDetail = ss.getSheetByName(SHEET_CHI_TIET);
    const shSum = ss.getSheetByName(SHEET_TONG_HOP);
    if (!shDetail || !shSum) return false;

    const physicalRows = Math.max(0, shDetail.getLastRow() - 1);
    if (physicalRows !== parsedRecords.length) {
      return true;
    }
    if (parsedRecords.length > 0) {
      const lastSeq = Number(shDetail.getRange(parsedRecords.length + 1, 7).getValue());
      if (lastSeq !== parsedRecords.length) {
        return true;
      }
    }
    const sumCountVal = shSum.getRange('A5').getValue();
    if (sumCountVal === '' || Number(sumCountVal) !== parsedRecords.length) {
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
        version: 'v9_live_sync',
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
        version: 'v9_live_sync',
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
        version: 'v9_live_sync',
        message: 'Kết nối 2 chiều Google Sheet Quét Tồn Kho (NSX & HSD) đang hoạt động tốt!',
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
      '<p style="font-size:14px;color:#475569">Đã kết nối trực tiếp bảng tính <strong>' + ss.getName() + '</strong> (Hỗ trợ tự động lưu Mã SP, Số Ký, NSX, HSD & đồng bộ ngược khi xóa/sửa dòng trên Sheet).</p>',
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
        version: 'v9_live_sync',
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
        version: 'v9_live_sync',
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
        version: 'v9_live_sync',
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
    'Tên sản phẩm',
    'Mã sản phẩm',
    'Số ký tem vừa scan',
    'NSX',
    'HSD',
    'Tổng số tem đã scan',
    'Tổng số sản phẩm đã scan',
    'Tổng số ký đã scan',
    'Mã vạch gốc / Ghi chú',
    'Mã dòng đồng bộ'
  ]];
  shDetail.getRange(1, 1, 1, 11).setValues(headers)
    .setBackground('#1B365D')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');
  shDetail.setFrozenRows(1);
  shDetail.setRowHeight(1, 36);
  const widths = [160, 235, 110, 145, 115, 115, 150, 175, 150, 205, 150];
  for (let c = 0; c < widths.length; c++) {
    shDetail.setColumnWidth(c + 1, widths[c]);
  }
}

function ensureSheetsExist(ss) {
  let shDetail = ss.getSheetByName(SHEET_CHI_TIET);
  if (!shDetail) {
    const sheets = ss.getSheets();
    if (sheets.length > 0 && sheets[0].getLastRow() <= 1) {
      shDetail = sheets[0];
      shDetail.setName(SHEET_CHI_TIET);
    } else {
      shDetail = ss.insertSheet(SHEET_CHI_TIET, 0);
    }
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
    const col5Title = String(shDetail.getRange(1, 5).getDisplayValue() || '').trim();
    if (col5Title !== 'NSX') {
      const legacyRecords = readLegacy9ColRecords(shDetail);
      formatDetailHeader(shDetail);
      writeAllScanRecords(ss, legacyRecords);
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

function cleanDateField(v) {
  const s = String(v || '').trim();
  if (!s || s === '—' || s === '-' || s === 'null' || s === 'undefined') return '';
  return s;
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
      const incomingNsx = (r.nsx !== undefined) ? cleanDateField(r.nsx) : (prev ? prev.nsx : '');
      const incomingHsd = (r.hsd !== undefined) ? cleanDateField(r.hsd) : (prev ? prev.hsd : '');
      const cleanRec = {
        id: String(r.id),
        scannedAt: String(r.scannedAt || (prev ? prev.scannedAt : '')),
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

  const col5Title = String(sh.getRange(1, 5).getDisplayValue() || '').trim();
  if (col5Title !== 'NSX') {
    return readLegacy9ColRecords(sh);
  }

  const values = sh.getRange(2, 1, lastRow - 1, 11).getDisplayValues();
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    const code = String(row[2] || '').trim();
    const rawKg = String(row[3] || '').replace(/,/g, '').trim();
    const grams = Math.round(parseFloat(rawKg || '0') * 1000);
    // Nếu người dùng xóa dòng hoặc bôi đen bấm Delete xóa Mã SP / Số ký trên Sheet -> ghi nhận dòng đó đã bị xóa!
    if ((!code && !String(row[0] || '').trim()) || isNaN(grams) || grams <= 0) {
      continue;
    }
    const parts = String(row[9] || '').split(' | ');
    out.push({
      id: String(row[10] || '').trim() || ('sheet_row_' + (i + 2) + '_' + code + '_' + grams),
      scannedAt: String(row[0] || '').trim(),
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

function writeAllScanRecords(ss, records) {
  const sh = ss.getSheetByName(SHEET_CHI_TIET);
  const lastRow = sh.getLastRow();
  const maxCol = Math.max(11, sh.getLastColumn());
  if (lastRow > 1) {
    sh.getRange(2, 1, lastRow - 1, maxCol).clearContent();
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
    const nsxDisp = cleanDateField(r.nsx) || '—';
    const hsdDisp = cleanDateField(r.hsd) || '—';
    runningGrams += grams;

    if (code && !seenCodes[code]) {
      seenCodes[code] = true;
      distinctCount += 1;
    }

    const bcAndNote = [String(r.rawBarcode || '').trim(), String(r.note || '').trim()]
      .filter(function (x) { return x !== ''; })
      .join(' | ');

    rows.push([
      String(r.scannedAt || ''),
      name,
      code,
      grams / 1000,
      nsxDisp,
      hsdDisp,
      i + 1,
      distinctCount,
      runningGrams / 1000,
      bcAndNote,
      String(r.id || ('scan_' + (i + 1)))
    ]);
  }

  sh.getRange(2, 1, rows.length, 1).setNumberFormat('@');
  sh.getRange(2, 3, rows.length, 1).setNumberFormat('@');
  sh.getRange(2, 5, rows.length, 2).setNumberFormat('@');
  sh.getRange(2, 10, rows.length, 2).setNumberFormat('@');

  sh.getRange(2, 1, rows.length, 11).setValues(rows);

  sh.getRange(2, 4, rows.length, 1).setNumberFormat('#,##0.000');
  sh.getRange(2, 7, rows.length, 2).setNumberFormat('#,##0');
  sh.getRange(2, 9, rows.length, 1).setNumberFormat('#,##0.000');
  sh.getRange(2, 3, rows.length, 1).setHorizontalAlignment('center');
  sh.getRange(2, 5, rows.length, 4).setHorizontalAlignment('center');
}

function rebuildTotalsAndSummaryInternal(ss) {
  const records = readAllScanRecords(ss);
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
        grams: 0,
        lots: {}
      };
    }
    if (byProduct[key].name === '—' && r.productName && r.productName !== '—') {
      byProduct[key].name = r.productName;
    }
    byProduct[key].count += 1;
    byProduct[key].grams += r.grams;
    if (r.nsx || r.hsd) {
      const lotLabel = (r.nsx || '—') + ' → ' + (r.hsd || '—');
      byProduct[key].lots[lotLabel] = true;
    }
    totalGrams += r.grams;
  }

  const productList = Object.keys(byProduct).map(function (k) { return byProduct[k]; });
  productList.sort(function (a, b) { return b.grams - a.grams; });

  const totalScans = records.length;
  const totalProducts = productList.length;
  const totalKg = totalGrams / 1000;

  const shSum = ss.getSheetByName(SHEET_TONG_HOP);
  shSum.clear();

  shSum.getRange('A1:H1').merge()
    .setValue('BÁO CÁO TỔNG HỢP KIỂM TỒN KHO QUÉT TEM MÃ VẠCH')
    .setBackground('#1B365D')
    .setFontColor('#FFFFFF')
    .setFontSize(13)
    .setFontWeight('bold')
    .setHorizontalAlignment('center');
  shSum.setRowHeight(1, 38);

  shSum.getRange('A2:H2').merge()
    .setValue('Cập nhật mới nhất: ' + formatDateTimeVN(new Date()))
    .setBackground('#EEF2F6')
    .setFontColor('#334155')
    .setHorizontalAlignment('center');

  shSum.getRange('A4:B4').merge().setValue('TỔNG SỐ TEM ĐÃ SCAN').setBackground('#E0F2FE').setFontWeight('bold').setHorizontalAlignment('center');
  shSum.getRange('C4:E4').merge().setValue('TỔNG SỐ SẢN PHẨM ĐÃ SCAN').setBackground('#FEF3C7').setFontWeight('bold').setHorizontalAlignment('center');
  shSum.getRange('F4:H4').merge().setValue('TỔNG SỐ KÝ ĐÃ SCAN (Kg)').setBackground('#DCFCE7').setFontWeight('bold').setHorizontalAlignment('center');

  shSum.getRange('A5:B5').merge().setValue(totalScans).setNumberFormat('#,##0').setFontSize(16).setFontWeight('bold').setHorizontalAlignment('center');
  shSum.getRange('C5:E5').merge().setValue(totalProducts).setNumberFormat('#,##0').setFontSize(16).setFontWeight('bold').setHorizontalAlignment('center');
  shSum.getRange('F5:H5').merge().setValue(totalKg).setNumberFormat('#,##0.000').setFontSize(16).setFontWeight('bold').setHorizontalAlignment('center');
  shSum.setRowHeight(5, 36);

  const sumHeaders = [[
    'STT',
    'Mã sản phẩm',
    'Tên sản phẩm',
    'Tổng số tem đã scan',
    'Tổng số ký đã scan (Kg)',
    'Bình quân (Kg/tem)',
    'Tỷ trọng khối lượng (%)',
    'Lô NSX → HSD'
  ]];
  shSum.getRange(7, 1, 1, 8).setValues(sumHeaders)
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
      const lotKeys = Object.keys(p.lots);
      sumRows.push([
        i + 1,
        String(p.code),
        String(p.name),
        p.count,
        kg,
        avgKg,
        share,
        lotKeys.length > 0 ? lotKeys.join('; ') : '—'
      ]);
    }
    shSum.getRange(8, 2, sumRows.length, 1).setNumberFormat('@');
    shSum.getRange(8, 8, sumRows.length, 1).setNumberFormat('@');
    shSum.getRange(8, 1, sumRows.length, 8).setValues(sumRows);
    shSum.getRange(8, 1, sumRows.length, 2).setHorizontalAlignment('center');
    shSum.getRange(8, 4, sumRows.length, 1).setNumberFormat('#,##0').setHorizontalAlignment('center');
    shSum.getRange(8, 5, sumRows.length, 2).setNumberFormat('#,##0.000');
    shSum.getRange(8, 7, sumRows.length, 1).setNumberFormat('0.0%');

    const totalRowIdx = 8 + sumRows.length;
    shSum.getRange(totalRowIdx, 1, 1, 8).setValues([[
      '',
      'TỔNG CỘNG',
      totalProducts + ' mã sản phẩm',
      totalScans,
      totalKg,
      totalScans > 0 ? (totalKg / totalScans) : 0,
      totalGrams > 0 ? 1 : 0,
      ''
    ]]).setBackground('#E2E8F0').setFontWeight('bold');
    shSum.getRange(totalRowIdx, 4, 1, 1).setNumberFormat('#,##0').setHorizontalAlignment('center');
    shSum.getRange(totalRowIdx, 5, 1, 2).setNumberFormat('#,##0.000');
    shSum.getRange(totalRowIdx, 7, 1, 1).setNumberFormat('0.0%');
  }

  const sumWidths = [55, 115, 250, 145, 165, 145, 155, 220];
  for (let c = 0; c < sumWidths.length; c++) {
    shSum.setColumnWidth(c + 1, sumWidths[c]);
  }

  return { totalScans: totalScans, totalProducts: totalProducts, totalKg: totalKg };
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
/* END_OF_CODE_GS_V9 */
