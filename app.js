(function () {
  'use strict';

  const STORAGE_RECORDS = 'scan_ton_records_v1';
  const STORAGE_CUSTOM_CATALOG = 'scan_ton_custom_catalog_v1';
  const STORAGE_PENDING_OPS = 'scan_ton_pending_ops_v1';
  const STORAGE_SETTINGS = 'scan_ton_settings_v1';

  const VALID_SCALE_PREFIXES = ['10', '11', '20', '21', '22', '23', '24', '25', '26', '27', '28', '29'];

  // Chỉ cho phép các chuẩn mã vạch sọc 1D — Khóa cứng 100% không đọc QR Code
  const WASM_1D_OPTIONS = {
    formats: ['EAN-13', 'Code128', 'EAN-8', 'ITF', 'UPC-A'],
    tryHarder: true,
    tryRotate: true,
    tryInvert: true,
    tryDownscale: true,
    downscaleFactor: 2,
    downscaleThreshold: 950,
    binarizer: 'LocalAverage',
    maxNumberOfSymbols: 2
  };

  // State
  let records = [];
  let catalogMap = {};
  let pendingOps = [];
  let settings = {
    sheetWebAppUrl: '',
    sheetViewUrl: '',
    soundEnabled: true,
    duplicateAskSec: 4,
    scalePrefixOnly: true
  };

  let currentMode = 'pda';
  let syncInProgress = false;
  let lastScannedCode = '';
  let lastScannedEpoch = 0;
  let pendingDuplicateCode = null;

  // Camera & WASM state (Chế độ Bấm Nút Chụp Mới Quét 1 Tem — Chống quét dư 100%)
  let wasmReadyPromise = null;
  let mediaStream = null;
  let cameraActive = false;
  let torchEnabled = false;
  let currentZoom = 1.5;
  let hardwareZoomSupported = false;
  let nativeDetector = null;
  let singleScanActive = false;
  let singleScanToken = 0;
  let shutterLockUntil = 0;

  // Global PDA hardware laser keystroke buffer
  let wedgeBuffer = '';
  let wedgeLastKeyTime = 0;
  let pdaBurstStartMs = 0;
  let pdaBurstTimer = null;
  let deferredInstallPrompt = null;

  // Audio context & IndexedDB offline vault
  let audioCtx = null;
  let idbPromise = null;

  function openOfflineVault() {
    if (idbPromise) return idbPromise;
    if (!('indexedDB' in window)) {
      idbPromise = Promise.resolve(null);
      return idbPromise;
    }
    idbPromise = new Promise(function (resolve) {
      try {
        const req = window.indexedDB.open('ScanTonKhoOfflineDB', 1);
        req.onupgradeneeded = function (e) {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('kv')) {
            db.createObjectStore('kv');
          }
        };
        req.onsuccess = function (e) { resolve(e.target.result); };
        req.onerror = function () { resolve(null); };
      } catch (err) {
        resolve(null);
      }
    });
    return idbPromise;
  }

  function idbSave(key, value) {
    openOfflineVault().then(function (db) {
      if (!db) return;
      try {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(value, key);
      } catch (e) {}
    });
  }

  function idbLoad(key) {
    return openOfflineVault().then(function (db) {
      if (!db) return null;
      return new Promise(function (resolve) {
        try {
          const tx = db.transaction('kv', 'readonly');
          const req = tx.objectStore('kv').get(key);
          req.onsuccess = function () { resolve(req.result !== undefined ? req.result : null); };
          req.onerror = function () { resolve(null); };
        } catch (e) {
          resolve(null);
        }
      });
    });
  }

  document.addEventListener('DOMContentLoaded', initApp);

  function warmUpWasmEngine() {
    if (wasmReadyPromise) return wasmReadyPromise;
    if (window.ZXingWASM && window.ZXingWASM.prepareZXingModule) {
      wasmReadyPromise = window.ZXingWASM.prepareZXingModule({
        overrides: {
          locateFile: function (path) {
            if (path.indexOf('.wasm') !== -1) {
              return './vendor/zxing_reader.wasm';
            }
            return path;
          }
        },
        fireImmediately: true
      }).catch(function () { return null; });
    } else {
      wasmReadyPromise = Promise.resolve(null);
    }
    return wasmReadyPromise;
  }

  async function initApp() {
    warmUpWasmEngine();
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(function () {});
    }

    loadSettings();
    checkUrlParamsForSheet();
    loadCatalog();
    await loadRecordsAndOpsWithVaultRecovery();

    bindEvents();
    updateOfflineBannerUI();

    if (window.location.hash === '#camera') {
      applyModeUI('camera');
    } else {
      applyModeUI('pda');
    }

    renderAll();

    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      navigator.serviceWorker.register('./sw.js?v=5').catch(function () {});
    }

    window.addEventListener('online', function () {
      updateOfflineBannerUI();
      if (pendingOps.length > 0 && settings.sheetWebAppUrl) {
        flushSyncQueue(true);
      } else {
        updateSyncBadge();
      }
    });

    window.addEventListener('offline', function () {
      updateOfflineBannerUI();
      updateSyncBadge();
    });

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && navigator.onLine && pendingOps.length > 0 && settings.sheetWebAppUrl) {
        flushSyncQueue(true);
      }
    });

    // Tự động kiểm tra và đẩy dữ liệu tồn đọng mỗi 12 giây ngay khi có sóng mạng trở lại
    setInterval(function () {
      if (navigator.onLine && pendingOps.length > 0 && settings.sheetWebAppUrl && !syncInProgress) {
        flushSyncQueue(true);
      }
    }, 12000);

    if (pendingOps.length > 0 && settings.sheetWebAppUrl && navigator.onLine) {
      flushSyncQueue(false);
    } else {
      updateSyncBadge();
    }
  }

  function updateOfflineBannerUI() {
    const bar = document.getElementById('offlineStatusBar');
    const txt = document.getElementById('offlineStatusBarText');
    if (!bar) return;
    if (!navigator.onLine) {
      bar.style.display = 'block';
      if (txt) {
        txt.textContent =
          'Đang không có mạng (Offline) — Bạn cứ quét bình thường! Đã lưu an toàn trên máy (' +
          records.length + ' tem' + (pendingOps.length > 0 ? ', chờ tự đẩy ' + pendingOps.length + ' mục khi có mạng' : '') + ').';
      }
    } else {
      bar.style.display = 'none';
    }
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_SETTINGS);
      if (raw) {
        const parsed = JSON.parse(raw);
        settings = Object.assign(settings, parsed);
      }
    } catch (e) {}
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORAGE_SETTINGS, JSON.stringify(settings));
    } catch (e) {}
    idbSave(STORAGE_SETTINGS, settings);
  }

  function checkUrlParamsForSheet() {
    try {
      const params = new URLSearchParams(window.location.search);
      const sheetParam = params.get('sheet');
      if (
        sheetParam &&
        (sheetParam.indexOf('https://script.google.com/') === 0 ||
         sheetParam.indexOf('http://127.0.0.1:') === 0 ||
         sheetParam.indexOf('http://localhost:') === 0)
      ) {
        settings.sheetWebAppUrl = sheetParam.trim();
        saveSettings();
        showBanner('ok', '✅ Đã tự động kết nối Google Sheet từ đường link dùng chung!');
      }
    } catch (e) {}
  }

  function loadCatalog() {
    catalogMap = {};
    const defaults = Array.isArray(window.DEFAULT_PRODUCT_CATALOG) ? window.DEFAULT_PRODUCT_CATALOG : [];
    for (let i = 0; i < defaults.length; i++) {
      const item = defaults[i];
      if (item && item.code) {
        catalogMap[String(item.code).trim()] = {
          code: String(item.code).trim(),
          name: String(item.name || '').trim(),
          fullName: String(item.fullName || item.name || '').trim(),
          inventoryId: String(item.inventoryId || '').trim()
        };
      }
    }
    try {
      const customRaw = localStorage.getItem(STORAGE_CUSTOM_CATALOG);
      if (customRaw) {
        const customList = JSON.parse(customRaw);
        if (Array.isArray(customList)) {
          for (let i = 0; i < customList.length; i++) {
            const c = customList[i];
            if (c && c.code && c.name) {
              const code = String(c.code).trim();
              catalogMap[code] = {
                code: code,
                name: String(c.name).trim(),
                fullName: String(c.fullName || c.name).trim(),
                inventoryId: String(c.inventoryId || '').trim()
              };
            }
          }
        }
      }
    } catch (e) {}
  }

  function saveCustomProductToCatalog(code, name) {
    const cleanCode = String(code || '').trim();
    const cleanName = String(name || '').trim();
    if (!cleanCode || !cleanName) return;

    const prev = catalogMap[cleanCode];
    catalogMap[cleanCode] = {
      code: cleanCode,
      name: cleanName,
      fullName: prev ? prev.fullName : cleanName,
      inventoryId: prev ? prev.inventoryId : ''
    };

    try {
      const customRaw = localStorage.getItem(STORAGE_CUSTOM_CATALOG);
      const list = customRaw ? JSON.parse(customRaw) : [];
      const filtered = list.filter(function (x) { return String(x.code) !== cleanCode; });
      filtered.push(catalogMap[cleanCode]);
      localStorage.setItem(STORAGE_CUSTOM_CATALOG, JSON.stringify(filtered));
    } catch (e) {}

    let updatedAny = false;
    for (let i = 0; i < records.length; i++) {
      if (records[i].productCode === cleanCode && (!records[i].productName || records[i].productName === '—')) {
        records[i].productName = cleanName;
        enqueueOp({ type: 'update', record: toSyncRecord(records[i]) });
        updatedAny = true;
      }
    }
    if (updatedAny) {
      persistRecords();
      renderAll();
      flushSyncQueue();
    } else {
      renderCatalogTab();
    }
  }

  function getProductNameOrNull(code) {
    const entry = catalogMap[String(code || '').trim()];
    if (entry && entry.name && entry.name.trim() !== '') {
      return entry.name.trim();
    }
    return null;
  }

  async function loadRecordsAndOpsWithVaultRecovery() {
    let hasLocalRecords = false;
    try {
      const r = localStorage.getItem(STORAGE_RECORDS);
      if (r !== null) {
        records = JSON.parse(r) || [];
        hasLocalRecords = true;
      }
    } catch (e) {
      records = [];
    }
    try {
      const p = localStorage.getItem(STORAGE_PENDING_OPS);
      if (p !== null) {
        pendingOps = JSON.parse(p) || [];
      }
    } catch (e) {
      pendingOps = [];
    }

    // Tự phục hồi từ kho IndexedDB nếu bộ nhớ trình duyệt bị dọn tạm
    if (!hasLocalRecords) {
      const vaultRecords = await idbLoad(STORAGE_RECORDS);
      if (Array.isArray(vaultRecords) && vaultRecords.length > 0) {
        records = vaultRecords;
      }
      const vaultOps = await idbLoad(STORAGE_PENDING_OPS);
      if (Array.isArray(vaultOps) && vaultOps.length > 0) {
        pendingOps = vaultOps;
      }
      const vaultSettings = await idbLoad(STORAGE_SETTINGS);
      if (vaultSettings && !settings.sheetWebAppUrl && vaultSettings.sheetWebAppUrl) {
        settings = Object.assign(settings, vaultSettings);
      }
    }
  }

  function persistRecords() {
    try {
      localStorage.setItem(STORAGE_RECORDS, JSON.stringify(records));
    } catch (e) {}
    idbSave(STORAGE_RECORDS, records);
    updateOfflineBannerUI();
    sendLocalServerBackup();
  }

  function persistPendingOps() {
    try {
      localStorage.setItem(STORAGE_PENDING_OPS, JSON.stringify(pendingOps));
    } catch (e) {}
    idbSave(STORAGE_PENDING_OPS, pendingOps);
    updateOfflineBannerUI();
    updateSyncBadge();
  }

  function enqueueOp(op) {
    pendingOps.push(op);
    persistPendingOps();
  }

  // =========================================================================
  // BARCODE PARSING & KCS VALIDATION
  // =========================================================================
  function calcEan13CheckDigit(first12) {
    let sum = 0;
    for (let i = 0; i < 12; i++) {
      const digit = first12.charCodeAt(i) - 48;
      sum += (i % 2 === 0) ? digit : (digit * 3);
    }
    return (10 - (sum % 10)) % 10;
  }

  function parseSingle13DigitScaleBarcode(bc) {
    if (!/^\d{13}$/.test(bc)) {
      return { ok: false, error: 'Mã vạch "' + bc + '" không đúng chuẩn 13 chữ số (nhận được ' + bc.length + ' ký tự).' };
    }

    const expectedCheck = calcEan13CheckDigit(bc.slice(0, 12));
    const actualCheck = parseInt(bc.charAt(12), 10);
    if (expectedCheck !== actualCheck) {
      return {
        ok: false,
        error: 'Mã vạch "' + bc + '" sai số kiểm tra cuối (kỳ vọng số cuối là ' + expectedCheck + ').'
      };
    }

    const prefix = bc.slice(0, 2);
    if (settings.scalePrefixOnly && VALID_SCALE_PREFIXES.indexOf(prefix) === -1) {
      return {
        ok: false,
        error: 'Mã "' + bc + '" (đầu ' + prefix + ') là mã hàng đóng gói cố định, không phải tem cân ký (đầu 10, 11, 20-29).'
      };
    }

    const productCode = bc.slice(2, 7);
    const grams = parseInt(bc.slice(7, 12), 10);

    if (!grams || grams <= 0) {
      return {
        ok: false,
        error: 'Mã "' + bc + '" có khối lượng bằng 0 Kg — không hợp lệ!'
      };
    }

    const productName = getProductNameOrNull(productCode);

    return {
      ok: true,
      rawBarcode: bc,
      productCode: productCode,
      productName: productName,
      grams: grams,
      weightKg: grams / 1000
    };
  }

  function handleBarcodeInput(rawInput, sourceLabel) {
    const cleaned = String(rawInput || '').replace(/[\r\n\t\s]+/g, '').trim();
    if (!cleaned) return;

    if (cleaned.length >= 26 && cleaned.length % 13 === 0 && /^\d+$/.test(cleaned)) {
      const count = cleaned.length / 13;
      for (let i = 0; i < count; i++) {
        processSingleBarcode(cleaned.slice(i * 13, (i + 1) * 13), sourceLabel, true);
      }
      return;
    }

    processSingleBarcode(cleaned, sourceLabel, false);
  }

  function processSingleBarcode(bc, sourceLabel, bypassDupGuard) {
    const parsed = parseSingle13DigitScaleBarcode(bc);
    if (!parsed.ok) {
      playBeep('error');
      vibrateDevice([120, 60, 120]);
      showBanner('error', parsed.error);
      return;
    }

    const nowMs = Date.now();
    if (
      !bypassDupGuard &&
      settings.duplicateAskSec > 0 &&
      bc === lastScannedCode &&
      (nowMs - lastScannedEpoch) < settings.duplicateAskSec * 1000
    ) {
      playBeep('warn');
      vibrateDevice([90, 50, 90]);
      pendingDuplicateCode = bc;
      document.getElementById('dupModalBarcode').textContent = bc;
      document.getElementById('dupModalInfo').textContent =
        (parsed.productName || 'Chưa có tên') + ' (' + parsed.productCode + ') — ' + formatKg(parsed.grams) + ' Kg';
      openModal('duplicateModal');
      return;
    }

    commitParsedScan(parsed);
  }

  function commitParsedScan(parsed) {
    const now = new Date();
    const record = {
      id: 'scan_' + now.getTime() + '_' + Math.random().toString(36).slice(2, 7),
      scannedAt: formatDateTimeVN(now),
      productCode: parsed.productCode,
      productName: parsed.productName,
      grams: parsed.grams,
      rawBarcode: parsed.rawBarcode,
      note: '',
      edited: false
    };

    records.push(record);
    lastScannedCode = parsed.rawBarcode;
    lastScannedEpoch = Date.now();

    const kcs = verifyKcsIntegrity();
    if (!kcs.ok) {
      showBanner('error', 'CẢNH BÁO KCS: ' + kcs.error);
      return;
    }

    persistRecords();
    enqueueOp({ type: 'add', record: toSyncRecord(record) });

    if (parsed.productName === null) {
      playBeep('warn');
      vibrateDevice([80, 40, 80]);
      showBanner('warn', 'Đã ghi nhận mã ' + parsed.productCode + ' (' + formatKg(parsed.grams) + ' Kg) nhưng chưa có Tên SP. Bấm "Sửa ngay" để đặt tên!');
    } else {
      playBeep('ok');
      vibrateDevice([55]);
      showBanner('ok', '✅ Đã quét: ' + parsed.productName + ' (' + parsed.productCode + ') — ' + formatKg(parsed.grams) + ' Kg');
    }

    renderAll(true);
    flushSyncQueue();
  }

  function toSyncRecord(r) {
    return {
      id: r.id,
      scannedAt: r.scannedAt,
      productCode: r.productCode,
      productName: r.productName ? r.productName : '—',
      grams: r.grams,
      weightKg: r.grams / 1000,
      rawBarcode: r.rawBarcode || '',
      note: r.note || ''
    };
  }

  // =========================================================================
  // CẦU DAO TỰ NGẮT KCS
  // =========================================================================
  function computeMetrics() {
    let totalGrams = 0;
    const byCode = {};

    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      const g = Math.round(Number(r.grams));
      totalGrams += g;

      const code = String(r.productCode || '').trim() || 'CHUA_RO';
      if (!byCode[code]) {
        byCode[code] = {
          code: code,
          name: r.productName ? r.productName : null,
          count: 0,
          grams: 0
        };
      }
      if (!byCode[code].name && r.productName) {
        byCode[code].name = r.productName;
      }
      byCode[code].count += 1;
      byCode[code].grams += g;
    }

    const productGroups = Object.keys(byCode).map(function (k) { return byCode[k]; });
    productGroups.sort(function (a, b) { return b.grams - a.grams; });

    return {
      totalScans: records.length,
      totalProducts: productGroups.length,
      totalGrams: totalGrams,
      productGroups: productGroups
    };
  }

  function verifyKcsIntegrity() {
    const m = computeMetrics();
    let sumGroupCount = 0;
    let sumGroupGrams = 0;
    for (let i = 0; i < m.productGroups.length; i++) {
      sumGroupCount += m.productGroups[i].count;
      sumGroupGrams += m.productGroups[i].grams;
      if (!Number.isInteger(m.productGroups[i].grams) || m.productGroups[i].grams <= 0) {
        return { ok: false, error: 'Phát hiện số ký không hợp lệ ở mã ' + m.productGroups[i].code };
      }
    }
    if (sumGroupCount !== m.totalScans) {
      return { ok: false, error: 'Lệch tổng số tem đối chiếu (' + sumGroupCount + ' != ' + m.totalScans + ')' };
    }
    if (sumGroupGrams !== m.totalGrams) {
      return { ok: false, error: 'Lệch tổng số ký đối chiếu (' + sumGroupGrams + ' != ' + m.totalGrams + ')' };
    }
    return { ok: true, metrics: m };
  }

  // =========================================================================
  // RENDERING UI
  // =========================================================================
  function renderAll(flashLatest) {
    const kcs = verifyKcsIntegrity();
    const m = kcs.metrics || computeMetrics();

    document.getElementById('kpiTotalScans').textContent = formatInt(m.totalScans);
    document.getElementById('kpiTotalProducts').textContent = formatInt(m.totalProducts);
    document.getElementById('kpiTotalKg').textContent = formatKg(m.totalGrams);
    document.getElementById('navBadgeList').textContent = m.totalScans > 0 ? ' (' + m.totalScans + ')' : '';

    renderLatestCard(flashLatest, m);
    renderScanLists();
    renderSummaryTab(m);
    renderCatalogTab();
    updateSyncBadge();
  }

  function renderLatestCard(flash, metricsObj) {
    const m = metricsObj || computeMetrics();
    const card = document.getElementById('latestScanCard');
    const emptyState = document.getElementById('latestEmptyState');
    const contentState = document.getElementById('latestContentState');
    const liveHud = document.getElementById('cameraLiveHud');

    if (records.length === 0) {
      emptyState.style.display = 'block';
      contentState.style.display = 'none';
      card.classList.remove('flash-ok', 'flash-warn');
      if (liveHud) liveHud.classList.remove('show');
      return;
    }

    emptyState.style.display = 'none';
    contentState.style.display = 'block';

    const latest = records[records.length - 1];
    document.getElementById('latestTime').textContent = latest.scannedAt;

    const nameEl = document.getElementById('latestName');
    if (latest.productName) {
      nameEl.textContent = latest.productName;
      nameEl.classList.remove('missing-name');
    } else {
      nameEl.textContent = '— (Chưa có tên mã ' + latest.productCode + ')';
      nameEl.classList.add('missing-name');
    }

    document.getElementById('latestCode').textContent = latest.productCode || '—';
    document.getElementById('latestWeight').textContent = formatKg(latest.grams) + ' Kg';
    document.getElementById('latestBarcode').textContent =
      'Mã vạch: ' + (latest.rawBarcode || 'Nhập thủ công') + (latest.note ? ' • ' + latest.note : '');

    document.getElementById('btnEditLatest').onclick = function () {
      openEditModal(latest.id);
    };
    document.getElementById('btnDeleteLatest').onclick = function () {
      confirmDeleteRecord(latest.id);
    };

    if (liveHud) {
      document.getElementById('hudTopMeta').textContent =
        '✅ Đã quét • Tổng: ' + formatInt(m.totalScans) + ' tem | ' + formatInt(m.totalProducts) + ' SP | ' + formatKg(m.totalGrams) + ' Kg';
      document.getElementById('hudProductName').textContent =
        (latest.productName ? latest.productName : '— Chưa có tên') + ' (' + (latest.productCode || '—') + ')';
      document.getElementById('hudWeight').textContent = formatKg(latest.grams) + ' Kg';
      document.getElementById('btnHudEdit').onclick = function () {
        openEditModal(latest.id);
      };
      if (flash) {
        liveHud.classList.remove('show');
        void liveHud.offsetWidth;
      }
      liveHud.classList.add('show');
    }

    if (flash) {
      card.classList.remove('flash-ok', 'flash-warn');
      void card.offsetWidth;
      card.classList.add(latest.productName ? 'flash-ok' : 'flash-warn');
    }
  }

  function renderScanLists() {
    const recentContainer = document.getElementById('recentScansPreview');
    const recentSlice = records.slice(-5).reverse();
    if (recentSlice.length === 0) {
      recentContainer.innerHTML = '<div style="text-align:center;color:#64748b;padding:12px;font-size:13px;">Chưa có tem nào được quét trong phiên này.</div>';
    } else {
      recentContainer.innerHTML = recentSlice.map(function (r, idx) {
        const orderNum = records.length - idx;
        return buildScanRowHtml(r, orderNum);
      }).join('');
    }

    const query = (document.getElementById('searchHistoryInput').value || '').trim().toLowerCase();
    const fullContainer = document.getElementById('fullScansList');
    const reversedAll = records.slice().map(function (r, i) {
      return { rec: r, num: i + 1 };
    }).reverse();

    const filtered = reversedAll.filter(function (item) {
      if (!query) return true;
      const r = item.rec;
      return (
        String(r.productCode || '').toLowerCase().indexOf(query) !== -1 ||
        String(r.productName || '').toLowerCase().indexOf(query) !== -1 ||
        String(r.rawBarcode || '').toLowerCase().indexOf(query) !== -1 ||
        String(r.note || '').toLowerCase().indexOf(query) !== -1
      );
    });

    if (filtered.length === 0) {
      fullContainer.innerHTML = '<div style="text-align:center;color:#64748b;padding:18px;font-size:13.5px;">Không tìm thấy dòng quét nào phù hợp.</div>';
    } else {
      fullContainer.innerHTML = filtered.map(function (item) {
        return buildScanRowHtml(item.rec, item.num);
      }).join('');
    }
  }

  function buildScanRowHtml(r, orderNum) {
    const dispName = r.productName ? escapeHtml(r.productName) : '<span style="color:#b45309;">— (Chưa có tên)</span>';
    const noteBadge = r.note ? ' <span style="color:#b45309;font-weight:700;">• ' + escapeHtml(r.note) + '</span>' : '';
    return (
      '<div class="scan-row-card' + (r.edited ? ' edited' : '') + '">' +
        '<div class="scan-row-left">' +
          '<div class="scan-row-top">' +
            '<strong>#' + orderNum + '</strong>' +
            '<span class="code-chip">' + escapeHtml(r.productCode || '—') + '</span>' +
            '<span>' + escapeHtml(r.scannedAt) + '</span>' +
          '</div>' +
          '<div class="scan-row-name">' + dispName + '</div>' +
          '<div style="font-size:11.5px;color:#64748b;">' +
            escapeHtml(r.rawBarcode || 'Nhập tay') + noteBadge +
          '</div>' +
        '</div>' +
        '<div class="scan-row-right">' +
          '<div class="scan-row-kg">' + formatKg(r.grams) + ' Kg</div>' +
          '<div class="scan-row-actions">' +
            '<button type="button" class="icon-btn" onclick="window.AppActions.edit(\'' + r.id + '\')">✏️ Sửa</button>' +
            '<button type="button" class="icon-btn del" onclick="window.AppActions.del(\'' + r.id + '\')">🗑️</button>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function renderSummaryTab(m) {
    const tbody = document.getElementById('summaryTableBody');
    if (m.productGroups.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#64748b;padding:18px;">Chưa có dữ liệu tổng hợp.</td></tr>';
      return;
    }
    let html = '';
    for (let i = 0; i < m.productGroups.length; i++) {
      const g = m.productGroups[i];
      const dispName = g.name ? escapeHtml(g.name) : '<span style="color:#b45309;">— (Chưa đặt tên)</span>';
      html += (
        '<tr>' +
          '<td><span class="code-chip">' + escapeHtml(g.code) + '</span></td>' +
          '<td style="font-weight:700;">' + dispName + '</td>' +
          '<td class="num">' + formatInt(g.count) + '</td>' +
          '<td class="num" style="color:#15803d;">' + formatKg(g.grams) + '</td>' +
        '</tr>'
      );
    }
    html += (
      '<tr style="background:#f0fdf4;font-weight:900;">' +
        '<td colspan="2">TỔNG CỘNG (' + formatInt(m.totalProducts) + ' sản phẩm)</td>' +
        '<td class="num">' + formatInt(m.totalScans) + '</td>' +
        '<td class="num" style="color:#15803d;">' + formatKg(m.totalGrams) + '</td>' +
      '</tr>'
    );
    tbody.innerHTML = html;
  }

  function renderCatalogTab() {
    const q = (document.getElementById('searchCatalogInput').value || '').trim().toLowerCase();
    const allCodes = Object.keys(catalogMap).sort();
    document.getElementById('catalogCountLabel').textContent = allCodes.length + ' mã hàng';

    const filtered = allCodes.filter(function (code) {
      if (!q) return true;
      const c = catalogMap[code];
      return (
        code.toLowerCase().indexOf(q) !== -1 ||
        c.name.toLowerCase().indexOf(q) !== -1 ||
        c.fullName.toLowerCase().indexOf(q) !== -1
      );
    });

    const tbody = document.getElementById('catalogTableBody');
    tbody.innerHTML = filtered.slice(0, 150).map(function (code) {
      const c = catalogMap[code];
      return (
        '<tr>' +
          '<td><span class="code-chip">' + escapeHtml(c.code) + '</span></td>' +
          '<td style="font-weight:700;">' + escapeHtml(c.name) + '</td>' +
          '<td style="text-align:right;">' +
            '<button type="button" class="icon-btn" onclick="window.AppActions.editCatalog(\'' + escapeHtml(c.code) + '\')">✏️ Sửa tên</button>' +
          '</td>' +
        '</tr>'
      );
    }).join('');
  }

  // =========================================================================
  // EDIT, MANUAL ADD & DELETE OPERATIONS
  // =========================================================================
  function openEditModal(recordId) {
    const isNew = !recordId;
    document.getElementById('editRecordId').value = recordId || '';
    document.getElementById('editModalTitle').textContent = isNew
      ? '➕ Thêm / Điều Chỉnh Tem Thủ Công'
      : '✏️ Chỉnh Sửa Dòng Đã Quét';

    if (isNew) {
      document.getElementById('editCodeInput').value = '';
      document.getElementById('editNameInput').value = '';
      document.getElementById('editWeightInput').value = '';
      document.getElementById('editNoteInput').value = 'Nhập bổ sung thủ công';
      document.getElementById('btnModalDelete').style.display = 'none';
    } else {
      const rec = records.find(function (r) { return r.id === recordId; });
      if (!rec) return;
      document.getElementById('editCodeInput').value = rec.productCode || '';
      document.getElementById('editNameInput').value = rec.productName || '';
      document.getElementById('editWeightInput').value = (rec.grams / 1000).toFixed(3);
      document.getElementById('editNoteInput').value = rec.note || '';
      document.getElementById('btnModalDelete').style.display = 'inline-flex';
      document.getElementById('btnModalDelete').onclick = function () {
        closeModal('editModal');
        confirmDeleteRecord(rec.id);
      };
    }

    openModal('editModal');
  }

  function saveEditedRecord() {
    const id = document.getElementById('editRecordId').value;
    const code = String(document.getElementById('editCodeInput').value || '').trim();
    const rawName = String(document.getElementById('editNameInput').value || '').trim();
    const weightStr = String(document.getElementById('editWeightInput').value || '').replace(',', '.').trim();
    const note = String(document.getElementById('editNoteInput').value || '').trim();
    const saveCat = document.getElementById('chkSaveToCatalog').checked;

    if (!/^\d{3,8}$/.test(code)) {
      alert('Vui lòng nhập Mã sản phẩm hợp lệ (ví dụ: 10040).');
      return;
    }

    const parsedKg = parseFloat(weightStr);
    const grams = Math.round(parsedKg * 1000);
    if (isNaN(grams) || grams <= 0 || grams > 500000) {
      alert('Vui lòng nhập Số ký hợp lệ lớn hơn 0 (ví dụ: 5.198).');
      return;
    }

    const finalName = rawName !== '' ? rawName : getProductNameOrNull(code);

    if (saveCat && finalName) {
      saveCustomProductToCatalog(code, finalName);
    }

    if (!id) {
      const now = new Date();
      const newRec = {
        id: 'scan_' + now.getTime() + '_' + Math.random().toString(36).slice(2, 7),
        scannedAt: formatDateTimeVN(now),
        productCode: code,
        productName: finalName,
        grams: grams,
        rawBarcode: '',
        note: note || 'Nhập thủ công',
        edited: true
      };
      records.push(newRec);
      enqueueOp({ type: 'add', record: toSyncRecord(newRec) });
    } else {
      const idx = records.findIndex(function (r) { return r.id === id; });
      if (idx === -1) return;
      records[idx].productCode = code;
      records[idx].productName = finalName;
      records[idx].grams = grams;
      records[idx].note = note || 'Đã chỉnh sửa';
      records[idx].edited = true;
      enqueueOp({ type: 'update', record: toSyncRecord(records[idx]) });
    }

    persistRecords();
    closeModal('editModal');
    renderAll(true);
    showBanner('ok', 'Đã cập nhật số liệu và đồng bộ lại tổng cộng!');
    flushSyncQueue();
  }

  function confirmDeleteRecord(recordId) {
    const rec = records.find(function (r) { return r.id === recordId; });
    if (!rec) return;
    const label = (rec.productName || 'Mã ' + rec.productCode) + ' (' + formatKg(rec.grams) + ' Kg)';
    if (!confirm('Xóa dòng quét: ' + label + '?\nTổng số tem, số sản phẩm và số ký sẽ tự động trừ lại tương ứng.')) {
      return;
    }
    records = records.filter(function (r) { return r.id !== recordId; });
    persistRecords();
    enqueueOp({ type: 'delete', id: recordId });
    renderAll(false);
    showBanner('ok', 'Đã xóa dòng "' + label + '" và tính lại tổng tồn!');
    flushSyncQueue();
  }

  // =========================================================================
  // UNIVERSAL CAMERA 1D SCANNER (MỌI ĐIỆN THOẠI iOS/ANDROID & MÁY PDA)
  // =========================================================================
  async function requestUniversalCameraStream() {
    const constraintsList = [
      {
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30 }
        }
      },
      {
        audio: false,
        video: { facingMode: 'environment' }
      },
      {
        audio: false,
        video: true
      }
    ];
    let lastErr = null;
    for (let i = 0; i < constraintsList.length; i++) {
      try {
        return await navigator.mediaDevices.getUserMedia(constraintsList[i]);
      } catch (err) {
        lastErr = err;
        // Nếu người dùng bấm Từ chối quyền Camera thì không thử lại nữa
        if (err && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')) {
          throw err;
        }
      }
    }
    throw lastErr || new Error('Thiết bị không có Camera khả dụng');
  }

  async function startCamera1DScanner() {
    stopCamera1DScanner();
    const statusEl = document.getElementById('cameraStatusBadge');
    const httpsPrompt = document.getElementById('httpsUpgradePrompt');
    const viewportBox = document.getElementById('cameraViewportBox');

    // Kiểm tra nếu mở qua kết nối HTTP thường trên mạng nội bộ bị trình duyệt chặn Camera
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      httpsPrompt.style.display = 'block';
      viewportBox.style.display = 'flex';
      const httpsUrl = (location.port === '8088')
        ? ('https://' + location.hostname + ':8443/' + location.search + '#camera')
        : ('https://longdoanthanh-bot.github.io/scan-ton-kho/' + location.search + '#camera');
      document.getElementById('btnJumpHttps').href = httpsUrl;
      statusEl.textContent = '🔒 Hãy bấm nút xanh phía trên để mở qua kết nối bảo mật HTTPS!';
      return;
    }

    httpsPrompt.style.display = 'none';
    viewportBox.style.display = 'flex';

    await warmUpWasmEngine();

    if ('BarcodeDetector' in window && !nativeDetector) {
      try {
        const supported = await window.BarcodeDetector.getSupportedFormats();
        const formats1D = ['ean_13', 'code_128', 'ean_8', 'itf', 'upc_a'].filter(function (f) {
          return supported.indexOf(f) !== -1;
        });
        if (formats1D.length > 0) {
          nativeDetector = new window.BarcodeDetector({ formats: formats1D });
        }
      } catch (e) {}
    }

    try {
      statusEl.textContent = 'Đang khởi động Camera...';
      mediaStream = await requestUniversalCameraStream();

      const video = document.getElementById('cameraVideo');
      video.setAttribute('playsinline', 'true');
      video.setAttribute('webkit-playsinline', 'true');
      video.muted = true;
      video.srcObject = mediaStream;
      await video.play();

      // Bật lấy nét liên tục & Zoom thông minh 1.5x để không phải dí sát gây mờ tem
      const track = mediaStream.getVideoTracks()[0];
      hardwareZoomSupported = false;
      if (track && track.getCapabilities) {
        try {
          const caps = track.getCapabilities();
          const adv = {};
          if (caps.focusMode && caps.focusMode.indexOf('continuous') !== -1) {
            adv.focusMode = 'continuous';
          }
          if (caps.exposureMode && caps.exposureMode.indexOf('continuous') !== -1) {
            adv.exposureMode = 'continuous';
          }
          if (caps.zoom && caps.zoom.max >= 1.5) {
            hardwareZoomSupported = true;
            adv.zoom = Math.min(currentZoom, caps.zoom.max);
          }
          if (Object.keys(adv).length > 0) {
            await track.applyConstraints({ advanced: [adv] });
          }
        } catch (e) {}
      }
      applyZoomLevel(currentZoom);

      cameraActive = true;
      singleScanActive = false;
      setShutterUIState('ready');
    } catch (err) {
      statusEl.textContent = 'Chưa mở được Camera trực tiếp (' + (err.message || err) + '). Bấm nút tròn để chụp ảnh tem!';
    }
  }

  function setShutterUIState(mode) {
    const viewportBox = document.getElementById('cameraViewportBox');
    const statusEl = document.getElementById('cameraStatusBadge');
    const iconEl = document.getElementById('shutterIcon');
    const textEl = document.getElementById('shutterText');
    if (!viewportBox || !statusEl || !iconEl || !textEl) return;

    viewportBox.classList.remove('is-scanning', 'is-captured');
    if (mode === 'scanning') {
      viewportBox.classList.add('is-scanning');
      iconEl.textContent = '🎯';
      textEl.textContent = 'ĐANG ĐỌC';
      statusEl.textContent = '⚡ Đang đọc 1 tem... Giữ mã vạch sọc nằm trong khung xanh!';
    } else if (mode === 'captured') {
      viewportBox.classList.add('is-captured');
      iconEl.textContent = '✅';
      textEl.textContent = 'XONG';
      statusEl.textContent = '✅ Đã chụp quét xong 1 tem! Đổi sang tem mới rồi bấm nút tròn tiếp';
    } else {
      iconEl.textContent = '📸';
      textEl.textContent = 'QUÉT';
      statusEl.textContent = '👆 Đưa mã vạch vào khung → Bấm nút tròn để chụp quét 1 tem';
    }
  }

  function applyZoomLevel(z) {
    currentZoom = Number(z) || 1;
    document.querySelectorAll('.zoom-btn').forEach(function (btn) {
      const isSelected = Number(btn.dataset.zoom) === currentZoom;
      btn.className = isSelected ? 'btn btn-primary zoom-btn' : 'btn btn-outline zoom-btn';
    });

    const video = document.getElementById('cameraVideo');
    if (!mediaStream) return;
    const track = mediaStream.getVideoTracks()[0];
    if (hardwareZoomSupported && track) {
      try {
        const caps = track.getCapabilities();
        const clamped = Math.max(caps.zoom.min || 1, Math.min(currentZoom, caps.zoom.max));
        track.applyConstraints({ advanced: [{ zoom: clamped }] }).catch(function () {});
        video.style.transform = 'none';
        return;
      } catch (e) {}
    }
    // Phóng cận kỹ thuật số mượt nếu ống kính không hỗ trợ zoom phần cứng
    video.style.transform = currentZoom > 1 ? ('scale(' + currentZoom + ')') : 'none';
  }

  function onShutterScanClick() {
    if (Date.now() < shutterLockUntil) return;

    // Nếu chưa mở được luồng video trực tiếp (ví dụ đang mở qua HTTP hoặc chưa cấp quyền) -> mở chụp 1 ảnh
    if (!cameraActive || !mediaStream) {
      document.getElementById('hiddenImageInput').click();
      return;
    }

    // Nếu đang trong lúc tìm mã mà người dùng bấm lại -> hủy dừng ngay
    if (singleScanActive) {
      singleScanActive = false;
      singleScanToken += 1;
      setShutterUIState('ready');
      return;
    }

    runSingleShotCameraScan();
  }

  async function runSingleShotCameraScan() {
    if (!cameraActive || !mediaStream) return;
    const myToken = ++singleScanToken;
    singleScanActive = true;
    setShutterUIState('scanning');
    vibrateDevice([25]);

    const video = document.getElementById('cameraVideo');
    const offCanvas = document.createElement('canvas');
    const offCtx = offCanvas.getContext('2d', { willReadFrequently: true });

    const deadline = Date.now() + 2800;
    let attempt = 0;
    let lastInvalidError = null;

    while (singleScanActive && cameraActive && mediaStream && singleScanToken === myToken && Date.now() < deadline) {
      if (video && video.readyState >= 2 && video.videoWidth > 0) {
        attempt += 1;
        const vw = video.videoWidth;
        const vh = video.videoHeight;

        const zoomDiv = (!hardwareZoomSupported && currentZoom > 1) ? currentZoom : 1;
        const cropW = Math.floor((vw * 0.94) / zoomDiv);
        const cropH = Math.floor((vh * 0.82) / zoomDiv);
        const cropX = Math.floor((vw - cropW) / 2);
        const cropY = Math.floor((vh - cropH) / 2);

        const maxTargetDim = 1150;
        const scale = Math.min(1, maxTargetDim / Math.max(cropW, cropH));
        const dw = Math.max(160, Math.floor(cropW * scale));
        const dh = Math.max(120, Math.floor(cropH * scale));

        offCanvas.width = dw;
        offCanvas.height = dh;

        const mod = attempt % 4;
        const angleDeg = (mod === 2) ? -28 : ((mod === 3) ? 28 : 0);

        offCtx.save();
        if (attempt % 2 === 0) {
          offCtx.filter = 'contrast(1.35) brightness(1.05)';
        }
        if (angleDeg !== 0) {
          offCtx.translate(dw / 2, dh / 2);
          offCtx.rotate((angleDeg * Math.PI) / 180);
          offCtx.drawImage(video, cropX, cropY, cropW, cropH, -dw / 2, -dh / 2, dw, dh);
        } else {
          offCtx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, dw, dh);
        }
        offCtx.restore();

        let candidate = null;

        // 1. Thử bộ giải mã phần cứng của máy (nếu có)
        if (nativeDetector && angleDeg === 0) {
          try {
            const hits = await nativeDetector.detect(offCanvas);
            if (hits && hits.length > 0 && hits[0].rawValue) {
              candidate = String(hits[0].rawValue).trim();
            }
          } catch (e) {}
        }

        let imgDataCache = null;

        // 2. Bộ giải mã C++ SIMD WebAssembly siêu tốc (bắt cả xoay ngang/dọc 90 độ)
        if (!candidate && window.ZXingWASM && window.ZXingWASM.readBarcodesFromImageData) {
          try {
            imgDataCache = offCtx.getImageData(0, 0, dw, dh);
            const wasmHits = await window.ZXingWASM.readBarcodesFromImageData(imgDataCache, WASM_1D_OPTIONS);
            if (wasmHits && wasmHits.length > 0 && wasmHits[0].text) {
              candidate = String(wasmHits[0].text).trim();
            }
          } catch (e) {}
        }

        // 3. Bộ giải mã EAN-13 thuần JavaScript dự phòng cho điện thoại/PDA đời cũ không hỗ trợ WASM
        if (!candidate) {
          try {
            if (!imgDataCache) imgDataCache = offCtx.getImageData(0, 0, dw, dh);
            const jsHit = decodeEan13PureJsFromImageData(imgDataCache);
            if (jsHit) candidate = jsHit;
          } catch (e) {}
        }

        if (candidate && singleScanToken === myToken && singleScanActive) {
          const check = parseSingle13DigitScaleBarcode(candidate);
          if (check.ok) {
            // NGẮT CẦU DAO NGAY LẬP TỨC — CHỈ LẤY ĐÚNG 1 TEM DUY NHẤT CHO MỖI LẦN BẤM NÚT!
            singleScanActive = false;
            singleScanToken += 1;
            shutterLockUntil = Date.now() + 500;
            setShutterUIState('captured');
            handleBarcodeInput(candidate, 'Camera');
            setTimeout(function () {
              if (!singleScanActive && cameraActive) {
                setShutterUIState('ready');
              }
            }, 950);
            return;
          } else {
            lastInvalidError = check.error;
          }
        }
      }

      await new Promise(function (r) { setTimeout(r, 35); });
    }

    if (singleScanToken === myToken && singleScanActive) {
      singleScanActive = false;
      singleScanToken += 1;
      setShutterUIState('ready');
      playBeep('error');
      vibrateDevice([100, 50, 100]);
      showBanner(
        'error',
        lastInvalidError || 'Chưa đọc rõ dải mã vạch sọc. Hãy giữ chắc tay đưa mã vào khung rồi bấm nút tròn lại!'
      );
    }
  }

  function stopCamera1DScanner() {
    cameraActive = false;
    singleScanActive = false;
    singleScanToken += 1;
    if (mediaStream) {
      mediaStream.getTracks().forEach(function (t) { t.stop(); });
      mediaStream = null;
    }
    torchEnabled = false;
  }

  async function toggleCameraTorch() {
    if (!mediaStream) return;
    const track = mediaStream.getVideoTracks()[0];
    if (!track || !track.getCapabilities) {
      alert('Thiết bị này không hỗ trợ bật đèn Flash từ trình duyệt.');
      return;
    }
    const caps = track.getCapabilities();
    if (!caps.torch) {
      alert('Ống kính này không hỗ trợ bật đèn Flash trực tiếp.');
      return;
    }
    torchEnabled = !torchEnabled;
    try {
      await track.applyConstraints({ advanced: [{ torch: torchEnabled }] });
    } catch (e) {}
  }

  // =========================================================================
  // TURBO PHOTO / IMAGE DECODER (PARALLEL SERVER C++ & MULTI-ANGLE WASM)
  // =========================================================================
  async function decodeBarcodeFromImageFile(file) {
    if (!file) return;
    showBanner('warn', '⚡ Đang quét siêu tốc dải mã vạch sọc...');

    try {
      await warmUpWasmEngine();

      // Chạy đua song song: Bộ máy nào đọc ra mã trước thì trả kết quả NGAY LẬP TỨC (0.02 - 0.1 giây)!
      const tasks = [decodePhotoInBrowserWasm(file)];
      if (location.protocol.startsWith('http') && (location.port === '8088' || location.port === '8443')) {
        tasks.push(decodePhotoViaLocalCppServer(file));
      }

      const foundCode = await raceFirstNonNull(tasks);

      if (foundCode) {
        handleBarcodeInput(foundCode, 'Ảnh chụp');
      } else {
        playBeep('error');
        showBanner('error', 'Không thấy rõ dải mã vạch 13 số trong ảnh. Hãy đưa camera cách tem khoảng 20–25cm cho nét rồi chụp lại!');
      }
    } catch (err) {
      playBeep('error');
      showBanner('error', 'Không đọc được ảnh vừa chọn. Vui lòng thử lại!');
    }
  }

  function raceFirstNonNull(promises) {
    return new Promise(function (resolve) {
      let pending = promises.length;
      let done = false;
      if (pending === 0) {
        resolve(null);
        return;
      }
      promises.forEach(function (p) {
        Promise.resolve(p).then(function (val) {
          if (!done && val) {
            done = true;
            resolve(val);
            return;
          }
          pending -= 1;
          if (!done && pending <= 0) {
            resolve(null);
          }
        }).catch(function () {
          pending -= 1;
          if (!done && pending <= 0) {
            resolve(null);
          }
        });
      });
    });
  }

  async function decodePhotoViaLocalCppServer(file) {
    try {
      const resp = await fetch('/api/decode-barcode', {
        method: 'POST',
        body: file
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      return (data && data.ok && data.code) ? String(data.code) : null;
    } catch (e) {
      return null;
    }
  }

  function loadImageSourceForCanvas(file) {
    if (typeof window.createImageBitmap === 'function') {
      return window.createImageBitmap(file).catch(function () {
        return loadHtmlImageFallback(file);
      });
    }
    return loadHtmlImageFallback(file);
  }

  function loadHtmlImageFallback(file) {
    return new Promise(function (resolve, reject) {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        resolve({
          width: img.naturalWidth || img.width,
          height: img.naturalHeight || img.height,
          _el: img,
          close: function () {}
        });
      };
      img.onerror = function (err) {
        URL.revokeObjectURL(url);
        reject(err || new Error('Image load error'));
      };
      img.src = url;
    });
  }

  // Bộ giải mã EAN-13 thuần JavaScript (Tầng dự phòng số 3 cho mọi trình duyệt ĐT/PDA đời cũ không chạy được WASM)
  const EAN13_L_MAP = {
    '3211': 0, '2221': 1, '2122': 2, '1411': 3, '1132': 4,
    '1231': 5, '1114': 6, '1312': 7, '1213': 8, '3112': 9
  };
  const EAN13_G_MAP = {
    '1123': 0, '1222': 1, '2212': 2, '1141': 3, '2311': 4,
    '1321': 5, '4111': 6, '2131': 7, '3121': 8, '2113': 9
  };
  const EAN13_R_MAP = EAN13_L_MAP; // Cùng độ rộng 4 nhịp (Đen-Trắng-Đen-Trắng thay vì Trắng-Đen-Trắng-Đen)
  const EAN13_PARITY_MAP = {
    'LLLLLL': '0', 'LLGLGG': '1', 'LLGGLG': '2', 'LLGGGL': '3', 'LGLLGG': '4',
    'LGGLLG': '5', 'LGGGLL': '6', 'LGLGLG': '7', 'LGLGGL': '8', 'LGGLGL': '9'
  };

  function normalizeFourRuns(r0, r1, r2, r3) {
    const total = r0 + r1 + r2 + r3;
    if (total < 4) return null;
    const w = [
      Math.max(1, Math.min(4, Math.round((r0 * 7) / total))),
      Math.max(1, Math.min(4, Math.round((r1 * 7) / total))),
      Math.max(1, Math.min(4, Math.round((r2 * 7) / total))),
      Math.max(1, Math.min(4, Math.round((r3 * 7) / total)))
    ];
    let sum = w[0] + w[1] + w[2] + w[3];
    if (sum === 6) {
      let bestIdx = 0;
      let bestDiff = -99;
      const raw = [(r0 * 7) / total, (r1 * 7) / total, (r2 * 7) / total, (r3 * 7) / total];
      for (let k = 0; k < 4; k++) {
        if (w[k] < 4 && (raw[k] - w[k]) > bestDiff) {
          bestDiff = raw[k] - w[k];
          bestIdx = k;
        }
      }
      w[bestIdx] += 1;
      sum = 7;
    } else if (sum === 8) {
      let bestIdx = 0;
      let bestDiff = 99;
      const raw = [(r0 * 7) / total, (r1 * 7) / total, (r2 * 7) / total, (r3 * 7) / total];
      for (let k = 0; k < 4; k++) {
        if (w[k] > 1 && (raw[k] - w[k]) < bestDiff) {
          bestDiff = raw[k] - w[k];
          bestIdx = k;
        }
      }
      w[bestIdx] -= 1;
      sum = 7;
    }
    if (sum !== 7) return null;
    return '' + w[0] + w[1] + w[2] + w[3];
  }

  function decodeEan13FromBitLine(bits, len) {
    // Trích mảng độ dài các vạch liên tiếp [vạch_0, khoảng_1, vạch_2, ...] bắt đầu từ vạch đen (1)
    const runs = [];
    let idx = 0;
    while (idx < len && bits[idx] === 0) idx++;
    while (idx < len) {
      const val = bits[idx];
      let count = 1;
      idx++;
      while (idx < len && bits[idx] === val) {
        count++;
        idx++;
      }
      runs.push(count);
    }
    // EAN-13 chuẩn gồm 59 nhịp xen kẽ (3 đầu + 24 trái + 5 giữa + 24 phải + 3 cuối)
    if (runs.length < 59) return null;
    for (let s = 0; s <= runs.length - 59; s += 2) {
      const unit = (runs[s] + runs[s + 1] + runs[s + 2]) / 3;
      if (unit < 0.75) continue;
      if (
        Math.abs(runs[s] - unit) > unit * 0.85 ||
        Math.abs(runs[s + 1] - unit) > unit * 0.85 ||
        Math.abs(runs[s + 2] - unit) > unit * 0.85
      ) {
        continue;
      }
      // Kiểm tra vạch ngăn giữa (s+27 .. s+31) và vạch kết thúc (s+56 .. s+58)
      const midUnit = (runs[s + 27] + runs[s + 28] + runs[s + 29] + runs[s + 30] + runs[s + 31]) / 5;
      if (Math.abs(midUnit - unit) > unit * 0.75) continue;

      let parity = '';
      let leftDigits = '';
      let ok = true;
      for (let d = 0; d < 6; d++) {
        const o = s + 3 + d * 4;
        const key = normalizeFourRuns(runs[o], runs[o + 1], runs[o + 2], runs[o + 3]);
        if (!key) { ok = false; break; }
        if (EAN13_L_MAP[key] !== undefined) {
          parity += 'L';
          leftDigits += String(EAN13_L_MAP[key]);
        } else if (EAN13_G_MAP[key] !== undefined) {
          parity += 'G';
          leftDigits += String(EAN13_G_MAP[key]);
        } else {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      const firstDigit = EAN13_PARITY_MAP[parity];
      if (!firstDigit) continue;

      let rightDigits = '';
      for (let d = 0; d < 6; d++) {
        const o = s + 32 + d * 4;
        const key = normalizeFourRuns(runs[o], runs[o + 1], runs[o + 2], runs[o + 3]);
        if (!key || EAN13_R_MAP[key] === undefined) { ok = false; break; }
        rightDigits += String(EAN13_R_MAP[key]);
      }
      if (!ok) continue;

      const full13 = firstDigit + leftDigits + rightDigits;
      if (calcEan13CheckDigit(full13.slice(0, 12)) === parseInt(full13.charAt(12), 10)) {
        return full13;
      }
    }
    return null;
  }

  function decodeEan13PureJsFromImageData(imgData) {
    if (!imgData || !imgData.data || imgData.width < 95 || imgData.height < 20) return null;
    const w = imgData.width;
    const h = imgData.height;
    const data = imgData.data;
    const votes = {};

    // Quét 17 đường cắt ngang qua vùng tâm ảnh (cả chiều xuôi & chiều ngược 180 độ)
    const winHalf = Math.max(12, Math.floor(w / 28));
    const gray = new Uint8Array(w);
    const bits = new Uint8Array(w);
    const revBits = new Uint8Array(w);

    for (let step = 1; step <= 17; step++) {
      const y = Math.floor((h * step) / 18);
      let rowOffset = y * w * 4;
      let prefixSum = new Int32Array(w + 1);
      for (let x = 0; x < w; x++) {
        const g = (data[rowOffset] * 77 + data[rowOffset + 1] * 150 + data[rowOffset + 2] * 29) >> 8;
        gray[x] = g;
        prefixSum[x + 1] = prefixSum[x] + g;
        rowOffset += 4;
      }
      for (let x = 0; x < w; x++) {
        const left = Math.max(0, x - winHalf);
        const right = Math.min(w - 1, x + winHalf);
        const localMean = (prefixSum[right + 1] - prefixSum[left]) / (right - left + 1);
        const isDark = gray[x] < (localMean - 6) ? 1 : 0;
        bits[x] = isDark;
        revBits[w - 1 - x] = isDark;
      }
      const c1 = decodeEan13FromBitLine(bits, w);
      if (c1) {
        votes[c1] = (votes[c1] || 0) + 1;
        if (votes[c1] >= 2) return c1;
      }
      const c2 = decodeEan13FromBitLine(revBits, w);
      if (c2) {
        votes[c2] = (votes[c2] || 0) + 1;
        if (votes[c2] >= 2) return c2;
      }
    }
    return null;
  }

  async function decodePhotoInBrowserWasm(file) {
    // Bước 1: Đọc trực tiếp file gốc qua C++ WASM (~25-45ms, hỗ trợ xoay ngang/dọc 90 độ)
    if (window.ZXingWASM && window.ZXingWASM.readBarcodes) {
      try {
        const direct = await window.ZXingWASM.readBarcodes(file, WASM_1D_OPTIONS);
        if (direct && direct.length > 0 && direct[0].text) {
          return direct[0].text;
        }
      } catch (e) {}
    }

    // Bước 2: Chuẩn hóa kích thước ảnh lớn 12MP-48MP + tăng tương phản + thử cả 3 tầng giải mã (Native + WASM + Pure JS)
    try {
      const bmp = await loadImageSourceForCanvas(file);
      const drawSource = bmp._el || bmp;
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });

      const passes = [
        { crop: 1.0, deg: 0, boost: true },
        { crop: 0.62, deg: 0, boost: true },
        { crop: 0.68, deg: -28, boost: true },
        { crop: 0.68, deg: 28, boost: true },
        { crop: 0.85, deg: 90, boost: true }
      ];

      for (let i = 0; i < passes.length; i++) {
        const p = passes[i];
        const sw = Math.round(bmp.width * p.crop);
        const sh = Math.round(bmp.height * p.crop);
        const sx = Math.round((bmp.width - sw) / 2);
        const sy = Math.round((bmp.height - sh) / 2);

        const maxDim = 1500;
        const ratio = Math.min(1, maxDim / Math.max(sw, sh));
        const dw = Math.max(200, Math.round(sw * ratio));
        const dh = Math.max(200, Math.round(sh * ratio));

        canvas.width = dw;
        canvas.height = dh;

        ctx.save();
        if (p.boost) {
          try {
            ctx.filter = 'grayscale(1) contrast(1.6) brightness(1.08)';
          } catch (e) {}
        }
        ctx.translate(dw / 2, dh / 2);
        if (p.deg !== 0) {
          ctx.rotate((p.deg * Math.PI) / 180);
        }
        ctx.drawImage(drawSource, sx, sy, sw, sh, -dw / 2, -dh / 2, dw, dh);
        ctx.restore();

        if (nativeDetector && p.deg === 0) {
          try {
            const natHits = await nativeDetector.detect(canvas);
            if (natHits && natHits.length > 0 && natHits[0].rawValue) {
              if (bmp.close) bmp.close();
              return String(natHits[0].rawValue).trim();
            }
          } catch (e) {}
        }

        const imgData = ctx.getImageData(0, 0, dw, dh);
        if (window.ZXingWASM && window.ZXingWASM.readBarcodesFromImageData) {
          try {
            const hits = await window.ZXingWASM.readBarcodesFromImageData(imgData, WASM_1D_OPTIONS);
            if (hits && hits.length > 0 && hits[0].text) {
              if (bmp.close) bmp.close();
              return hits[0].text;
            }
          } catch (e) {}
        }

        const jsCode = decodeEan13PureJsFromImageData(imgData);
        if (jsCode) {
          if (bmp.close) bmp.close();
          return jsCode;
        }
      }
      if (bmp.close) bmp.close();
    } catch (e) {}

    return null;
  }

  // =========================================================================
  // OFFLINE-FIRST QUEUE & GOOGLE SHEET AUTO-SYNC WHEN BACK ONLINE
  // =========================================================================
  function updateSyncBadge() {
    const dot = document.getElementById('syncStatusDot');
    const txt = document.getElementById('syncStatusText');
    if (!dot || !txt) return;

    if (!navigator.onLine) {
      dot.className = 'sync-dot pending';
      txt.textContent = pendingOps.length > 0
        ? ('📴 Lưu máy (' + pendingOps.length + ' chờ)')
        : '📴 Đang Offline (Lưu máy)';
      return;
    }

    if (!settings.sheetWebAppUrl) {
      dot.className = 'sync-dot';
      txt.textContent = '⚙️ Kết nối GG Sheet';
      return;
    }

    if (syncInProgress) {
      dot.className = 'sync-dot pending';
      txt.textContent = '🔄 Đang cập nhật...';
      return;
    }

    if (pendingOps.length > 0) {
      dot.className = 'sync-dot pending';
      txt.textContent = 'Chờ đẩy (' + pendingOps.length + ')';
    } else {
      dot.className = 'sync-dot ok';
      txt.textContent = '🟢 Đã lưu GG Sheet';
    }
  }

  async function postToGoogleSheet(payloadObj) {
    const response = await fetch(settings.sheetWebAppUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8'
      },
      body: JSON.stringify(payloadObj),
      redirect: 'follow'
    });
    const text = await response.text();
    return JSON.parse(text);
  }

  async function flushSyncQueue(fromAutoReconnect) {
    if (!settings.sheetWebAppUrl || syncInProgress || pendingOps.length === 0) {
      updateSyncBadge();
      return;
    }
    if (!navigator.onLine) {
      updateSyncBadge();
      return;
    }

    syncInProgress = true;
    updateSyncBadge();

    const opsBatch = pendingOps.slice();
    let hadError = false;
    try {
      const catalogArray = Object.keys(catalogMap).map(function (k) { return catalogMap[k]; });
      const res = await postToGoogleSheet({
        action: 'sync_ops',
        ops: opsBatch,
        catalog: catalogArray
      });

      if (res && res.ok) {
        pendingOps = pendingOps.slice(opsBatch.length);
        if (res.sheetUrl && !settings.sheetViewUrl) {
          settings.sheetViewUrl = res.sheetUrl;
          saveSettings();
        }
        persistPendingOps();
        if (fromAutoReconnect && opsBatch.length > 0) {
          showBanner(
            'ok',
            '🌐 Đã có mạng trở lại! Đã tự động cập nhật ' + opsBatch.length + ' thao tác tồn kho lên Google Sheet!'
          );
        }
      } else {
        throw new Error((res && res.error) ? res.error : 'Phản hồi không hợp lệ');
      }
    } catch (err) {
      hadError = true;
      const dot = document.getElementById('syncStatusDot');
      const txt = document.getElementById('syncStatusText');
      if (dot && txt) {
        dot.className = !navigator.onLine ? 'sync-dot pending' : 'sync-dot err';
        txt.textContent = !navigator.onLine
          ? ('📴 Lưu máy (' + pendingOps.length + ' chờ)')
          : ('Chờ mạng ổn định (' + pendingOps.length + ')');
      }
    } finally {
      syncInProgress = false;
      if (!hadError || pendingOps.length === 0) {
        updateSyncBadge();
      }
    }
  }

  async function forceFullPushToSheet() {
    if (!settings.sheetWebAppUrl) {
      openModal('sheetModal');
      return;
    }
    syncInProgress = true;
    updateSyncBadge();
    try {
      const syncRecs = records.map(toSyncRecord);
      const catalogArray = Object.keys(catalogMap).map(function (k) { return catalogMap[k]; });
      const res = await postToGoogleSheet({
        action: 'replace_all',
        records: syncRecs,
        catalog: catalogArray
      });
      if (res && res.ok) {
        pendingOps = [];
        if (res.sheetUrl) {
          settings.sheetViewUrl = res.sheetUrl;
          saveSettings();
        }
        persistPendingOps();
        showBanner('ok', 'Đã đồng bộ toàn bộ ' + records.length + ' tem & danh mục lên Google Sheet!');
      } else {
        alert('Lỗi từ Google Sheet: ' + (res && res.error ? res.error : 'Không xác định'));
      }
    } catch (e) {
      alert('Không kết nối được tới đường link Web App Google Sheet. Hãy kiểm tra quyền truy cập "Bất kỳ ai (Anyone)"!');
    } finally {
      syncInProgress = false;
      updateSyncBadge();
    }
  }

  async function pullFromGoogleSheet() {
    if (!settings.sheetWebAppUrl) {
      alert('Vui lòng dán đường link kết nối Google Sheet trước!');
      return;
    }
    try {
      const sep = settings.sheetWebAppUrl.indexOf('?') === -1 ? '?' : '&';
      const resp = await fetch(settings.sheetWebAppUrl + sep + 'action=pull', { redirect: 'follow' });
      const data = await resp.json();
      if (!data || !data.ok) {
        alert('Lỗi tải dữ liệu: ' + (data && data.error ? data.error : 'Không rõ'));
        return;
      }
      if (Array.isArray(data.catalog) && data.catalog.length > 0) {
        data.catalog.forEach(function (c) {
          if (c.code && c.name) {
            catalogMap[String(c.code).trim()] = {
              code: String(c.code).trim(),
              name: String(c.name).trim(),
              fullName: String(c.fullName || c.name).trim(),
              inventoryId: String(c.inventoryId || '').trim()
            };
          }
        });
      }
      if (Array.isArray(data.records)) {
        records = data.records.map(function (r) {
          return {
            id: r.id,
            scannedAt: r.scannedAt,
            productCode: r.productCode,
            productName: (r.productName && r.productName !== '—') ? r.productName : getProductNameOrNull(r.productCode),
            grams: Math.round(Number(r.grams)),
            rawBarcode: r.rawBarcode || '',
            note: r.note || '',
            edited: Boolean(r.note)
          };
        });
        pendingOps = [];
        persistRecords();
        persistPendingOps();
        renderAll(false);
        closeModal('sheetModal');
        showBanner('ok', 'Đã tải ' + records.length + ' dòng dữ liệu từ Google Sheet về máy thành công!');
      }
    } catch (err) {
      alert('Không tải được dữ liệu từ Google Sheet: ' + (err.message || err));
    }
  }

  function sendLocalServerBackup() {
    if (location.protocol.startsWith('http') && (location.port === '8088' || location.port === '8443')) {
      const m = computeMetrics();
      fetch('/api/local-backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          updatedAt: formatDateTimeVN(new Date()),
          totalScans: m.totalScans,
          totalProducts: m.totalProducts,
          totalKg: m.totalGrams / 1000,
          records: records.map(toSyncRecord)
        })
      }).catch(function () {});
    }
  }

  // =========================================================================
  // EXPORT CSV / EXCEL BACKUP ON DEVICE
  // =========================================================================
  function exportCsvForExcel() {
    if (records.length === 0) {
      alert('Chưa có dữ liệu quét nào để xuất file!');
      return;
    }

    const lines = [];
    lines.push([
      'Ngày giờ scan',
      'Tên sản phẩm',
      'Mã sản phẩm',
      'Số ký tem vừa scan',
      'Tổng số tem đã scan',
      'Tổng số sản phẩm đã scan',
      'Tổng số ký đã scan',
      'Mã vạch gốc',
      'Ghi chú'
    ].map(csvEscape).join(','));

    const seen = {};
    let distinctCount = 0;
    let runningGrams = 0;

    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      runningGrams += r.grams;
      if (r.productCode && !seen[r.productCode]) {
        seen[r.productCode] = true;
        distinctCount += 1;
      }
      lines.push([
        r.scannedAt,
        r.productName ? r.productName : '—',
        '="' + (r.productCode || '') + '"',
        (r.grams / 1000).toFixed(3),
        String(i + 1),
        String(distinctCount),
        (runningGrams / 1000).toFixed(3),
        r.rawBarcode ? '="' + r.rawBarcode + '"' : '',
        r.note || ''
      ].map(csvEscape).join(','));
    }

    const bom = '\uFEFF';
    const blob = new Blob([bom + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = formatDateTimeVN(new Date()).replace(/[/: ]/g, '_');
    a.href = url;
    a.download = 'Kiem_Ton_Scan_Tem_' + stamp + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function csvEscape(val) {
    const s = String(val === null || val === undefined ? '' : val);
    if (s.indexOf(',') !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  // =========================================================================
  // UI EVENTS, MODES & HARDWARE PDA WEDGE LISTENER
  // =========================================================================
  function applyModeUI(mode) {
    currentMode = mode;
    document.querySelectorAll('.mode-btn').forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });

    const scanCard = document.getElementById('scanBoxCard');
    const camCard = document.getElementById('cameraBoxCard');
    const input = document.getElementById('barcodeInput');
    const hint = document.getElementById('scanModeHint');

    if (mode === 'camera') {
      scanCard.style.display = 'none';
      camCard.style.display = 'block';
      startCamera1DScanner();
    } else {
      stopCamera1DScanner();
      camCard.style.display = 'none';
      scanCard.style.display = 'block';

      if (mode === 'pda') {
        input.setAttribute('inputmode', 'none');
        input.placeholder = 'Bấm nút tia laser PDA để quét tem...';
        hint.textContent = '🔫 Chế độ PDA: Đã ẩn bàn phím ảo & tự nhận tia quét toàn màn hình';
        setTimeout(function () { input.focus(); }, 60);
      } else {
        input.setAttribute('inputmode', 'numeric');
        input.placeholder = 'Gõ mã vạch 13 số (VD: 1010040051985)...';
        hint.textContent = '⌨️ Chế độ Nhập tay: Gõ đủ 13 chữ số trên tem rồi bấm Quét';
        setTimeout(function () { input.focus(); }, 60);
      }
    }
  }

  function bindEvents() {
    document.querySelectorAll('.mode-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        applyModeUI(btn.dataset.mode);
      });
    });

    document.querySelectorAll('.zoom-btn').forEach(function (zBtn) {
      zBtn.addEventListener('click', function () {
        applyZoomLevel(Number(zBtn.dataset.zoom));
      });
    });

    const input = document.getElementById('barcodeInput');
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        if (pdaBurstTimer) {
          clearTimeout(pdaBurstTimer);
          pdaBurstTimer = null;
        }
        pdaBurstStartMs = 0;
        const val = input.value;
        input.value = '';
        if (val && val.trim() !== '') {
          handleBarcodeInput(val, 'Input');
        }
      }
    });

    // Hỗ trợ 100% các dòng máy PDA công nghiệp (Zebra, Urovo, Sunmi, Honeywell, iData, Newland)
    // kể cả các máy bắn trực tiếp chuỗi 13 số vào ô nhập mà KHÔNG gửi phím Enter cuối dòng
    input.addEventListener('input', function () {
      const raw = input.value || '';
      if (raw.indexOf('\n') !== -1 || raw.indexOf('\r') !== -1) {
        if (pdaBurstTimer) {
          clearTimeout(pdaBurstTimer);
          pdaBurstTimer = null;
        }
        pdaBurstStartMs = 0;
        const cleanedLine = raw.replace(/[\r\n]+/g, '').trim();
        input.value = '';
        if (cleanedLine) {
          handleBarcodeInput(cleanedLine, 'PDA Line');
        }
        return;
      }

      if (currentMode === 'pda') {
        const trimmed = raw.trim();
        if (trimmed.length === 0) {
          pdaBurstStartMs = 0;
          return;
        }
        const now = Date.now();
        if (!pdaBurstStartMs || (now - pdaBurstStartMs > 600 && trimmed.length <= 2)) {
          pdaBurstStartMs = now;
        }
        if (/^\d{13}$/.test(trimmed) && (now - pdaBurstStartMs <= 450)) {
          if (pdaBurstTimer) clearTimeout(pdaBurstTimer);
          pdaBurstTimer = setTimeout(function () {
            pdaBurstTimer = null;
            pdaBurstStartMs = 0;
            const captured = input.value.trim();
            if (captured) {
              input.value = '';
              handleBarcodeInput(captured, 'PDA Burst');
            }
          }, 60);
        }
      }
    });

    input.addEventListener('paste', function () {
      setTimeout(function () {
        if (pdaBurstTimer) {
          clearTimeout(pdaBurstTimer);
          pdaBurstTimer = null;
        }
        const val = input.value.trim();
        if (val.length >= 13) {
          input.value = '';
          handleBarcodeInput(val, 'Paste');
        }
      }, 20);
    });

    // Bắt sự kiện dán (Broadcast/Clipboard mode trên một số dòng PDA nội địa) ngay cả khi con trỏ rời ô nhập
    window.addEventListener('paste', function (e) {
      const activeTag = document.activeElement ? document.activeElement.tagName : '';
      const activeId = document.activeElement ? document.activeElement.id : '';
      if ((activeTag === 'INPUT' || activeTag === 'TEXTAREA') && activeId !== 'barcodeInput') {
        return;
      }
      if (activeId === 'barcodeInput') return;
      const clip = e.clipboardData && e.clipboardData.getData ? e.clipboardData.getData('text') : '';
      if (clip && /^\d{13}$/.test(clip.trim())) {
        e.preventDefault();
        handleBarcodeInput(clip.trim(), 'PDA Paste');
      }
    });

    document.getElementById('btnSubmitBarcode').addEventListener('click', function () {
      if (pdaBurstTimer) {
        clearTimeout(pdaBurstTimer);
        pdaBurstTimer = null;
      }
      const val = input.value;
      input.value = '';
      handleBarcodeInput(val, 'Button');
      if (currentMode === 'pda') input.focus();
    });

    window.addEventListener('keydown', function (e) {
      // Cho phép bấm phím cứng cò quét bên hông PDA (F9/F10) để chụp quét khi đang bật chế độ Camera
      if (currentMode === 'camera' && (e.code === 'F9' || e.code === 'F10')) {
        e.preventDefault();
        onShutterScanClick();
        return;
      }

      const activeTag = document.activeElement ? document.activeElement.tagName : '';
      const activeId = document.activeElement ? document.activeElement.id : '';
      if ((activeTag === 'INPUT' || activeTag === 'TEXTAREA') && activeId !== 'barcodeInput') {
        return;
      }
      if (activeId === 'barcodeInput') {
        return;
      }

      const now = Date.now();
      if (now - wedgeLastKeyTime > 120) {
        wedgeBuffer = '';
      }
      wedgeLastKeyTime = now;

      if (e.key >= '0' && e.key <= '9') {
        wedgeBuffer += e.key;
      } else if ((e.key === 'Enter' || e.key === 'Tab') && wedgeBuffer.length >= 8) {
        e.preventDefault();
        const captured = wedgeBuffer;
        wedgeBuffer = '';
        handleBarcodeInput(captured, 'PDA Laser');
      }
    });

    // Cài ứng dụng ra màn hình chính (1 chạm mở Offline ngay như phần mềm cài sẵn)
    const installBtn = document.getElementById('btnInstallPwa');
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      deferredInstallPrompt = e;
      if (installBtn) installBtn.style.display = 'inline-flex';
    });
    if (installBtn) {
      installBtn.addEventListener('click', async function () {
        if (!deferredInstallPrompt) return;
        deferredInstallPrompt.prompt();
        try { await deferredInstallPrompt.userChoice; } catch (err) {}
        deferredInstallPrompt = null;
        installBtn.style.display = 'none';
      });
    }

    document.getElementById('btnShutterScan').addEventListener('click', onShutterScanClick);
    document.getElementById('btnToggleTorch').addEventListener('click', toggleCameraTorch);
    document.getElementById('btnPickImage').addEventListener('click', function () {
      document.getElementById('hiddenImageInput').click();
    });
    document.getElementById('btnQuickPhotoScan').addEventListener('click', function () {
      document.getElementById('hiddenImageInput').click();
    });
    document.getElementById('hiddenImageInput').addEventListener('change', function (e) {
      const file = e.target.files && e.target.files[0];
      if (file) decodeBarcodeFromImageFile(file);
      e.target.value = '';
    });

    document.querySelectorAll('.nav-item').forEach(function (navBtn) {
      navBtn.addEventListener('click', function () {
        const target = navBtn.dataset.tab;
        document.querySelectorAll('.nav-item').forEach(function (b) { b.classList.remove('active'); });
        navBtn.classList.add('active');
        document.querySelectorAll('.tab-view').forEach(function (v) {
          v.classList.toggle('active', v.id === target);
        });
        const scanTop = document.getElementById('scanTopSection');
        if (scanTop) {
          scanTop.style.display = (target === 'tabScan') ? 'block' : 'none';
        }
        if (target !== 'tabScan' && currentMode === 'camera') {
          stopCamera1DScanner();
        } else if (target === 'tabScan' && currentMode === 'camera') {
          startCamera1DScanner();
        }
      });
    });

    document.getElementById('searchHistoryInput').addEventListener('input', renderScanLists);
    document.getElementById('searchCatalogInput').addEventListener('input', renderCatalogTab);

    document.getElementById('editCodeInput').addEventListener('input', function (e) {
      const code = String(e.target.value || '').trim();
      const found = getProductNameOrNull(code);
      if (found) {
        document.getElementById('editNameInput').value = found;
      }
    });

    document.getElementById('btnSaveEdit').addEventListener('click', saveEditedRecord);
    document.getElementById('btnOpenManualAdd').addEventListener('click', function () {
      openEditModal(null);
    });
    document.getElementById('btnOpenManualAdd2').addEventListener('click', function () {
      openEditModal(null);
    });

    document.getElementById('btnConfirmDuplicate').addEventListener('click', function () {
      const code = pendingDuplicateCode;
      pendingDuplicateCode = null;
      closeModal('duplicateModal');
      if (code) processSingleBarcode(code, 'ConfirmedDup', true);
    });
    document.getElementById('btnCancelDuplicate').addEventListener('click', function () {
      pendingDuplicateCode = null;
      closeModal('duplicateModal');
    });

    document.getElementById('btnOpenSheetModal').addEventListener('click', openSheetModalUI);
    document.getElementById('btnCopyAppsScript').addEventListener('click', function () {
      const code = window.GOOGLE_APPS_SCRIPT_CODE || '';
      navigator.clipboard.writeText(code).then(function () {
        showBanner('ok', 'Đã sao chép Mã Kết Nối Google Sheet!');
        document.getElementById('btnCopyAppsScript').textContent = '✅ Đã sao chép mã!';
        setTimeout(function () {
          document.getElementById('btnCopyAppsScript').textContent = '📋 Bước 1: Sao chép Mã Kết Nối Google Sheet';
        }, 3000);
      });
    });

    const sheetUrlInputEl = document.getElementById('sheetWebAppUrlInput');
    if (sheetUrlInputEl) {
      sheetUrlInputEl.addEventListener('input', refreshTeamShareBoxUI);
    }
    const copyTeamBtn = document.getElementById('btnCopyTeamLink');
    if (copyTeamBtn) {
      copyTeamBtn.addEventListener('click', function () {
        const rawUrl = String((sheetUrlInputEl && sheetUrlInputEl.value) || settings.sheetWebAppUrl || '').trim();
        if (!rawUrl) return;
        const baseClean = window.location.origin + window.location.pathname;
        const teamLink = baseClean + '?sheet=' + encodeURIComponent(rawUrl) + '#camera';
        navigator.clipboard.writeText(teamLink).then(function () {
          showBanner('ok', '✅ Đã sao chép Link dùng chung! Gửi qua Zalo cho ĐT/PDA nào cũng quét & tự đồng bộ được!');
          copyTeamBtn.textContent = '✅ Đã sao chép Link dùng chung!';
          setTimeout(function () {
            copyTeamBtn.textContent = '🔗 Sao chép Link dùng chung cho mọi ĐT & PDA';
          }, 3000);
        });
      });
    }

    document.getElementById('btnSaveSheetUrl').addEventListener('click', async function () {
      const urlVal = String(document.getElementById('sheetWebAppUrlInput').value || '').trim();
      const viewVal = String(document.getElementById('sheetViewUrlInput').value || '').trim();
      settings.sheetWebAppUrl = urlVal;
      settings.sheetViewUrl = viewVal;
      saveSettings();
      closeModal('sheetModal');
      if (urlVal) {
        if (navigator.onLine) {
          await forceFullPushToSheet();
        } else {
          updateSyncBadge();
          showBanner('ok', '📴 Đã lưu đường link Google Sheet! Ngay khi có mạng hệ thống sẽ tự đẩy dữ liệu lên.');
        }
      } else {
        updateSyncBadge();
      }
    });

    document.getElementById('btnPullSheet').addEventListener('click', pullFromGoogleSheet);
    document.getElementById('btnForceSyncNow').addEventListener('click', forceFullPushToSheet);

    document.getElementById('btnExportExcel').addEventListener('click', exportCsvForExcel);
    document.getElementById('btnExportExcel2').addEventListener('click', exportCsvForExcel);
    function clearAllSessionRecords() {
      if (records.length === 0) {
        showBanner('warn', 'Danh sách hiện đang trống (0 tem)!');
        return;
      }
      if (!confirm('Bạn có chắc chắn muốn XÓA TRẮNG toàn bộ ' + records.length + ' tem đang có để bắt đầu đợt kiểm tồn mới từ 0 không?')) {
        return;
      }
      records = [];
      lastScannedCode = '';
      lastScannedEpoch = 0;
      persistRecords();
      enqueueOp({ type: 'clear_all' });
      renderAll(false);
      showBanner('ok', 'Đã xóa sạch làm mới phiên kiểm tồn về 0!');
      flushSyncQueue();
    }

    document.getElementById('btnClearSession').addEventListener('click', clearAllSessionRecords);
    const quickClearBtn = document.getElementById('btnQuickClearSession');
    if (quickClearBtn) {
      quickClearBtn.addEventListener('click', clearAllSessionRecords);
    }

    document.getElementById('btnAddCatalogItem').addEventListener('click', function () {
      const code = prompt('Nhập Mã sản phẩm 5 chữ số (ví dụ: 10040):');
      if (!code) return;
      const cleanCode = code.trim();
      const current = getProductNameOrNull(cleanCode) || '';
      const name = prompt('Nhập Tên sản phẩm cho mã ' + cleanCode + ':', current);
      if (!name || !name.trim()) return;
      saveCustomProductToCatalog(cleanCode, name.trim());
      showBanner('ok', 'Đã lưu "' + cleanCode + ' - ' + name.trim() + '" vào danh mục!');
    });

    document.getElementById('chkSoundToggle').checked = settings.soundEnabled;
    document.getElementById('chkSoundToggle').addEventListener('change', function (e) {
      settings.soundEnabled = e.target.checked;
      saveSettings();
    });

    document.getElementById('chkDupGuardToggle').checked = settings.duplicateAskSec > 0;
    document.getElementById('chkDupGuardToggle').addEventListener('change', function (e) {
      settings.duplicateAskSec = e.target.checked ? 4 : 0;
      saveSettings();
    });
  }

  function refreshTeamShareBoxUI() {
    const box = document.getElementById('teamShareBox');
    const inp = document.getElementById('sheetWebAppUrlInput');
    if (!box || !inp) return;
    const val = String(inp.value || '').trim();
    box.style.display = (val.indexOf('https://script.google.com/') === 0 || val.indexOf('http') === 0) ? 'block' : 'none';
  }

  function openSheetModalUI() {
    document.getElementById('sheetWebAppUrlInput').value = settings.sheetWebAppUrl || '';
    document.getElementById('sheetViewUrlInput').value = settings.sheetViewUrl || '';
    refreshTeamShareBoxUI();
    const openLinkBtn = document.getElementById('btnOpenGoogleSheetTab');
    if (settings.sheetViewUrl) {
      openLinkBtn.href = settings.sheetViewUrl;
      openLinkBtn.style.display = 'inline-flex';
    } else {
      openLinkBtn.style.display = 'none';
    }
    openModal('sheetModal');
  }

  window.AppActions = {
    edit: function (id) { openEditModal(id); },
    del: function (id) { confirmDeleteRecord(id); },
    editCatalog: function (code) {
      const cur = getProductNameOrNull(code) || '';
      const next = prompt('Sửa tên hiển thị cho mã ' + code + ':', cur);
      if (next && next.trim()) {
        saveCustomProductToCatalog(code, next.trim());
        showBanner('ok', 'Đã cập nhật tên mã ' + code + ' -> ' + next.trim());
      }
    },
    closeModal: closeModal
  };

  function openModal(id) {
    document.getElementById(id).classList.add('open');
  }

  function closeModal(id) {
    document.getElementById(id).classList.remove('open');
    if (currentMode === 'pda') {
      setTimeout(function () {
        const inp = document.getElementById('barcodeInput');
        if (inp) inp.focus();
      }, 60);
    }
  }

  function showBanner(type, message) {
    const el = document.getElementById('alertBanner');
    const txt = document.getElementById('alertBannerText');
    el.className = 'alert-banner show ' + type;
    txt.textContent = message;
  }

  function formatInt(n) {
    return Number(n || 0).toLocaleString('vi-VN');
  }

  function formatKg(grams) {
    const kg = Math.round(Number(grams || 0)) / 1000;
    return kg.toFixed(3);
  }

  function formatDateTimeVN(d) {
    const pad = function (v) { return v < 10 ? '0' + v : String(v); };
    return (
      pad(d.getDate()) + '/' +
      pad(d.getMonth() + 1) + '/' +
      d.getFullYear() + ' ' +
      pad(d.getHours()) + ':' +
      pad(d.getMinutes()) + ':' +
      pad(d.getSeconds())
    );
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function playBeep(kind) {
    if (!settings.soundEnabled) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!audioCtx) audioCtx = new Ctx();
      if (audioCtx.state === 'suspended') audioCtx.resume();

      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);

      const now = audioCtx.currentTime;
      if (kind === 'ok') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(1180, now);
        osc.frequency.setValueAtTime(1520, now + 0.045);
        gain.gain.setValueAtTime(0.2, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
        osc.start(now);
        osc.stop(now + 0.12);
      } else if (kind === 'warn') {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(520, now);
        gain.gain.setValueAtTime(0.22, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
        osc.start(now);
        osc.stop(now + 0.22);
      } else {
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(260, now);
        gain.gain.setValueAtTime(0.22, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.30);
        osc.start(now);
        osc.stop(now + 0.30);
      }
    } catch (e) {}
  }

  function vibrateDevice(pattern) {
    try {
      if (navigator.vibrate) navigator.vibrate(pattern);
    } catch (e) {}
  }
})();
