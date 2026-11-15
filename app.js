(function () {
  'use strict';

  const STORAGE_RECORDS = 'scan_ton_records_v1';
  const STORAGE_CUSTOM_CATALOG = 'scan_ton_custom_catalog_v1';
  const STORAGE_PENDING_OPS = 'scan_ton_pending_ops_v1';
  const STORAGE_SETTINGS = 'scan_ton_settings_v1';

  const VALID_SCALE_PREFIXES = ['10', '11', '20', '21', '22', '23', '24', '25', '26', '27', '28', '29'];

  // Chỉ cho phép các chuẩn mã vạch sọc 1D — Khóa cứng 100% không đọc mã vuông 2D
  // Tắt tryDownscale để giữ nguyên 100% độ phân giải gốc của cảm biến Camera (đọc nhạy cả ở cự ly xa 35-50cm!)
  const WASM_1D_FAST_OPTIONS = {
    formats: ['EAN-13', 'Code128', 'EAN-8', 'ITF', 'UPC-A'],
    tryHarder: true,
    tryRotate: true,
    tryInvert: true,
    tryDownscale: false,
    maxNumberOfSymbols: 2
  };

  const WASM_1D_LOCAL_OPTIONS = {
    formats: ['EAN-13', 'Code128', 'EAN-8', 'ITF', 'UPC-A'],
    tryHarder: true,
    tryRotate: true,
    tryInvert: true,
    tryDownscale: false,
    binarizer: 'LocalAverage',
    maxNumberOfSymbols: 2
  };

  const WASM_1D_OPTIONS = WASM_1D_LOCAL_OPTIONS;

  const DEFAULT_SHEET_WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbxlF9UorbWyYzxFA4avEIkloBab44VZzqznaxTXSSTAZtb13QRp5GQoHb_KGCAnAayg/exec';
  const DEFAULT_SHEET_VIEW_URL = 'https://docs.google.com/spreadsheets/d/1jmwE8LBV4XroBIKVohHFDXwWjEhDwSHZnUb-ziLrDgk/edit?gid=0#gid=0';

  // State
  let records = [];
  let catalogMap = {};
  let pendingOps = [];
  let settings = {
    sheetWebAppUrl: DEFAULT_SHEET_WEB_APP_URL,
    sheetViewUrl: DEFAULT_SHEET_VIEW_URL,
    soundEnabled: true,
    duplicateAskSec: 4,
    scalePrefixOnly: true,
    autoSnapCamera: false
  };

  let currentMode = 'pda';
  let syncInProgress = false;
  let lastScannedCode = '';
  let lastScannedEpoch = 0;
  let pendingDuplicateCode = null;
  let pendingDuplicateDates = null;
  let pendingDuplicateDateCtx = null;
  let dateOnlyTarget = 'latest';

  // Camera, WASM, Live Pre-Lock Radar & Async Offline OCR state
  let wasmReadyPromise = null;
  let ocrWorkerPromise = null;
  let ocrWorkerResolved = false;
  let ocrQueuePromise = Promise.resolve();
  let activeDateReadsCount = 0;
  let readingDateRecordIds = {};
  let syncHoldTimer = null;
  let reconcileInFlight = false;
  let mediaStream = null;
  let cameraActive = false;
  let torchEnabled = false;
  let currentZoom = 1;
  let hardwareZoomSupported = false;
  let nativeDetector = null;
  let singleScanActive = false;
  let singleScanToken = 0;
  let shutterLockUntil = 0;
  let livePreLock = null;
  let radarLoopId = 0;
  let lastAutoSnappedCode = '';
  let lastAutoSnappedEpoch = 0;

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

  function warmUpOcrWorker() {
    if (ocrWorkerPromise) return ocrWorkerPromise;
    if (!window.Tesseract || !window.Tesseract.createWorker) {
      return Promise.resolve(null);
    }
    const base = new URL('./vendor/ocr/', window.location.href).href;
    ocrWorkerPromise = window.Tesseract.createWorker('eng', 1, {
      workerPath: base + 'worker.min.js',
      corePath: base,
      langPath: base,
      gzip: true,
      workerBlobURL: false,
      cacheMethod: 'none',
      logger: function () {}
    }).then(async function (worker) {
      await worker.setParameters({
        tessedit_pageseg_mode: '6'
      });
      ocrWorkerResolved = true;
      return worker;
    }).catch(function () {
      ocrWorkerPromise = null;
      ocrWorkerResolved = false;
      return null;
    });
    return ocrWorkerPromise;
  }

  function registerAndAutoUpdateServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (!(location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      return;
    }
    const hadPreviousController = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.register('./sw.js?v=10b', { updateViaCache: 'none' }).then(function (reg) {
      if (reg.waiting) {
        reg.waiting.postMessage('SKIP_WAITING');
      }
      reg.addEventListener('updatefound', function () {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', function () {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            nw.postMessage('SKIP_WAITING');
          }
        });
      });
      setTimeout(function () { reg.update().catch(function () {}); }, 1500);
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) reg.update().catch(function () {});
      });
    }).catch(function () {});

    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!hadPreviousController || singleScanActive) return;
      try {
        if (sessionStorage.getItem('sw_reloaded_v10b') === '1') return;
        sessionStorage.setItem('sw_reloaded_v10b', '1');
      } catch (e) {}
      window.location.reload();
    });
  }

  async function initApp() {
    warmUpWasmEngine();
    setTimeout(function () { warmUpOcrWorker(); }, 120);

    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(function () {});
    }

    loadSettings();
    checkUrlParamsForSheet();
    loadCatalog();
    await loadRecordsAndOpsWithVaultRecovery();

    bindEvents();
    refreshAutoSnapBtnUI();
    updateOfflineBannerUI();
    refreshSettingsSheetLinkUI();

    if (window.location.hash === '#camera') {
      applyModeUI('camera');
    } else {
      applyModeUI('pda');
    }

    renderAll();
    registerAndAutoUpdateServiceWorker();

    window.addEventListener('online', function () {
      updateOfflineBannerUI();
      reconcileWithGoogleSheet(false, true);
    });

    window.addEventListener('offline', function () {
      updateOfflineBannerUI();
      updateSyncBadge();
    });

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && navigator.onLine && settings.sheetWebAppUrl) {
        reconcileWithGoogleSheet(false, false);
      }
    });

    window.addEventListener('focus', function () {
      if (navigator.onLine && settings.sheetWebAppUrl) {
        reconcileWithGoogleSheet(false, false);
      }
    });

    // Tự động đối chiếu 2 chiều với Google Sheet mỗi 5 giây khi đang mở màn hình và có mạng:
    // - Có mục Offline chờ -> tự đẩy lên Sheet
    // - Xóa / sửa dòng trực tiếp trên Google Sheet -> App tự cập nhật khớp tức thì!
    setInterval(function () {
      if (!document.hidden && navigator.onLine && settings.sheetWebAppUrl && !singleScanActive && activeDateReadsCount === 0) {
        reconcileWithGoogleSheet(false, false);
      }
    }, 5000);

    if (settings.sheetWebAppUrl && navigator.onLine) {
      reconcileWithGoogleSheet(false, false);
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

  function refreshSettingsSheetLinkUI() {
    const linkEl = document.getElementById('btnSettingsOpenSheet');
    if (linkEl && settings.sheetViewUrl) {
      linkEl.href = settings.sheetViewUrl;
    }
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_SETTINGS);
      if (raw) {
        const parsed = JSON.parse(raw);
        settings = Object.assign(settings, parsed);
      }
      if (!settings.sheetWebAppUrl) settings.sheetWebAppUrl = DEFAULT_SHEET_WEB_APP_URL;
      if (!settings.sheetViewUrl) settings.sheetViewUrl = DEFAULT_SHEET_VIEW_URL;
    } catch (e) {}
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORAGE_SETTINGS, JSON.stringify(settings));
    } catch (e) {}
    idbSave(STORAGE_SETTINGS, settings);
    refreshSettingsSheetLinkUI();
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
      if (!settings.sheetWebAppUrl) settings.sheetWebAppUrl = DEFAULT_SHEET_WEB_APP_URL;
      if (!settings.sheetViewUrl) settings.sheetViewUrl = DEFAULT_SHEET_VIEW_URL;
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
  // CHUẨN HÓA NGÀY SẢN XUẤT (NSX) & HẠN SỬ DỤNG (HSD) — FAIL-CLOSED (CẤM TỰ ĐOÁN)
  // =========================================================================
  function normalizeDateVN(raw) {
    const s = String(raw || '').trim();
    if (!s || s === '—' || s === '-' || s === 'null' || s === 'undefined') return '';

    const pad2 = function (n) { return n < 10 ? ('0' + n) : String(n); };

    // Dạng dd/MM/yyyy, dd.MM.yyyy, dd-MM-yyyy
    let m = s.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](20[23]\d)$/);
    if (m) {
      const d = parseInt(m[1], 10);
      const mo = parseInt(m[2], 10);
      const y = parseInt(m[3], 10);
      if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) {
        return pad2(d) + '/' + pad2(mo) + '/' + y;
      }
      return '';
    }

    // Dạng yyyy-MM-dd
    m = s.match(/^(20[23]\d)[.\/-](\d{1,2})[.\/-](\d{1,2})$/);
    if (m) {
      const y = parseInt(m[1], 10);
      const mo = parseInt(m[2], 10);
      const d = parseInt(m[3], 10);
      if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) {
        return pad2(d) + '/' + pad2(mo) + '/' + y;
      }
      return '';
    }

    // Dạng gõ nhanh 8 chữ số ddMMyyyy (VD: 12112026 -> 12/11/2026)
    m = s.match(/^(\d{2})(\d{2})(20[23]\d)$/);
    if (m) {
      const d = parseInt(m[1], 10);
      const mo = parseInt(m[2], 10);
      const y = parseInt(m[3], 10);
      if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) {
        return pad2(d) + '/' + pad2(mo) + '/' + y;
      }
    }

    return '';
  }

  function formatLotDateDisplay(val) {
    const clean = normalizeDateVN(val);
    return clean || '—';
  }

  function getActivePdaLotDates() {
    const nsxEl = document.getElementById('pdaLotNsxInput');
    const hsdEl = document.getElementById('pdaLotHsdInput');
    const nsx = nsxEl ? normalizeDateVN(nsxEl.value) : '';
    const hsd = hsdEl ? normalizeDateVN(hsdEl.value) : '';
    return { nsx: nsx, hsd: hsd };
  }

  function refreshPdaLotClearBtn() {
    const btn = document.getElementById('btnClearLotDates');
    const nsxEl = document.getElementById('pdaLotNsxInput');
    const hsdEl = document.getElementById('pdaLotHsdInput');
    if (!btn || !nsxEl || !hsdEl) return;
    const hasVal = (nsxEl.value.trim() !== '' || hsdEl.value.trim() !== '');
    btn.style.display = hasVal ? 'inline-flex' : 'none';
  }

  // =========================================================================
  // BỘ ĐỌC TỰ ĐỘNG NSX & HSD TRÊN TEM MEATCOOL (100% OFFLINE + ĐA KHUNG CHỐNG RUNG & NGHIÊNG)
  // =========================================================================
  function parseOcrNsxHsdText(rawText) {
    const text = String(rawText || '');
    if (!text) return { nsx: '', hsd: '' };

    const pad2 = function (n) { return n < 10 ? ('0' + n) : String(n); };
    const found = [];

    function tryPushCandidate(d, mo, y, matchIndex, matchLen, hasSeparator) {
      if (!(y >= 2024 && y <= 2036 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return;
      const mStart = matchIndex;
      const mEnd = matchIndex + Math.max(6, matchLen || 8);
      for (let k = 0; k < found.length; k++) {
        if (Math.max(found[k].start, mStart) < Math.min(found[k].end, mEnd)) {
          return;
        }
      }
      const checkDate = new Date(y, mo - 1, d);
      if (
        checkDate.getFullYear() !== y ||
        checkDate.getMonth() !== (mo - 1) ||
        checkDate.getDate() !== d
      ) {
        return;
      }
      const prefixCtx = text.slice(Math.max(0, matchIndex - 32), matchIndex + 4).toUpperCase();
      if (!hasSeparator && !/N\s*S\s*X|H\s*S\s*D|S\s*X\s*:|S\s*D\s*:|MFG|EXP/.test(prefixCtx)) {
        return;
      }
      found.push({
        str: pad2(d) + '/' + pad2(mo) + '/' + y,
        epoch: checkDate.getTime(),
        prefixCtx: prefixCtx,
        start: mStart,
        end: mEnd
      });
    }

    // Lượt A: Bắt chuẩn ngày có dấu chấm, phẩy, gạch chéo, gạch ngang, hai chấm hoặc khoảng trắng (VD: 12.11.2026, 12,11.2026, 12 11 2026)
    const regexSep = /(?:^|[^\d])(0?[1-9]|[12]\d|3[01])[.,\/:\-\s]{1,2}(0?[1-9]|1[0-2])[.,\/:\-\s]{1,2}(20[23]\d)(?!\d)/g;
    let m;
    while ((m = regexSep.exec(text)) !== null) {
      tryPushCandidate(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10), m.index, m[0].length, true);
    }

    // Lượt B: Bắt trường hợp ảnh hơi mờ làm mất 1 hoặc 2 dấu chấm nhỏ (VD: 12.112026, 1211.2026, hoặc NSX: 12112026)
    const regexCompact = /(?:^|[^\d])(0[1-9]|[12]\d|3[01])([.,\/:\-\s]?)(0[1-9]|1[0-2])([.,\/:\-\s]?)(20[23]\d)(?!\d)/g;
    while ((m = regexCompact.exec(text)) !== null) {
      const hasAnySep = Boolean(m[2] || m[4]);
      tryPushCandidate(parseInt(m[1], 10), parseInt(m[3], 10), parseInt(m[5], 10), m.index, m[0].length, hasAnySep);
    }

    if (found.length === 0) return { nsx: '', hsd: '' };

    const unique = [];
    const seen = {};
    for (let i = 0; i < found.length; i++) {
      if (!seen[found[i].str]) {
        seen[found[i].str] = true;
        unique.push(found[i]);
      }
    }

    if (unique.length >= 2) {
      unique.sort(function (a, b) { return a.epoch - b.epoch; });
      return {
        nsx: unique[0].str,
        hsd: unique[unique.length - 1].str
      };
    }

    if (found.length >= 2 && found[0].str === found[1].str) {
      return { nsx: found[0].str, hsd: found[1].str };
    }

    // Chỉ đọc rõ được 1 ngày duy nhất -> kiểm tra nhãn NSX hay HSD đi kèm, tuyệt đối không tự đoán ngày còn lại!
    const single = unique[0];
    if (/H\s*S\s*D|S\s*D\s*:|EXP/.test(single.prefixCtx)) {
      return { nsx: '', hsd: single.str };
    }
    if (/N\s*S\s*X|S\s*X\s*:|MFG/.test(single.prefixCtx)) {
      return { nsx: single.str, hsd: '' };
    }
    return { nsx: '', hsd: '' };
  }

  function enhanceSoftGrayscaleCanvas(srcCanvas) {
    const w = srcCanvas.width;
    const h = srcCanvas.height;
    const out = document.createElement('canvas');
    const pad = 22;
    out.width = w + pad * 2;
    out.height = h + pad * 2;
    const oCtx = out.getContext('2d', { willReadFrequently: true });
    oCtx.fillStyle = '#ffffff';
    oCtx.fillRect(0, 0, out.width, out.height);
    oCtx.drawImage(srcCanvas, pad, pad);

    const img = oCtx.getImageData(pad, pad, w, h);
    const d = img.data;
    const lumArr = new Uint8Array(w * h);
    const hist = new Uint32Array(256);

    for (let i = 0, p = 0; i < lumArr.length; i++, p += 4) {
      const g = (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8;
      lumArr[i] = g;
      hist[g] += 1;
    }

    const total = lumArr.length;
    let sum = 0;
    let high = 230;
    for (let k = 255; k >= 0; k--) {
      sum += hist[k];
      if (sum >= total * 0.12) { high = k; break; }
    }
    // Ảnh đủ sáng (nền giấy >= 115): giữ điểm đen mảnh 0.25% để không làm dính khe số 6 ở xa; ảnh kho lạnh tối (< 115): kéo 2% để nét chữ đen rõ!
    const lowRatio = high < 115 ? 0.02 : 0.0025;
    let low = 30;
    sum = 0;
    for (let k = 0; k < 256; k++) {
      sum += hist[k];
      if (sum >= total * lowRatio) { low = k; break; }
    }
    const span = Math.max(14, high - low);

    for (let i = 0, p = 0; i < lumArr.length; i++, p += 4) {
      const stretched = Math.max(0, Math.min(255, Math.round(((lumArr[i] - low) * 255) / span)));
      d[p] = stretched;
      d[p + 1] = stretched;
      d[p + 2] = stretched;
      d[p + 3] = 255;
    }
    oCtx.putImageData(img, pad, pad);
    return out;
  }

  function flattenIlluminationToCanvas(srcCanvas) {
    const w = srcCanvas.width;
    const h = srcCanvas.height;
    const work = document.createElement('canvas');
    work.width = w;
    work.height = h;
    const ctx = work.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(srcCanvas, 0, 0);
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const gray = new Uint8Array(w * h);
    const stride = w + 1;
    const integral = new Float64Array((w + 1) * (h + 1));

    for (let y = 0; y < h; y++) {
      let rowSum = 0;
      const rowOff = y * w;
      const intOff = (y + 1) * stride;
      const prevIntOff = y * stride;
      for (let x = 0; x < w; x++) {
        const p = (rowOff + x) * 4;
        const g = (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8;
        gray[rowOff + x] = g;
        rowSum += g;
        integral[intOff + x + 1] = integral[prevIntOff + x + 1] + rowSum;
      }
    }

    const R = Math.max(18, Math.round(Math.min(w, h) * 0.09));
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - R);
      const y1 = Math.min(h - 1, y + R);
      const r0 = y0 * stride;
      const r1 = (y1 + 1) * stride;
      const rowOff = y * w;
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - R);
        const x1 = Math.min(w - 1, x + R);
        const count = (x1 - x0 + 1) * (y1 - y0 + 1);
        const sum = integral[r1 + x1 + 1] - integral[r0 + x1 + 1] - integral[r1 + x0] + integral[r0 + x0];
        const localMean = sum / count;
        let v = localMean > 8 ? ((gray[rowOff + x] / localMean) * 250) : 255;
        if (v > 241) {
          v = 255;
        } else {
          v = Math.max(0, Math.min(255, Math.round(((v - 90) * 255) / 151)));
        }
        const p = (rowOff + x) * 4;
        d[p] = v;
        d[p + 1] = v;
        d[p + 2] = v;
        d[p + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    const pad = 24;
    const padded = document.createElement('canvas');
    padded.width = w + pad * 2;
    padded.height = h + pad * 2;
    const pCtx = padded.getContext('2d');
    pCtx.fillStyle = '#ffffff';
    pCtx.fillRect(0, 0, padded.width, padded.height);
    pCtx.drawImage(work, pad, pad);
    return padded;
  }

  function sampleBrightPaperRgb(canvas, cx, cy) {
    try {
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const sx = Math.max(0, Math.min(canvas.width - 14, Math.round(cx - 7)));
      const sy = Math.max(0, Math.min(canvas.height - 1, Math.round(cy)));
      const sw = Math.min(14, canvas.width - sx);
      const strip = ctx.getImageData(sx, sy, Math.max(1, sw), 1).data;
      let bestLum = -1;
      let bestRgb = 'rgb(220,224,228)';
      for (let i = 0; i < strip.length; i += 4) {
        const lum = strip[i] + strip[i + 1] + strip[i + 2];
        if (lum > bestLum) {
          bestLum = lum;
          bestRgb = 'rgb(' + strip[i] + ',' + strip[i + 1] + ',' + strip[i + 2] + ')';
        }
      }
      return bestRgb;
    } catch (e) {
      return 'rgb(220,224,228)';
    }
  }

  function buildRawBarcodeGuidedCropCanvas(fullCanvas, pos, extraDeg) {
    if (!pos || !pos.topLeft || !pos.topRight || !pos.bottomLeft || !pos.bottomRight) {
      return null;
    }
    const dx = pos.topRight.x - pos.topLeft.x;
    const dy = pos.topRight.y - pos.topLeft.y;
    const bw = Math.hypot(dx, dy);
    if (!bw || bw < 26) return null;

    const angle = Math.atan2(dy, dx) + (((extraDeg || 0) * Math.PI) / 180);
    const cx = (pos.topLeft.x + pos.topRight.x + pos.bottomRight.x + pos.bottomLeft.x) / 4;
    const cy = (pos.topLeft.y + pos.topRight.y + pos.bottomRight.y + pos.bottomLeft.y) / 4;

    // Bao trọn vùng NSX & HSD bên trong nền giấy trắng của tem, né sạch cả viền bàn sẫm màu bên dưới lẫn ô mã vuông bên phải!
    const uMin = -0.92 * bw;
    const uSpan = 1.41 * bw;
    const vMin = 0.34 * bw;
    const vSpan = 0.98 * bw;

    // Tỷ lệ vàng 460px chiều ngang sọc (~650x450px vùng chữ): giữ rõ khe hở chữ số 6 ở cự ly xa mà tốc độ đọc chỉ ~0.19s!
    const scale = Math.min(2.8, Math.max(1.05, 460 / bw));
    const outW = Math.max(180, Math.round(uSpan * scale));
    const outH = Math.max(90, Math.round(vSpan * scale));

    const roi = document.createElement('canvas');
    roi.width = outW;
    roi.height = outH;
    const rCtx = roi.getContext('2d', { willReadFrequently: true });
    rCtx.fillStyle = sampleBrightPaperRgb(fullCanvas, cx, cy);
    rCtx.fillRect(0, 0, outW, outH);

    rCtx.save();
    rCtx.scale(scale, scale);
    rCtx.translate(-uMin, -vMin);
    rCtx.rotate(-angle);
    rCtx.translate(-cx, -cy);
    rCtx.drawImage(fullCanvas, 0, 0);
    rCtx.restore();

    return roi;
  }

  function buildFullFrameDateCanvas(fullCanvas, degRotate) {
    const maxDim = 860;
    const scale = Math.min(1.45, maxDim / Math.max(1, Math.max(fullCanvas.width, fullCanvas.height)));
    const w = Math.max(180, Math.round(fullCanvas.width * scale));
    const h = Math.max(100, Math.round(fullCanvas.height * scale));
    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    const ctx = tmp.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    if (degRotate) {
      ctx.translate(w / 2, h / 2);
      ctx.rotate((degRotate * Math.PI) / 180);
      ctx.drawImage(fullCanvas, 0, 0, fullCanvas.width, fullCanvas.height, -w / 2, -h / 2, w, h);
    } else {
      ctx.drawImage(fullCanvas, 0, 0, w, h);
    }
    ctx.restore();
    return flattenIlluminationToCanvas(tmp);
  }

  function mergeDatePair(base, next) {
    return {
      nsx: (base && base.nsx) ? base.nsx : ((next && next.nsx) ? next.nsx : ''),
      hsd: (base && base.hsd) ? base.hsd : ((next && next.hsd) ? next.hsd : '')
    };
  }

  async function runQueuedOcrOnCanvas(worker, fullCanvas, barcodePos, allowTiltedFallback) {
    let best = { nsx: '', hsd: '' };

    // Lượt 1: Cắt gọn & xoay thẳng vùng NSX / HSD theo tọa độ dải mã vạch + giới hạn bảng chữ số ngày (~0.18s)
    if (barcodePos) {
      const rawRoi = buildRawBarcodeGuidedCropCanvas(fullCanvas, barcodePos);
      if (rawRoi) {
        await worker.setParameters({
          tessedit_pageseg_mode: '6',
          tessedit_char_whitelist: '0123456789.:/-NSXHD '
        });
        const softGrayRoi = enhanceSoftGrayscaleCanvas(rawRoi);
        const resSoft = await worker.recognize(softGrayRoi);
        best = mergeDatePair(best, parseOcrNsxHsdText(resSoft && resSoft.data ? resSoft.data.text : ''));
        if (best.nsx && best.hsd) return best;

        await worker.setParameters({
          tessedit_pageseg_mode: '11',
          tessedit_char_whitelist: '0123456789.:/-NSXHD '
        });
        const flatRoi = flattenIlluminationToCanvas(rawRoi);
        const resFlat = await worker.recognize(flatRoi);
        best = mergeDatePair(best, parseOcrNsxHsdText(resFlat && resFlat.data ? resFlat.data.text : ''));
        if (best.nsx && best.hsd) return best;

        // Lượt 1C: Bù độ lệch góc dư ±7° của tia quét ngang 1D khi cầm nghiêng lửng (VD: nghiêng 18° bắt ở lượt 11°)
        const residualAngles = [-7, 7];
        await worker.setParameters({
          tessedit_pageseg_mode: '6',
          tessedit_char_whitelist: '0123456789.:/-NSXHD '
        });
        for (let rIdx = 0; rIdx < residualAngles.length; rIdx++) {
          const adjRoi = buildRawBarcodeGuidedCropCanvas(fullCanvas, barcodePos, residualAngles[rIdx]);
          if (adjRoi) {
            const adjSoft = enhanceSoftGrayscaleCanvas(adjRoi);
            const resAdj = await worker.recognize(adjSoft);
            best = mergeDatePair(best, parseOcrNsxHsdText(resAdj && resAdj.data ? resAdj.data.text : ''));
            if (best.nsx && best.hsd) return best;
          }
        }
      }
    }

    // Lượt 2: Mở lại toàn bộ bảng chữ cái cho khung ảnh rộng (tránh biến chữ tên sản phẩm phía trên thành số ảo!)
    await worker.setParameters({
      tessedit_pageseg_mode: '11',
      tessedit_char_whitelist: ''
    });
    const full0 = buildFullFrameDateCanvas(fullCanvas, 0);
    const resFull0 = await worker.recognize(full0);
    best = mergeDatePair(best, parseOcrNsxHsdText(resFull0 && resFull0.data ? resFull0.data.text : ''));
    if (best.nsx && best.hsd) return best;

    // Lượt 3: Nếu ảnh cầm tay bị nghiêng (10°..22°) mà chưa có tọa độ góc nghiêng từ mã vạch
    if (allowTiltedFallback && (!best.nsx || !best.hsd) && !barcodePos) {
      const angles = [-15, 15];
      for (let i = 0; i < angles.length; i++) {
        const tiltedCanvas = buildFullFrameDateCanvas(fullCanvas, angles[i]);
        const resTilt = await worker.recognize(tiltedCanvas);
        best = mergeDatePair(best, parseOcrNsxHsdText(resTilt && resTilt.data ? resTilt.data.text : ''));
        if (best.nsx && best.hsd) return best;
      }
    }

    return best;
  }

  async function extractNsxHsdWithTimeout(fullCanvas, barcodePos, timeoutMs, allowTiltedFallback) {
    if (!fullCanvas || !window.Tesseract) return { nsx: '', hsd: '' };

    // Chờ nạp bộ đọc chữ lần đầu riêng biệt (tối đa 9 giây nếu sóng 4G yếu lần đầu mở), không để ăn lẹm vào thời gian đọc ảnh!
    const worker = await new Promise(function (resolve) {
      let done = false;
      const wTimer = setTimeout(function () {
        if (!done) { done = true; resolve(null); }
      }, ocrWorkerResolved ? 1500 : 9000);
      warmUpOcrWorker().then(function (w) {
        if (!done) { done = true; clearTimeout(wTimer); resolve(w); }
      }).catch(function () {
        if (!done) { done = true; clearTimeout(wTimer); resolve(null); }
      });
    });
    if (!worker) return { nsx: '', hsd: '' };

    return new Promise(function (resolve) {
      let settled = false;
      const timer = setTimeout(function () {
        if (!settled) {
          settled = true;
          resolve({ nsx: '', hsd: '' });
        }
      }, timeoutMs || 2600);

      ocrQueuePromise = ocrQueuePromise.then(function () {
        if (settled) return { nsx: '', hsd: '' };
        return runQueuedOcrOnCanvas(worker, fullCanvas, barcodePos, Boolean(allowTiltedFallback));
      }).then(function (res) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(res || { nsx: '', hsd: '' });
        }
      }).catch(function () {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ nsx: '', hsd: '' });
        }
      });
    });
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

  function handleBarcodeInput(rawInput, sourceLabel, extractedDates, asyncDateContext) {
    const cleaned = String(rawInput || '').replace(/[\r\n\t\s]+/g, '').trim();
    if (!cleaned) return;

    if (cleaned.length >= 26 && cleaned.length % 13 === 0 && /^\d+$/.test(cleaned)) {
      const count = cleaned.length / 13;
      for (let i = 0; i < count; i++) {
        processSingleBarcode(cleaned.slice(i * 13, (i + 1) * 13), sourceLabel, true, extractedDates, i === count - 1 ? asyncDateContext : null);
      }
      return;
    }

    processSingleBarcode(cleaned, sourceLabel, false, extractedDates, asyncDateContext);
  }

  function processSingleBarcode(bc, sourceLabel, bypassDupGuard, extractedDates, asyncDateContext) {
    const parsed = parseSingle13DigitScaleBarcode(bc);
    if (!parsed.ok) {
      playBeep('error');
      vibrateDevice([120, 60, 120]);
      showBanner('error', parsed.error);
      return;
    }

    // Nếu không có ngày đọc từ ảnh Camera, kiểm tra ô Lô PDA người dùng chủ động nhập (nếu để trống -> trả về '' / '—' chuẩn Fail-Closed)
    const pdaLot = getActivePdaLotDates();
    const nsxVal = normalizeDateVN((extractedDates && extractedDates.nsx) ? extractedDates.nsx : pdaLot.nsx);
    const hsdVal = normalizeDateVN((extractedDates && extractedDates.hsd) ? extractedDates.hsd : pdaLot.hsd);
    const resolvedDates = { nsx: nsxVal, hsd: hsdVal };

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
      pendingDuplicateDates = resolvedDates;
      pendingDuplicateDateCtx = asyncDateContext || null;
      document.getElementById('dupModalBarcode').textContent = bc;
      document.getElementById('dupModalInfo').textContent =
        (parsed.productName || 'Chưa có tên') + ' (' + parsed.productCode + ') — ' + formatKg(parsed.grams) + ' Kg';
      openModal('duplicateModal');
      return;
    }

    commitParsedScan(parsed, resolvedDates, asyncDateContext || null);
  }

  function scheduleSyncFlush(delayMs) {
    if (syncHoldTimer) {
      clearTimeout(syncHoldTimer);
      syncHoldTimer = null;
    }
    if (!delayMs || delayMs <= 0) {
      flushSyncQueue();
      return;
    }
    syncHoldTimer = setTimeout(function () {
      syncHoldTimer = null;
      flushSyncQueue();
    }, delayMs);
  }

  async function fillRecordDatesInBackground(recordId, ctx) {
    if (!recordId || !ctx || !ctx.frameCanvas) return;
    activeDateReadsCount += 1;
    readingDateRecordIds[recordId] = true;
    let collected = { nsx: '', hsd: '' };

    try {
      let pos0 = ctx.barcodePos || null;
      if (!pos0) {
        pos0 = await detectBarcodePositionOnCanvas(ctx.frameCanvas);
      }
      const d0 = await extractNsxHsdWithTimeout(ctx.frameCanvas, pos0, 3400, Boolean(ctx.allowTilt));
      collected = mergeDatePair(collected, d0);

      // Nếu khung đầu bị rung tay nhẹ khi bấm chụp mà Camera vẫn đang mở -> tự lấy thêm tối đa 2 khung sắc nét kế tiếp ở chế độ ngầm!
      if ((!collected.nsx || !collected.hsd) && ctx.liveVideo) {
        for (let f = 0; f < 2; f++) {
          if (!readingDateRecordIds[recordId]) break;
          await new Promise(function (r) { setTimeout(r, 140); });
          if (!cameraActive || !mediaStream || !ctx.liveVideo || ctx.liveVideo.readyState < 2 || ctx.liveVideo.videoWidth <= 0) {
            break;
          }
          const nextCanvas = captureCleanFullVideoCanvas(ctx.liveVideo);
          const nextPos = await detectBarcodePositionOnCanvas(nextCanvas);
          const nextDates = await extractNsxHsdWithTimeout(nextCanvas, nextPos, 3200, f === 1);
          collected = mergeDatePair(collected, nextDates);
          if (collected.nsx && collected.hsd) break;
        }
      }
    } catch (e) {
    } finally {
      delete readingDateRecordIds[recordId];
      activeDateReadsCount = Math.max(0, activeDateReadsCount - 1);
    }

    const rec = records.find(function (r) { return r.id === recordId; });
    if (!rec) {
      renderAll(false);
      scheduleSyncFlush(0);
      return;
    }

    let changed = false;
    const cleanNsx = normalizeDateVN(collected.nsx);
    const cleanHsd = normalizeDateVN(collected.hsd);
    if (!rec.nsx && cleanNsx) {
      rec.nsx = cleanNsx;
      changed = true;
    }
    if (!rec.hsd && cleanHsd) {
      rec.hsd = cleanHsd;
      changed = true;
    }

    if (changed) {
      let patchedInPlace = false;
      if (!syncInProgress) {
        for (let i = pendingOps.length - 1; i >= 0; i--) {
          const op = pendingOps[i];
          if ((op.type === 'add' || op.type === 'update') && op.record && op.record.id === recordId) {
            op.record = toSyncRecord(rec);
            patchedInPlace = true;
            break;
          }
        }
      }
      if (patchedInPlace) {
        persistPendingOps();
      } else {
        enqueueOp({ type: 'update', record: toSyncRecord(rec) });
      }
      persistRecords();

      if (records.length > 0 && records[records.length - 1].id === recordId) {
        showBanner(
          'ok',
          '✅ Đã quét: ' + (rec.productName || ('Mã ' + rec.productCode)) + ' (' + rec.productCode + ') — ' +
          formatKg(rec.grams) + ' Kg | NSX: ' + formatLotDateDisplay(rec.nsx) + ' • HSD: ' + formatLotDateDisplay(rec.hsd)
        );
      }
    }

    renderAll(false);
    scheduleSyncFlush(0);
  }

  function commitParsedScan(parsed, datesObj, asyncDateContext) {
    const now = new Date();
    const nsxClean = (datesObj && datesObj.nsx) ? normalizeDateVN(datesObj.nsx) : '';
    const hsdClean = (datesObj && datesObj.hsd) ? normalizeDateVN(datesObj.hsd) : '';
    const willReadDatesAsync = Boolean(asyncDateContext && asyncDateContext.frameCanvas && (!nsxClean || !hsdClean));

    const record = {
      id: 'scan_' + now.getTime() + '_' + Math.random().toString(36).slice(2, 7),
      scannedAt: formatDateTimeVN(now),
      productCode: parsed.productCode,
      productName: parsed.productName,
      grams: parsed.grams,
      nsx: nsxClean,
      hsd: hsdClean,
      rawBarcode: parsed.rawBarcode,
      note: '',
      edited: false
    };

    if (willReadDatesAsync) {
      readingDateRecordIds[record.id] = true;
    }

    records.push(record);
    lastScannedCode = parsed.rawBarcode;
    lastScannedEpoch = Date.now();

    const kcs = verifyKcsIntegrity();
    if (!kcs.ok) {
      delete readingDateRecordIds[record.id];
      showBanner('error', 'CẢNH BÁO KCS: ' + kcs.error);
      return;
    }

    persistRecords();
    enqueueOp({ type: 'add', record: toSyncRecord(record) });

    const dateSuffix = (nsxClean || hsdClean)
      ? (' | NSX: ' + (nsxClean || '—') + ' • HSD: ' + (hsdClean || '—'))
      : (willReadDatesAsync ? ' • ⏳ Đang tự đọc NSX/HSD...' : '');

    if (parsed.productName === null) {
      playBeep('warn');
      vibrateDevice([80, 40, 80]);
      showBanner('warn', 'Đã ghi nhận mã ' + parsed.productCode + ' (' + formatKg(parsed.grams) + ' Kg' + dateSuffix + ') nhưng chưa có Tên SP. Bấm "Sửa" để đặt tên!');
    } else {
      playBeep('ok');
      vibrateDevice([45]);
      showBanner('ok', '✅ Đã quét: ' + parsed.productName + ' (' + parsed.productCode + ') — ' + formatKg(parsed.grams) + ' Kg' + dateSuffix);
    }

    renderAll(true);

    if (willReadDatesAsync) {
      // Giữ nhịp đẩy 0.36s để gộp gọn NSX/HSD (~0.18s) vào chung 1 gói tin đẩy lên Google Sheet!
      scheduleSyncFlush(360);
      fillRecordDatesInBackground(record.id, asyncDateContext);
    } else {
      scheduleSyncFlush(0);
    }
  }

  function toSyncRecord(r) {
    return {
      id: r.id,
      scannedAt: r.scannedAt,
      productCode: r.productCode,
      productName: r.productName ? r.productName : '—',
      grams: r.grams,
      weightKg: r.grams / 1000,
      nsx: normalizeDateVN(r.nsx) || '',
      hsd: normalizeDateVN(r.hsd) || '',
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
          grams: 0,
          lots: {}
        };
      }
      if (!byCode[code].name && r.productName) {
        byCode[code].name = r.productName;
      }
      if (r.nsx || r.hsd) {
        const lotKey = formatLotDateDisplay(r.nsx) + ' → ' + formatLotDateDisplay(r.hsd);
        byCode[code].lots[lotKey] = true;
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

    const readingNow = Boolean(readingDateRecordIds[latest.id]);
    const dispNsx = latest.nsx ? formatLotDateDisplay(latest.nsx) : (readingNow ? '⏳ Đang đọc...' : '—');
    const dispHsd = latest.hsd ? formatLotDateDisplay(latest.hsd) : (readingNow ? '⏳ Đang đọc...' : '—');

    document.getElementById('latestCode').textContent = latest.productCode || '—';
    document.getElementById('latestWeight').textContent = formatKg(latest.grams) + ' Kg';
    document.getElementById('latestNsx').textContent = dispNsx;
    document.getElementById('latestHsd').textContent = dispHsd;
    document.getElementById('latestBarcode').textContent =
      'Mã vạch: ' + (latest.rawBarcode || 'Nhập thủ công') + (latest.note ? ' • ' + latest.note : '');

    document.getElementById('btnEditLatest').onclick = function () {
      openEditModal(latest.id);
    };
    document.getElementById('btnDeleteLatest').onclick = function () {
      confirmDeleteRecord(latest.id);
    };
    const btnScanDates = document.getElementById('btnScanDatesLatest');
    if (btnScanDates) {
      btnScanDates.onclick = function () {
        dateOnlyTarget = 'latest';
        document.getElementById('hiddenDateOnlyImageInput').click();
      };
    }

    if (liveHud) {
      document.getElementById('hudTopMeta').textContent =
        '✅ Đã quét • Tổng: ' + formatInt(m.totalScans) + ' tem | ' + formatInt(m.totalProducts) + ' SP | ' + formatKg(m.totalGrams) + ' Kg';
      document.getElementById('hudProductName').textContent =
        (latest.productName ? latest.productName : '— Chưa có tên') + ' (' + (latest.productCode || '—') + ')';
      const hudDatesEl = document.getElementById('hudLotDates');
      if (hudDatesEl) {
        hudDatesEl.textContent = 'NSX: ' + dispNsx + ' • HSD: ' + dispHsd;
      }
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
        String(r.nsx || '').toLowerCase().indexOf(query) !== -1 ||
        String(r.hsd || '').toLowerCase().indexOf(query) !== -1 ||
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
    const readingRowNow = Boolean(readingDateRecordIds[r.id]);
    const nsxDisp = r.nsx ? formatLotDateDisplay(r.nsx) : (readingRowNow ? '⏳ Đang đọc...' : '—');
    const hsdDisp = r.hsd ? formatLotDateDisplay(r.hsd) : (readingRowNow ? '⏳ Đang đọc...' : '—');
    const lotLine = (
      '<div class="scan-lot-badge">📅 NSX: ' + escapeHtml(nsxDisp) + ' • HSD: ' + escapeHtml(hsdDisp) + '</div>'
    );
    return (
      '<div class="scan-row-card' + (r.edited ? ' edited' : '') + '">' +
        '<div class="scan-row-left">' +
          '<div class="scan-row-top">' +
            '<strong>#' + orderNum + '</strong>' +
            '<span class="code-chip">' + escapeHtml(r.productCode || '—') + '</span>' +
            '<span>' + escapeHtml(r.scannedAt) + '</span>' +
          '</div>' +
          '<div class="scan-row-name">' + dispName + '</div>' +
          lotLine +
          '<div style="font-size:11.5px;color:#64748b;margin-top:2px;">' +
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
      const lotKeys = Object.keys(g.lots || {});
      const lotSub = lotKeys.length > 0
        ? ('<div style="font-size:11.5px;color:#0369a1;font-weight:600;margin-top:2px;">📅 ' + escapeHtml(lotKeys.join('; ')) + '</div>')
        : '';
      html += (
        '<tr>' +
          '<td><span class="code-chip">' + escapeHtml(g.code) + '</span></td>' +
          '<td style="font-weight:700;">' + dispName + lotSub + '</td>' +
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
      const pdaLot = getActivePdaLotDates();
      document.getElementById('editCodeInput').value = '';
      document.getElementById('editNameInput').value = '';
      document.getElementById('editWeightInput').value = '';
      document.getElementById('editNsxInput').value = pdaLot.nsx || '';
      document.getElementById('editHsdInput').value = pdaLot.hsd || '';
      document.getElementById('editNoteInput').value = 'Nhập bổ sung thủ công';
      document.getElementById('btnModalDelete').style.display = 'none';
    } else {
      const rec = records.find(function (r) { return r.id === recordId; });
      if (!rec) return;
      document.getElementById('editCodeInput').value = rec.productCode || '';
      document.getElementById('editNameInput').value = rec.productName || '';
      document.getElementById('editWeightInput').value = (rec.grams / 1000).toFixed(3);
      document.getElementById('editNsxInput').value = normalizeDateVN(rec.nsx) || '';
      document.getElementById('editHsdInput').value = normalizeDateVN(rec.hsd) || '';
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
    const rawNsx = String(document.getElementById('editNsxInput').value || '').trim();
    const rawHsd = String(document.getElementById('editHsdInput').value || '').trim();
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

    const cleanNsx = normalizeDateVN(rawNsx);
    if (rawNsx !== '' && rawNsx !== '—' && !cleanNsx) {
      alert('Ngày sản xuất (NSX) chưa đúng định dạng ngày/tháng/năm (ví dụ: 12/11/2026).');
      return;
    }
    const cleanHsd = normalizeDateVN(rawHsd);
    if (rawHsd !== '' && rawHsd !== '—' && !cleanHsd) {
      alert('Hạn sử dụng (HSD) chưa đúng định dạng ngày/tháng/năm (ví dụ: 15/11/2026).');
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
        nsx: cleanNsx,
        hsd: cleanHsd,
        rawBarcode: '',
        note: note || 'Nhập thủ công',
        edited: true
      };
      records.push(newRec);
      enqueueOp({ type: 'add', record: toSyncRecord(newRec) });
    } else {
      const idx = records.findIndex(function (r) { return r.id === id; });
      if (idx === -1) return;
      delete readingDateRecordIds[id];
      records[idx].productCode = code;
      records[idx].productName = finalName;
      records[idx].grams = grams;
      records[idx].nsx = cleanNsx;
      records[idx].hsd = cleanHsd;
      records[idx].note = note || 'Đã chỉnh sửa';
      records[idx].edited = true;
      enqueueOp({ type: 'update', record: toSyncRecord(records[idx]) });
    }

    persistRecords();
    closeModal('editModal');
    renderAll(true);
    showBanner('ok', 'Đã cập nhật số liệu (gồm NSX/HSD) và đồng bộ lên Google Sheet!');
    flushSyncQueue();
  }

  function confirmDeleteRecord(recordId) {
    const rec = records.find(function (r) { return r.id === recordId; });
    if (!rec) return;
    const label = (rec.productName || 'Mã ' + rec.productCode) + ' (' + formatKg(rec.grams) + ' Kg)';
    if (!confirm('Xóa dòng quét: ' + label + '?\nTổng số tem, số sản phẩm và số ký sẽ tự động trừ lại tương ứng.')) {
      return;
    }
    delete readingDateRecordIds[recordId];
    records = records.filter(function (r) { return r.id !== recordId; });
    persistRecords();
    enqueueOp({ type: 'delete', id: recordId });
    renderAll(false);
    showBanner('ok', 'Đã xóa dòng "' + label + '" và tính lại tổng tồn!');
    flushSyncQueue();
  }

  // =========================================================================
  // UNIVERSAL CAMERA 1D SCANNER + AUTOMATIC NSX/HSD EXTRACTION
  // =========================================================================
  async function requestUniversalCameraStream() {
    const constraintsList = [
      {
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 2560 },
          height: { ideal: 1440 },
          frameRate: { ideal: 30 }
        }
      },
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
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
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
        if (err && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')) {
          throw err;
        }
      }
    }
    throw lastErr || new Error('Thiết bị không có Camera khả dụng');
  }

  function refreshAutoSnapBtnUI() {
    const btn = document.getElementById('btnToggleAutoSnap');
    if (!btn) return;
    const isOn = Boolean(settings.autoSnapCamera);
    btn.classList.toggle('active', isOn);
    btn.textContent = isOn ? '⚡ Tự chốt: BẬT' : '⚡ Tự chốt: TẮT';
  }

  async function triggerCameraRefocus() {
    if (!mediaStream) return;
    const track = mediaStream.getVideoTracks()[0];
    if (!track || !track.getCapabilities || !track.applyConstraints) return;
    try {
      const caps = track.getCapabilities();
      if (caps.focusMode) {
        if (caps.focusMode.indexOf('single-shot') !== -1) {
          await track.applyConstraints({ advanced: [{ focusMode: 'single-shot' }] });
          setTimeout(function () {
            if (caps.focusMode.indexOf('continuous') !== -1) {
              track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(function () {});
            }
          }, 420);
        } else if (caps.focusMode.indexOf('continuous') !== -1) {
          await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
        }
      }
    } catch (e) {}
  }

  async function startCamera1DScanner() {
    stopCamera1DScanner();
    const statusEl = document.getElementById('cameraStatusBadge');
    const httpsPrompt = document.getElementById('httpsUpgradePrompt');
    const viewportBox = document.getElementById('cameraViewportBox');

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
    warmUpOcrWorker();

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
      statusEl.textContent = 'Đang khởi động Camera độ nét cao...';
      mediaStream = await requestUniversalCameraStream();

      const video = document.getElementById('cameraVideo');
      video.setAttribute('playsinline', 'true');
      video.setAttribute('webkit-playsinline', 'true');
      video.muted = true;
      video.srcObject = mediaStream;
      await video.play();

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
          if (caps.whiteBalanceMode && caps.whiteBalanceMode.indexOf('continuous') !== -1) {
            adv.whiteBalanceMode = 'continuous';
          }
          if (caps.zoom && caps.zoom.max >= 1.4) {
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
      livePreLock = null;
      setShutterUIState('ready');
      startLivePreLockLoop();
    } catch (err) {
      statusEl.textContent = 'Chưa mở được Camera trực tiếp (' + (err.message || err) + '). Bấm nút tròn để chụp ảnh tem!';
    }
  }

  function setShutterUIState(mode, customText) {
    const viewportBox = document.getElementById('cameraViewportBox');
    const statusEl = document.getElementById('cameraStatusBadge');
    const iconEl = document.getElementById('shutterIcon');
    const textEl = document.getElementById('shutterText');
    if (!viewportBox || !statusEl || !iconEl || !textEl) return;

    viewportBox.classList.remove('is-scanning', 'is-captured');
    if (mode !== 'ready') {
      viewportBox.classList.remove('is-prelocked');
    }
    if (mode === 'scanning') {
      viewportBox.classList.add('is-scanning');
      iconEl.textContent = '🎯';
      textEl.textContent = 'SIÊU TỐC';
      statusEl.textContent = customText || '⚡ Đang bắt nét dải mã vạch sọc...';
    } else if (mode === 'captured') {
      viewportBox.classList.add('is-captured');
      iconEl.textContent = '✅';
      textEl.textContent = 'XONG';
      statusEl.textContent = customText || '✅ Đã chốt tức thì! Đổi sang tem kế tiếp';
    } else {
      iconEl.textContent = '📸';
      textEl.textContent = 'QUÉT';
      statusEl.textContent = settings.autoSnapCamera
        ? '⚡ Tự chốt đang BẬT: Đưa tem vào khung là máy tự quét luôn!'
        : '👆 Đưa tem vào khung → Bấm nút tròn chốt tức thì (tự đọc NSX/HSD ngầm)';
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
    video.style.transform = currentZoom > 1 ? ('scale(' + currentZoom + ')') : 'none';
  }

  function onShutterScanClick() {
    if (Date.now() < shutterLockUntil) return;

    if (!cameraActive || !mediaStream) {
      document.getElementById('hiddenImageInput').click();
      return;
    }

    if (singleScanActive) {
      singleScanActive = false;
      singleScanToken += 1;
      setShutterUIState('ready');
      return;
    }

    runSingleShotCameraScan();
  }

  function captureCleanFullVideoCanvas(video) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const maxDim = 1480;
    const scale = Math.min(1, maxDim / Math.max(1, Math.max(vw, vh)));
    const ow = Math.max(200, Math.round(vw * scale));
    const oh = Math.max(150, Math.round(vh * scale));
    const c = document.createElement('canvas');
    c.width = ow;
    c.height = oh;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, vw, vh, 0, 0, ow, oh);
    return c;
  }

  function getVisibleAimRectInVideo(video, expandFrac) {
    const vw = video.videoWidth || 1280;
    const vh = video.videoHeight || 720;
    const viewportBox = document.getElementById('cameraViewportBox');
    const aimBox = viewportBox ? viewportBox.querySelector('.barcode-aim-box') : null;
    if (!viewportBox || !aimBox) {
      return {
        sx: Math.floor(vw * 0.04),
        sy: Math.floor(vh * 0.05),
        sw: Math.floor(vw * 0.92),
        sh: Math.floor(vh * 0.90)
      };
    }
    const vpRect = viewportBox.getBoundingClientRect();
    const aimRect = aimBox.getBoundingClientRect();
    if (vpRect.width < 40 || vpRect.height < 40 || aimRect.width < 30 || aimRect.height < 30) {
      return {
        sx: Math.floor(vw * 0.04),
        sy: Math.floor(vh * 0.05),
        sw: Math.floor(vw * 0.92),
        sh: Math.floor(vh * 0.90)
      };
    }

    const softZoom = (!hardwareZoomSupported && currentZoom > 1) ? currentZoom : 1;
    const coverScale = Math.max(vpRect.width / vw, vpRect.height / vh) * softZoom;
    const renderedW = vw * coverScale;
    const renderedH = vh * coverScale;
    const offsetX = (renderedW - vpRect.width) / 2;
    const offsetY = (renderedH - vpRect.height) / 2;

    const relLeft = aimRect.left - vpRect.left;
    const relTop = aimRect.top - vpRect.top;

    let sx = (offsetX + relLeft) / coverScale;
    let sy = (offsetY + relTop) / coverScale;
    let sw = aimRect.width / coverScale;
    let sh = aimRect.height / coverScale;

    const margin = typeof expandFrac === 'number' ? expandFrac : 0.08;
    const mx = sw * margin;
    const my = sh * margin;
    sx = Math.max(0, Math.floor(sx - mx));
    sy = Math.max(0, Math.floor(sy - my));
    sw = Math.min(vw - sx, Math.ceil(sw + mx * 2));
    sh = Math.min(vh - sy, Math.ceil(sh + my * 2));

    if (sw < 120 || sh < 80) {
      return {
        sx: Math.floor(vw * 0.04),
        sy: Math.floor(vh * 0.05),
        sw: Math.floor(vw * 0.92),
        sh: Math.floor(vh * 0.90)
      };
    }
    return { sx: sx, sy: sy, sw: sw, sh: sh };
  }

  // Làm nét vạch sọc 1D chuyên dụng: Chỉ đo dải sáng 2%..98% trên điểm ảnh thật (alpha >= 200, loại trừ hoàn toàn viền xoay góc!),
  // kéo tương phản cực đại cho kho lạnh tối + làm sắc cạnh ngang + phủ viền trắng tĩnh (Quiet Zone)
  function sharpen1DBarsInPlace(imgData) {
    const w = imgData.width;
    const h = imgData.height;
    const d = imgData.data;
    if (w < 40 || h < 20) return imgData;

    const hist = new Uint32Array(256);
    let opaqueCount = 0;
    const totalPx = w * h;
    const lumBuf = new Uint8Array(totalPx);
    const opaqueBuf = new Uint8Array(totalPx);

    for (let i = 0, p = 0; i < totalPx; i++, p += 4) {
      if (d[p + 3] >= 200) {
        const g = (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8;
        lumBuf[i] = g;
        opaqueBuf[i] = 1;
        hist[g] += 1;
        opaqueCount += 1;
      }
    }

    if (opaqueCount < 200) return imgData;

    let acc = 0;
    let high = 242;
    const highTarget = opaqueCount * 0.01;
    for (let k = 255; k >= 0; k--) {
      acc += hist[k];
      if (acc >= highTarget) { high = k; break; }
    }
    // Nếu ảnh kho lạnh thiếu sáng (nền giấy tối < 115) thì giữ điểm đen sâu 0.2%; nếu đủ sáng thì kéo sát 2% để vạch sọc đen tuyền sắc nét!
    const lowTarget = opaqueCount * (high < 115 ? 0.002 : 0.02);
    let low = 2;
    acc = 0;
    for (let k = 0; k < 256; k++) {
      acc += hist[k];
      if (acc >= lowTarget) { low = k; break; }
    }
    const span = Math.max(12, high - low);
    const rowStretched = new Uint8Array(w);

    for (let y = 0; y < h; y++) {
      const rowOff = y * w;
      for (let x = 0; x < w; x++) {
        const idx = rowOff + x;
        if (opaqueBuf[idx]) {
          const v = Math.round(((lumBuf[idx] - low) * 255) / span);
          rowStretched[x] = v < 0 ? 0 : (v > 255 ? 255 : v);
        } else {
          rowStretched[x] = 255;
        }
      }

      let p = rowOff * 4;
      for (let x = 0; x < w; x++, p += 4) {
        const idx = rowOff + x;
        if (!opaqueBuf[idx]) {
          d[p] = 255;
          d[p + 1] = 255;
          d[p + 2] = 255;
          d[p + 3] = 255;
        } else if (x === 0 || x === w - 1 || !opaqueBuf[idx - 1] || !opaqueBuf[idx + 1]) {
          const sv = rowStretched[x];
          d[p] = sv;
          d[p + 1] = sv;
          d[p + 2] = sv;
          d[p + 3] = 255;
        } else {
          const sharp = Math.round(rowStretched[x] * 1.56 - (rowStretched[x - 1] + rowStretched[x + 1]) * 0.28);
          const clamped = sharp < 0 ? 0 : (sharp > 255 ? 255 : sharp);
          d[p] = clamped;
          d[p + 1] = clamped;
          d[p + 2] = clamped;
          d[p + 3] = 255;
        }
      }
    }

    return imgData;
  }

  function mapPointFromCropToFull(pt, dw, dh, angleDeg, cropX, cropY, cropW, cropH, vw, vh, ow, oh, padPx) {
    const pad = padPx || 0;
    let px = pt.x - pad;
    let py = pt.y - pad;
    if (angleDeg !== 0) {
      const rad = (-angleDeg * Math.PI) / 180;
      const dx = px - dw / 2;
      const dy = py - dh / 2;
      px = dx * Math.cos(rad) - dy * Math.sin(rad) + dw / 2;
      py = dx * Math.sin(rad) + dy * Math.cos(rad) + dh / 2;
    }
    const vx = cropX + (px / dw) * cropW;
    const vy = cropY + (py / dh) * cropH;
    return {
      x: (vx / vw) * ow,
      y: (vy / vh) * oh
    };
  }

  function mapPositionToTargetCanvas(pos, dw, dh, angleDeg, cropX, cropY, cropW, cropH, srcW, srcH, outW, outH, padPx) {
    if (!pos || !pos.topLeft || !pos.topRight || !pos.bottomLeft || !pos.bottomRight) return null;
    return {
      topLeft: mapPointFromCropToFull(pos.topLeft, dw, dh, angleDeg, cropX, cropY, cropW, cropH, srcW, srcH, outW, outH, padPx),
      topRight: mapPointFromCropToFull(pos.topRight, dw, dh, angleDeg, cropX, cropY, cropW, cropH, srcW, srcH, outW, outH, padPx),
      bottomRight: mapPointFromCropToFull(pos.bottomRight, dw, dh, angleDeg, cropX, cropY, cropW, cropH, srcW, srcH, outW, outH, padPx),
      bottomLeft: mapPointFromCropToFull(pos.bottomLeft, dw, dh, angleDeg, cropX, cropY, cropW, cropH, srcW, srcH, outW, outH, padPx)
    };
  }

  function convertCornerPointsToPos(corners, scaleX, scaleY) {
    if (!Array.isArray(corners) || corners.length < 4) return null;
    const sx = scaleX || 1;
    const sy = scaleY || 1;
    return {
      topLeft: { x: corners[0].x * sx, y: corners[0].y * sy },
      topRight: { x: corners[1].x * sx, y: corners[1].y * sy },
      bottomRight: { x: corners[2].x * sx, y: corners[2].y * sy },
      bottomLeft: { x: corners[3].x * sx, y: corners[3].y * sy }
    };
  }

  async function tryDecodeRegionOnCanvas(workCanvas, workCtx, src, sx, sy, sw, sh, angleDeg, maxDim, padPx, doSharpen, useNative, needPosOnly) {
    const ratio = Math.min(1, (maxDim || 1900) / Math.max(1, Math.max(sw, sh)));
    const dw = Math.max(180, Math.round(sw * ratio));
    const dh = Math.max(110, Math.round(sh * ratio));
    const pad = padPx || 22;
    const tw = dw + pad * 2;
    const th = dh + pad * 2;

    workCanvas.width = tw;
    workCanvas.height = th;
    if (doSharpen) {
      workCtx.clearRect(0, 0, tw, th);
    } else {
      workCtx.fillStyle = '#ffffff';
      workCtx.fillRect(0, 0, tw, th);
    }

    workCtx.save();
    workCtx.translate(tw / 2, th / 2);
    if (angleDeg !== 0) {
      workCtx.rotate((angleDeg * Math.PI) / 180);
    }
    workCtx.drawImage(src, sx, sy, sw, sh, -dw / 2, -dh / 2, dw, dh);
    workCtx.restore();

    if (useNative && nativeDetector && angleDeg === 0 && !doSharpen) {
      try {
        const natHits = await nativeDetector.detect(workCanvas);
        if (natHits && natHits.length > 0) {
          for (let k = 0; k < natHits.length; k++) {
            const rawV = String(natHits[k].rawValue || '').trim();
            if (parseSingle13DigitScaleBarcode(rawV).ok) {
              return {
                code: rawV,
                posOnWork: convertCornerPointsToPos(natHits[k].cornerPoints, 1, 1),
                dw: dw,
                dh: dh,
                pad: pad
              };
            }
          }
        }
      } catch (e) {}
    }

    const imgData = workCtx.getImageData(0, 0, tw, th);
    if (doSharpen) {
      sharpen1DBarsInPlace(imgData);
    }

    if (window.ZXingWASM && window.ZXingWASM.readBarcodesFromImageData) {
      try {
        const opts = doSharpen ? WASM_1D_LOCAL_OPTIONS : WASM_1D_FAST_OPTIONS;
        const hits = await window.ZXingWASM.readBarcodesFromImageData(imgData, opts);
        if (hits && hits.length > 0) {
          for (let k = 0; k < hits.length; k++) {
            const txt = String(hits[k].text || '').trim();
            if (parseSingle13DigitScaleBarcode(txt).ok) {
              return {
                code: txt,
                posOnWork: hits[k].position || null,
                dw: dw,
                dh: dh,
                pad: pad
              };
            }
          }
          if (hits[0].text) {
            return {
              code: String(hits[0].text).trim(),
              posOnWork: hits[0].position || null,
              dw: dw,
              dh: dh,
              pad: pad,
              unverified: true
            };
          }
        }
      } catch (e) {}
    }

    if (needPosOnly) return null;

    const jsHit = decodeEan13PureJsFromImageData(imgData);
    if (jsHit) {
      return {
        code: jsHit,
        posOnWork: null,
        dw: dw,
        dh: dh,
        pad: pad
      };
    }

    return null;
  }

  async function detectBarcodePositionOnCanvas(canvas) {
    if (!canvas || !window.ZXingWASM || !window.ZXingWASM.readBarcodesFromImageData) return null;
    const cw = canvas.width;
    const ch = canvas.height;
    const rotCanvas = document.createElement('canvas');
    const rotCtx = rotCanvas.getContext('2d', { willReadFrequently: true });
    const plans = [
      { crop: 1.0, deg: 0, sharp: false },
      { crop: 1.0, deg: 0, sharp: true },
      { crop: 0.56, deg: 0, sharp: true },
      { crop: 1.0, deg: -11, sharp: true },
      { crop: 1.0, deg: 11, sharp: true },
      { crop: 0.58, deg: -12, sharp: true },
      { crop: 0.58, deg: 12, sharp: true },
      { crop: 1.0, deg: -19, sharp: true },
      { crop: 1.0, deg: 19, sharp: true },
      { crop: 1.0, deg: -32, sharp: true },
      { crop: 1.0, deg: 32, sharp: true },
      { crop: 1.0, deg: 90, sharp: true }
    ];

    for (let i = 0; i < plans.length; i++) {
      const p = plans[i];
      const sw = Math.max(120, Math.round(cw * p.crop));
      const sh = Math.max(90, Math.round(ch * p.crop));
      const sx = Math.round((cw - sw) / 2);
      const sy = Math.round((ch - sh) / 2);
      try {
        const hit = await tryDecodeRegionOnCanvas(
          rotCanvas, rotCtx, canvas, sx, sy, sw, sh, p.deg, 1850, 22, p.sharp, false, true
        );
        if (hit && hit.posOnWork) {
          return mapPositionToTargetCanvas(
            hit.posOnWork, hit.dw, hit.dh, p.deg, sx, sy, sw, sh, cw, ch, cw, ch, hit.pad
          );
        }
      } catch (e) {}
    }
    return null;
  }

  function startLivePreLockLoop() {
    const myLoopId = ++radarLoopId;
    const video = document.getElementById('cameraVideo');
    const workCanvas = document.createElement('canvas');
    const workCtx = workCanvas.getContext('2d', { willReadFrequently: true });
    let tick = 0;

    async function step() {
      if (!cameraActive || !mediaStream || radarLoopId !== myLoopId) return;

      if (!singleScanActive && video && video.readyState >= 2 && video.videoWidth > 0) {
        tick += 1;
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        let foundCode = null;
        let foundParsed = null;
        let foundPosInVideo = null;

        // 1. Thử bộ giải mã phần cứng trực tiếp trên luồng hình gốc (~3ms)
        if (nativeDetector) {
          try {
            const vHits = await nativeDetector.detect(video);
            if (vHits && vHits.length > 0) {
              for (let k = 0; k < vHits.length; k++) {
                const raw = String(vHits[k].rawValue || '').trim();
                const chk = parseSingle13DigitScaleBarcode(raw);
                if (chk.ok) {
                  foundCode = raw;
                  foundParsed = chk;
                  foundPosInVideo = convertCornerPointsToPos(vHits[k].cornerPoints, 1, 1);
                  break;
                }
              }
            }
          } catch (e) {}
        }

        // 2. Xoay vòng quét độ phân giải gốc 1:1 (cận cảnh, cự ly xa 45cm, thiếu sáng, cầm nghiêng)
        if (!foundCode && cameraActive && !singleScanActive && radarLoopId === myLoopId) {
          const vis = getVisibleAimRectInVideo(video, 0.08);
          const alreadyLockedFresh = Boolean(livePreLock && (Date.now() - livePreLock.lockedAt) < 420);
          const modeIdx = alreadyLockedFresh ? (tick % 2) : (tick % 5);
          let rx = vis.sx;
          let ry = vis.sy;
          let rw = vis.sw;
          let rh = vis.sh;
          let deg = 0;
          let doSharp = true;

          if (modeIdx === 0) {
            doSharp = false;
          } else if (modeIdx === 2) {
            // Phóng tâm quang học giữ nguyên điểm ảnh gốc cho tem đặt ở xa 35-50cm
            rw = Math.max(180, Math.round(vis.sw * 0.56));
            rh = Math.max(120, Math.round(vis.sh * 0.56));
            rx = vis.sx + Math.round((vis.sw - rw) / 2);
            ry = vis.sy + Math.round((vis.sh - rh) / 2);
          } else if (modeIdx === 3) {
            deg = -11;
          } else if (modeIdx === 4) {
            deg = 11;
          }

          const hit = await tryDecodeRegionOnCanvas(
            workCanvas, workCtx, video, rx, ry, rw, rh, deg, 1650, 22, doSharp, false
          );
          if (hit && hit.code) {
            const chk = parseSingle13DigitScaleBarcode(hit.code);
            if (chk.ok) {
              foundCode = hit.code;
              foundParsed = chk;
              if (hit.posOnWork) {
                foundPosInVideo = mapPositionToTargetCanvas(
                  hit.posOnWork, hit.dw, hit.dh, deg, rx, ry, rw, rh, vw, vh, vw, vh, hit.pad
                );
              }
            }
          }
        }

        if (foundCode && foundParsed && cameraActive && !singleScanActive && radarLoopId === myLoopId) {
          const snapCanvas = captureCleanFullVideoCanvas(video);
          const mappedPos = foundPosInVideo
            ? convertCornerPointsToPos(
                [foundPosInVideo.topLeft, foundPosInVideo.topRight, foundPosInVideo.bottomRight, foundPosInVideo.bottomLeft],
                snapCanvas.width / vw,
                snapCanvas.height / vh
              )
            : null;

          livePreLock = {
            code: foundCode,
            parsed: foundParsed,
            frameCanvas: snapCanvas,
            barcodePos: mappedPos,
            lockedAt: Date.now()
          };

          const viewportBox = document.getElementById('cameraViewportBox');
          const statusEl = document.getElementById('cameraStatusBadge');

          if (
            settings.autoSnapCamera &&
            Date.now() >= shutterLockUntil &&
            !(foundCode === lastAutoSnappedCode && (Date.now() - lastAutoSnappedEpoch) < 4200)
          ) {
            lastAutoSnappedCode = foundCode;
            lastAutoSnappedEpoch = Date.now();
            shutterLockUntil = Date.now() + 650;
            const snapUse = livePreLock;
            livePreLock = null;
            setShutterUIState(
              'captured',
              '⚡ Tự chốt: ' + (foundParsed.productName || foundParsed.productCode) + ' (' + formatKg(foundParsed.grams) + ' Kg)'
            );
            handleBarcodeInput(snapUse.code, 'Camera Auto', null, {
              frameCanvas: snapUse.frameCanvas,
              barcodePos: snapUse.barcodePos,
              liveVideo: video,
              allowTilt: true
            });
            setTimeout(function () {
              if (!singleScanActive && cameraActive) {
                setShutterUIState('ready');
              }
            }, 620);
          } else if (viewportBox && statusEl && !viewportBox.classList.contains('is-captured')) {
            viewportBox.classList.add('is-prelocked');
            statusEl.textContent =
              '🟢 Đã bắt nét: ' + (foundParsed.productName || ('Mã ' + foundParsed.productCode)) +
              ' (' + formatKg(foundParsed.grams) + ' Kg) — Bấm nút tròn chốt ngay!';
          }
        } else if (livePreLock && (Date.now() - livePreLock.lockedAt) > 680) {
          livePreLock = null;
          const viewportBox = document.getElementById('cameraViewportBox');
          if (viewportBox && viewportBox.classList.contains('is-prelocked')) {
            viewportBox.classList.remove('is-prelocked');
            if (!singleScanActive && !viewportBox.classList.contains('is-captured')) {
              setShutterUIState('ready');
            }
          }
        }
      }

      if (cameraActive && mediaStream && radarLoopId === myLoopId) {
        setTimeout(step, 85);
      }
    }

    setTimeout(step, 60);
  }

  async function runSingleShotCameraScan() {
    if (!cameraActive || !mediaStream) return;
    const video = document.getElementById('cameraVideo');

    // Chốt 0.00 giây nếu bộ bắt nét ngầm đã khóa sẵn mã hợp lệ trong 0.68 giây gần nhất!
    if (livePreLock && (Date.now() - livePreLock.lockedAt) <= 680) {
      const snap = livePreLock;
      livePreLock = null;
      shutterLockUntil = Date.now() + 180;
      setShutterUIState('captured');
      handleBarcodeInput(snap.code, 'Camera', null, {
        frameCanvas: snap.frameCanvas,
        barcodePos: snap.barcodePos,
        liveVideo: video,
        allowTilt: true
      });
      setTimeout(function () {
        if (!singleScanActive && cameraActive) {
          setShutterUIState('ready');
        }
      }, 550);
      return;
    }

    const myToken = ++singleScanToken;
    singleScanActive = true;
    setShutterUIState('scanning');

    const workCanvas = document.createElement('canvas');
    const workCtx = workCanvas.getContext('2d', { willReadFrequently: true });

    const deadline = Date.now() + 1450;
    let attempt = 0;
    let lastInvalidError = null;

    // 10 cấu hình quét siêu tốc giữ trọn độ phân giải cảm biến: tâm chuẩn, tăng nét thiếu sáng, phóng xa 48%, toàn khung, nghiêng ±10°, ±21°, ±34°, dọc 90°
    const sweepPlan = [
      { mode: 'aim', deg: 0, sharp: false, nativeFirst: true },
      { mode: 'aim', deg: 0, sharp: true, nativeFirst: false },
      { mode: 'zoom', deg: 0, sharp: true, nativeFirst: false },
      { mode: 'full', deg: 0, sharp: true, nativeFirst: true },
      { mode: 'aim', deg: -10, sharp: true, nativeFirst: false },
      { mode: 'aim', deg: 10, sharp: true, nativeFirst: false },
      { mode: 'aim', deg: -21, sharp: true, nativeFirst: false },
      { mode: 'aim', deg: 21, sharp: true, nativeFirst: false },
      { mode: 'full', deg: -34, sharp: true, nativeFirst: false },
      { mode: 'full', deg: 34, sharp: true, nativeFirst: false },
      { mode: 'full', deg: 90, sharp: true, nativeFirst: false }
    ];

    while (singleScanActive && cameraActive && mediaStream && singleScanToken === myToken && Date.now() < deadline) {
      if (video && video.readyState >= 2 && video.videoWidth > 0) {
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        const cfg = sweepPlan[attempt % sweepPlan.length];
        attempt += 1;

        let candidate = null;
        let posInVideo = null;

        if (cfg.nativeFirst && nativeDetector && cfg.deg === 0) {
          try {
            const vHits = await nativeDetector.detect(video);
            if (vHits && vHits.length > 0 && vHits[0].rawValue) {
              candidate = String(vHits[0].rawValue).trim();
              posInVideo = convertCornerPointsToPos(vHits[0].cornerPoints, 1, 1);
            }
          } catch (e) {}
        }

        if (!candidate) {
          const vis = getVisibleAimRectInVideo(video, 0.10);
          let sx = vis.sx;
          let sy = vis.sy;
          let sw = vis.sw;
          let sh = vis.sh;

          if (cfg.mode === 'zoom') {
            sw = Math.max(180, Math.round(vis.sw * 0.50));
            sh = Math.max(120, Math.round(vis.sh * 0.50));
            sx = vis.sx + Math.round((vis.sw - sw) / 2);
            sy = vis.sy + Math.round((vis.sh - sh) / 2);
          } else if (cfg.mode === 'full') {
            sx = 0;
            sy = 0;
            sw = vw;
            sh = vh;
          }

          const hit = await tryDecodeRegionOnCanvas(
            workCanvas, workCtx, video, sx, sy, sw, sh, cfg.deg, 1850, 24, cfg.sharp, false
          );
          if (hit && hit.code) {
            candidate = hit.code;
            if (hit.posOnWork) {
              posInVideo = mapPositionToTargetCanvas(
                hit.posOnWork, hit.dw, hit.dh, cfg.deg, sx, sy, sw, sh, vw, vh, vw, vh, hit.pad
              );
            }
          }
        }

        if (candidate && singleScanToken === myToken && singleScanActive) {
          const check = parseSingle13DigitScaleBarcode(candidate);
          if (check.ok) {
            const fullFrameCanvas = captureCleanFullVideoCanvas(video);
            const mappedPos = posInVideo
              ? convertCornerPointsToPos(
                  [posInVideo.topLeft, posInVideo.topRight, posInVideo.bottomRight, posInVideo.bottomLeft],
                  fullFrameCanvas.width / vw,
                  fullFrameCanvas.height / vh
                )
              : null;

            singleScanActive = false;
            singleScanToken += 1;
            shutterLockUntil = Date.now() + 180;

            setShutterUIState('captured');
            handleBarcodeInput(candidate, 'Camera', null, {
              frameCanvas: fullFrameCanvas,
              barcodePos: mappedPos,
              liveVideo: video,
              allowTilt: true
            });
            setTimeout(function () {
              if (!singleScanActive && cameraActive) {
                setShutterUIState('ready');
              }
            }, 550);
            return;
          } else {
            lastInvalidError = check.error;
          }
        }
      }

      await new Promise(function (r) { setTimeout(r, 14); });
    }

    if (singleScanToken === myToken && singleScanActive) {
      singleScanActive = false;
      singleScanToken += 1;
      triggerCameraRefocus();
      setShutterUIState('ready');
      playBeep('error');
      vibrateDevice([100, 50, 100]);
      showBanner(
        'error',
        lastInvalidError || 'Chưa bắt kịp vạch sọc. Bạn có thể chạm nhẹ vào màn hình Camera để lấy nét lại hoặc bấm 1.4x rồi quét!'
      );
    }
  }

  function stopCamera1DScanner() {
    cameraActive = false;
    singleScanActive = false;
    singleScanToken += 1;
    radarLoopId += 1;
    livePreLock = null;
    const viewportBox = document.getElementById('cameraViewportBox');
    if (viewportBox) viewportBox.classList.remove('is-prelocked', 'is-scanning', 'is-captured');
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
  // TURBO PHOTO / IMAGE DECODER + INSTANT COMMIT & ASYNC NSX / HSD EXTRACTION
  // =========================================================================
  async function loadCleanCanvasFromFile(file, maxDim) {
    const bmp = await loadImageSourceForCanvas(file);
    const drawSource = bmp._el || bmp;
    const limit = maxDim || 1600;
    const ratio = Math.min(1, limit / Math.max(1, Math.max(bmp.width, bmp.height)));
    const cw = Math.max(160, Math.round(bmp.width * ratio));
    const ch = Math.max(100, Math.round(bmp.height * ratio));
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(drawSource, 0, 0, cw, ch);
    if (bmp.close) bmp.close();
    return { canvas: canvas, scaleRatio: ratio };
  }

  async function decodeBarcodeFromImageFile(file) {
    if (!file) return;
    showBanner('warn', '⚡ Đang bắt mã siêu tốc...');

    try {
      await warmUpWasmEngine();
      warmUpOcrWorker();

      const cleanPack = await loadCleanCanvasFromFile(file, 2200);
      const cleanCanvas = cleanPack.canvas;

      const wasmResultPromise = decodePhotoInBrowserWasm(file, cleanCanvas);
      const tasks = [wasmResultPromise];
      if (location.protocol.startsWith('http') && (location.port === '8088' || location.port === '8443')) {
        tasks.push(decodePhotoViaLocalCppServer(file).then(function (c) {
          return c ? { code: c, position: null } : null;
        }));
      }

      const hit = await raceFirstNonNull(tasks);

      if (hit && hit.code) {
        // Chốt mã vạch & kêu BÍP ngay lập tức (< 0.08s), tự đọc NSX/HSD ngầm bên dưới không bắt chờ!
        handleBarcodeInput(hit.code, 'Ảnh chụp', null, {
          frameCanvas: cleanCanvas,
          barcodePos: hit.position || null,
          liveVideo: null,
          allowTilt: true
        });
      } else {
        // Nếu người dùng chụp cận cảnh chỉ có dòng chữ NSX/HSD -> tự động đọc ngày gắn vào tem vừa quét!
        const onlyDates = await extractNsxHsdWithTimeout(cleanCanvas, null, 2800, true);
        if ((onlyDates.nsx || onlyDates.hsd) && records.length > 0) {
          const latest = records[records.length - 1];
          if (onlyDates.nsx) latest.nsx = onlyDates.nsx;
          if (onlyDates.hsd) latest.hsd = onlyDates.hsd;
          persistRecords();
          enqueueOp({ type: 'update', record: toSyncRecord(latest) });
          renderAll(true);
          flushSyncQueue();
          playBeep('ok');
          showBanner(
            'ok',
            '✅ Đã đọc từ ảnh & cập nhật vào tem vừa quét: NSX ' + formatLotDateDisplay(latest.nsx) + ' • HSD ' + formatLotDateDisplay(latest.hsd)
          );
          return;
        }
        playBeep('error');
        showBanner('error', 'Không thấy rõ dải mã vạch 13 số trong ảnh. Hãy đưa ống kính rõ nét vào mặt tem rồi chụp lại!');
      }
    } catch (err) {
      playBeep('error');
      showBanner('error', 'Không đọc được ảnh vừa chọn. Vui lòng thử lại!');
    }
  }

  async function decodeDateOnlyImageFile(file) {
    if (!file) return;
    showBanner('warn', '⚡ Đang đọc tự động NSX & HSD từ ảnh tem...');
    try {
      const cleanPack = await loadCleanCanvasFromFile(file, 1500);
      const hitPos = await detectBarcodePositionOnCanvas(cleanPack.canvas);
      const dates = await extractNsxHsdWithTimeout(cleanPack.canvas, hitPos, 2800, true);
      if (!dates.nsx && !dates.hsd) {
        playBeep('error');
        showBanner('error', 'Chưa đọc rõ chữ NSX / HSD trong ảnh. Hãy chụp rõ nét dòng NSX / HSD trên tem!');
        return;
      }

      playBeep('ok');
      if (dateOnlyTarget === 'modal') {
        if (dates.nsx) document.getElementById('editNsxInput').value = dates.nsx;
        if (dates.hsd) document.getElementById('editHsdInput').value = dates.hsd;
        showBanner('ok', '✅ Đã điền tự động NSX: ' + (dates.nsx || '—') + ' • HSD: ' + (dates.hsd || '—'));
      } else if (dateOnlyTarget === 'pda_lot') {
        if (dates.nsx) document.getElementById('pdaLotNsxInput').value = dates.nsx;
        if (dates.hsd) document.getElementById('pdaLotHsdInput').value = dates.hsd;
        refreshPdaLotClearBtn();
        showBanner('ok', '✅ Đã gán Lô PDA: NSX ' + (dates.nsx || '—') + ' • HSD ' + (dates.hsd || '—') + ' cho các tem bắn tiếp theo!');
      } else if (records.length > 0) {
        const latest = records[records.length - 1];
        if (dates.nsx) latest.nsx = dates.nsx;
        if (dates.hsd) latest.hsd = dates.hsd;
        persistRecords();
        enqueueOp({ type: 'update', record: toSyncRecord(latest) });
        renderAll(true);
        flushSyncQueue();
        showBanner('ok', '✅ Đã cập nhật vào tem vừa quét & đẩy lên Sheet: NSX ' + formatLotDateDisplay(latest.nsx) + ' • HSD ' + formatLotDateDisplay(latest.hsd));
      }
    } catch (e) {
      playBeep('error');
      showBanner('error', 'Không xử lý được ảnh vừa chọn. Vui lòng thử lại!');
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

  // Bộ giải mã EAN-13 thuần JavaScript 48 tia quét mật độ cao (Tầng dự phòng số 3 cho mọi trình duyệt ĐT/PDA)
  const EAN13_L_MAP = {
    '3211': 0, '2221': 1, '2122': 2, '1411': 3, '1132': 4,
    '1231': 5, '1114': 6, '1312': 7, '1213': 8, '3112': 9
  };
  const EAN13_G_MAP = {
    '1123': 0, '1222': 1, '2212': 2, '1141': 3, '2311': 4,
    '1321': 5, '4111': 6, '2131': 7, '3121': 8, '2113': 9
  };
  const EAN13_R_MAP = EAN13_L_MAP;
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
    if (runs.length < 59) return null;
    for (let s = 0; s <= runs.length - 59; s += 2) {
      const unit = (runs[s] + runs[s + 1] + runs[s + 2]) / 3;
      if (unit < 0.72) continue;
      if (
        Math.abs(runs[s] - unit) > unit * 0.88 ||
        Math.abs(runs[s + 1] - unit) > unit * 0.88 ||
        Math.abs(runs[s + 2] - unit) > unit * 0.88
      ) {
        continue;
      }
      const midUnit = (runs[s + 27] + runs[s + 28] + runs[s + 29] + runs[s + 30] + runs[s + 31]) / 5;
      if (Math.abs(midUnit - unit) > unit * 0.78) continue;

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

    const winHalf = Math.max(10, Math.floor(w / 32));
    const gray = new Uint8Array(w);
    const bits = new Uint8Array(w);
    const revBits = new Uint8Array(w);
    const prefixSum = new Int32Array(w + 1);
    const numLines = 48;

    for (let step = 1; step <= numLines; step++) {
      const y = Math.floor((h * step) / (numLines + 1));
      let rowOffset = y * w * 4;
      prefixSum[0] = 0;
      for (let x = 0; x < w; x++) {
        const g = (data[rowOffset] * 77 + data[rowOffset + 1] * 150 + data[rowOffset + 2] * 29) >> 8;
        gray[x] = g;
        prefixSum[x + 1] = prefixSum[x] + g;
        rowOffset += 4;
      }

      const bias = (step % 2 === 0) ? 5 : 2;
      for (let x = 0; x < w; x++) {
        const left = Math.max(0, x - winHalf);
        const right = Math.min(w - 1, x + winHalf);
        const localMean = (prefixSum[right + 1] - prefixSum[left]) / (right - left + 1);
        const isDark = gray[x] < (localMean - bias) ? 1 : 0;
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

  async function decodePhotoInBrowserWasm(file, preloadedCleanCanvas) {
    try {
      const bmp = await loadImageSourceForCanvas(file);
      const drawSource = bmp._el || bmp;
      const bw = bmp.width;
      const bh = bmp.height;
      const outW = preloadedCleanCanvas ? preloadedCleanCanvas.width : bw;
      const outH = preloadedCleanCanvas ? preloadedCleanCanvas.height : bh;

      const workCanvas = document.createElement('canvas');
      const workCtx = workCanvas.getContext('2d', { willReadFrequently: true });

      // 15 lượt quét độ phân giải gốc (từ nhanh 15ms tới chuyên sâu cho ảnh chụp xa 12MP, kho lạnh tối, sát mép, nghiêng mọi góc)
      const passes = [
        { cw: 1.0, ch: 1.0, ox: 0, oy: 0, deg: 0, maxDim: 2050, pad: 24, sharp: false, nat: true },
        { cw: 1.0, ch: 1.0, ox: 0, oy: 0, deg: 0, maxDim: 2050, pad: 28, sharp: true, nat: false },
        { cw: 0.54, ch: 0.54, ox: 0, oy: 0, deg: 0, maxDim: 1950, pad: 24, sharp: true, nat: true },
        { cw: 0.56, ch: 0.56, ox: 0, oy: 0, deg: -11, maxDim: 1850, pad: 24, sharp: true, nat: false },
        { cw: 0.56, ch: 0.56, ox: 0, oy: 0, deg: 11, maxDim: 1850, pad: 24, sharp: true, nat: false },
        { cw: 0.34, ch: 0.34, ox: 0, oy: 0, deg: 0, maxDim: 1800, pad: 24, sharp: true, nat: false },
        { cw: 0.74, ch: 0.52, ox: 0, oy: -0.16, deg: 0, maxDim: 1850, pad: 24, sharp: true, nat: false },
        { cw: 0.74, ch: 0.52, ox: 0, oy: 0.16, deg: 0, maxDim: 1850, pad: 24, sharp: true, nat: false },
        { cw: 0.96, ch: 0.96, ox: 0, oy: 0, deg: -10, maxDim: 1900, pad: 26, sharp: true, nat: false },
        { cw: 0.96, ch: 0.96, ox: 0, oy: 0, deg: 10, maxDim: 1900, pad: 26, sharp: true, nat: false },
        { cw: 0.96, ch: 0.96, ox: 0, oy: 0, deg: -19, maxDim: 1900, pad: 26, sharp: true, nat: false },
        { cw: 0.96, ch: 0.96, ox: 0, oy: 0, deg: 19, maxDim: 1900, pad: 26, sharp: true, nat: false },
        { cw: 0.96, ch: 0.96, ox: 0, oy: 0, deg: -33, maxDim: 1850, pad: 26, sharp: true, nat: false },
        { cw: 0.96, ch: 0.96, ox: 0, oy: 0, deg: 33, maxDim: 1850, pad: 26, sharp: true, nat: false },
        { cw: 0.98, ch: 0.98, ox: 0, oy: 0, deg: 90, maxDim: 1900, pad: 26, sharp: true, nat: false }
      ];

      let fallbackUnverified = null;

      for (let i = 0; i < passes.length; i++) {
        const p = passes[i];
        const sw = Math.max(120, Math.round(bw * p.cw));
        const sh = Math.max(90, Math.round(bh * p.ch));
        const sx = Math.max(0, Math.min(bw - sw, Math.round((bw - sw) / 2 + bw * p.ox)));
        const sy = Math.max(0, Math.min(bh - sh, Math.round((bh - sh) / 2 + bh * p.oy)));

        const hit = await tryDecodeRegionOnCanvas(
          workCanvas, workCtx, drawSource, sx, sy, sw, sh, p.deg, p.maxDim, p.pad, p.sharp, p.nat
        );
        if (hit && hit.code) {
          const mappedPos = hit.posOnWork
            ? mapPositionToTargetCanvas(hit.posOnWork, hit.dw, hit.dh, p.deg, sx, sy, sw, sh, bw, bh, outW, outH, hit.pad)
            : null;
          if (!hit.unverified) {
            if (bmp.close) bmp.close();
            return { code: hit.code, position: mappedPos };
          } else if (!fallbackUnverified) {
            fallbackUnverified = { code: hit.code, position: mappedPos };
          }
        }
      }

      if (bmp.close) bmp.close();
      if (fallbackUnverified) return fallbackUnverified;
    } catch (e) {}

    if (window.ZXingWASM && window.ZXingWASM.readBarcodes) {
      try {
        const direct = await window.ZXingWASM.readBarcodes(file, WASM_1D_LOCAL_OPTIONS);
        if (direct && direct.length > 0 && direct[0].text) {
          return { code: direct[0].text, position: null };
        }
      } catch (e) {}
    }

    return null;
  }

  // =========================================================================
  // OFFLINE-FIRST QUEUE & GOOGLE SHEET AUTO-SYNC WHEN BACK ONLINE
  // =========================================================================
  function setNavMiniDotState(stateClass) {
    const mini = document.getElementById('navSyncMiniDot');
    if (mini) {
      mini.className = 'nav-mini-dot ' + stateClass;
    }
  }

  function updateSyncBadge() {
    const dot = document.getElementById('syncStatusDot');
    const txt = document.getElementById('syncStatusText');
    if (!dot || !txt) return;

    if (!navigator.onLine) {
      dot.className = 'sync-dot pending';
      setNavMiniDotState('pending');
      txt.textContent = pendingOps.length > 0
        ? ('📴 Lưu máy (' + pendingOps.length + ' chờ)')
        : '📴 Đang Offline (Lưu máy)';
      return;
    }

    if (!settings.sheetWebAppUrl) {
      dot.className = 'sync-dot';
      setNavMiniDotState('');
      txt.textContent = 'Kết nối GG Sheet';
      return;
    }

    if (syncInProgress) {
      dot.className = 'sync-dot pending';
      setNavMiniDotState('pending');
      txt.textContent = 'Đang cập nhật...';
      return;
    }

    if (pendingOps.length > 0) {
      dot.className = 'sync-dot pending';
      setNavMiniDotState('pending');
      txt.textContent = 'Chờ đẩy (' + pendingOps.length + ')';
    } else {
      dot.className = 'sync-dot ok';
      setNavMiniDotState('ok');
      txt.textContent = 'Đã lưu GG Sheet';
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

  function normalizeRecordFromSheet(r) {
    const cleanCode = String(r.productCode || '').trim();
    const sheetName = (r.productName && String(r.productName).trim() !== '' && String(r.productName).trim() !== '—')
      ? String(r.productName).trim()
      : getProductNameOrNull(cleanCode);
    return {
      id: String(r.id || ''),
      scannedAt: String(r.scannedAt || ''),
      productCode: cleanCode,
      productName: sheetName,
      grams: Math.round(Number(r.grams)),
      nsx: normalizeDateVN(r.nsx) || '',
      hsd: normalizeDateVN(r.hsd) || '',
      rawBarcode: String(r.rawBarcode || ''),
      note: String(r.note || ''),
      edited: Boolean(r.note)
    };
  }

  function buildRecordsFingerprint(list) {
    if (!Array.isArray(list) || list.length === 0) return 'EMPTY_0';
    return list.map(function (r) {
      return [
        r.id || '',
        r.scannedAt || '',
        r.productCode || '',
        r.productName || '',
        Math.round(Number(r.grams || 0)),
        normalizeDateVN(r.nsx) || '',
        normalizeDateVN(r.hsd) || '',
        r.rawBarcode || '',
        r.note || ''
      ].join('|');
    }).join(';;');
  }

  function applyAuthoritativeSheetRecords(sheetRecords, showToastAlways) {
    if (!Array.isArray(sheetRecords)) return false;
    const normalized = sheetRecords
      .map(normalizeRecordFromSheet)
      .filter(function (r) { return r.grams > 0 && (r.productCode || r.scannedAt); });

    const oldFp = buildRecordsFingerprint(records);
    const newFp = buildRecordsFingerprint(normalized);
    if (oldFp === newFp) {
      if (showToastAlways) {
        showBanner('ok', '✅ Dữ liệu trên App đang khớp 100% với bảng tính Google Sheet (' + records.length + ' tem)!');
      }
      return false;
    }

    const prevCount = records.length;
    records = normalized;
    persistRecords();
    renderAll(false);

    if (showToastAlways || prevCount !== records.length) {
      showBanner(
        'ok',
        '🔄 Đã tự cập nhật theo dữ liệu thực trên Google Sheet (' + records.length + ' tem • ' + formatKg(computeMetrics().totalGrams) + ' Kg)!'
      );
    }
    return true;
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

        // Nếu không còn mục Offline nào đang chờ, cập nhật ngay danh sách chuẩn thực tế từ Google Sheet trả về!
        if (pendingOps.length === 0 && Array.isArray(res.records)) {
          applyAuthoritativeSheetRecords(res.records, false);
        }

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
        setNavMiniDotState(!navigator.onLine ? 'pending' : 'err');
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

  async function reconcileWithGoogleSheet(isManualClick, fromAutoReconnect) {
    if (!isManualClick && (activeDateReadsCount > 0 || syncHoldTimer || singleScanActive)) {
      return;
    }
    if (!settings.sheetWebAppUrl) {
      if (isManualClick) openSheetModalUI();
      return;
    }
    if (!navigator.onLine) {
      updateSyncBadge();
      if (isManualClick) {
        showBanner('warn', '📴 Đang không có mạng — Ứng dụng sẽ tự khớp Google Sheet ngay khi có sóng lại!');
      }
      return;
    }

    // 1. Nếu trên máy đang có thao tác Offline chưa đẩy -> đẩy lên Sheet trước (không bao giờ làm mất tem quét lúc mất mạng!)
    if (pendingOps.length > 0) {
      await flushSyncQueue(Boolean(fromAutoReconnect));
      if (pendingOps.length > 0) return;
    }

    // 2. Kéo dữ liệu thực tế mới nhất từ Google Sheet về (bắt tức thì mọi dòng bị xóa/sửa trực tiếp trên Sheet!)
    if (reconcileInFlight || syncInProgress) return;
    reconcileInFlight = true;
    try {
      const sep = settings.sheetWebAppUrl.indexOf('?') === -1 ? '?' : '&';
      const pullUrl = settings.sheetWebAppUrl + sep + 'action=pull' + (isManualClick ? '' : '&lite=1') + '&_t=' + Date.now();
      const resp = await fetch(pullUrl, {
        method: 'GET',
        cache: 'no-store',
        redirect: 'follow'
      });
      const data = await resp.json();
      if (!data || !data.ok) {
        if (isManualClick) {
          alert('Lỗi tải dữ liệu: ' + (data && data.error ? data.error : 'Không rõ'));
        }
        return;
      }

      // Kiểm tra lại: nếu trong lúc đang tải về mà người dùng vừa quét thêm tem mới thì ưu tiên đẩy tem mới trước!
      if (pendingOps.length > 0 || syncInProgress) {
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
        applyAuthoritativeSheetRecords(data.records, Boolean(isManualClick));
        if (isManualClick) {
          closeModal('sheetModal');
        }
      }
    } catch (err) {
      if (isManualClick) {
        alert('Không kết nối được tới Google Sheet: ' + (err.message || err));
      }
    } finally {
      reconcileInFlight = false;
      updateSyncBadge();
    }
  }

  async function forceFullPushToSheet() {
    if (!settings.sheetWebAppUrl) {
      openSheetModalUI();
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
        showBanner('ok', 'Đã đồng bộ toàn bộ ' + records.length + ' tem (gồm NSX/HSD) lên Google Sheet!');
      } else {
        alert('Lỗi từ Google Sheet: ' + (res && res.error ? res.error : 'Không xác định'));
      }
    } catch (e) {
      alert('Không kết nối được tới đường link Web App Google Sheet. Hãy kiểm tra sóng mạng Internet!');
    } finally {
      syncInProgress = false;
      updateSyncBadge();
    }
  }

  async function pullFromGoogleSheet() {
    await reconcileWithGoogleSheet(true, false);
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
  // EXPORT CSV / EXCEL BACKUP ON DEVICE (CÓ ĐỦ CỘT NSX & HSD)
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
      'NSX',
      'HSD',
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
        formatLotDateDisplay(r.nsx),
        formatLotDateDisplay(r.hsd),
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

    // Sự kiện thanh gán NSX / HSD theo lô cho PDA
    const pdaNsxInp = document.getElementById('pdaLotNsxInput');
    const pdaHsdInp = document.getElementById('pdaLotHsdInput');
    if (pdaNsxInp && pdaHsdInp) {
      pdaNsxInp.addEventListener('input', refreshPdaLotClearBtn);
      pdaHsdInp.addEventListener('input', refreshPdaLotClearBtn);
      pdaNsxInp.addEventListener('blur', function () {
        const c = normalizeDateVN(pdaNsxInp.value);
        if (c) pdaNsxInp.value = c;
        refreshPdaLotClearBtn();
      });
      pdaHsdInp.addEventListener('blur', function () {
        const c = normalizeDateVN(pdaHsdInp.value);
        if (c) pdaHsdInp.value = c;
        refreshPdaLotClearBtn();
      });
    }
    const btnReadLot = document.getElementById('btnReadLotPhoto');
    if (btnReadLot) {
      btnReadLot.addEventListener('click', function () {
        dateOnlyTarget = 'pda_lot';
        document.getElementById('hiddenDateOnlyImageInput').click();
      });
    }
    const btnClearLot = document.getElementById('btnClearLotDates');
    if (btnClearLot) {
      btnClearLot.addEventListener('click', function () {
        if (pdaNsxInp) pdaNsxInp.value = '';
        if (pdaHsdInp) pdaHsdInp.value = '';
        refreshPdaLotClearBtn();
        if (currentMode === 'pda') input.focus();
      });
    }

    window.addEventListener('keydown', function (e) {
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
    const btnAutoSnap = document.getElementById('btnToggleAutoSnap');
    if (btnAutoSnap) {
      btnAutoSnap.addEventListener('click', function () {
        settings.autoSnapCamera = !settings.autoSnapCamera;
        saveSettings();
        refreshAutoSnapBtnUI();
        if (cameraActive && !singleScanActive) {
          setShutterUIState('ready');
        }
        showBanner(
          'ok',
          settings.autoSnapCamera
            ? '⚡ Đã BẬT Tự chốt: Đưa tem vào khung là máy tự quét luôn không cần bấm nút!'
            : '📸 Đã TẮT Tự chốt: Đưa tem vào khung rồi bấm nút tròn để quét từng tem.'
        );
      });
    }
    const camVideoEl = document.getElementById('cameraVideo');
    if (camVideoEl) {
      camVideoEl.addEventListener('click', function () {
        if (cameraActive) {
          triggerCameraRefocus();
        }
      });
    }
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

    const btnModalDates = document.getElementById('btnModalReadDates');
    if (btnModalDates) {
      btnModalDates.addEventListener('click', function () {
        dateOnlyTarget = 'modal';
        document.getElementById('hiddenDateOnlyImageInput').click();
      });
    }
    document.getElementById('hiddenDateOnlyImageInput').addEventListener('change', function (e) {
      const file = e.target.files && e.target.files[0];
      if (file) decodeDateOnlyImageFile(file);
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
        const kpiSec = document.getElementById('kpiSummarySection');
        if (kpiSec) {
          kpiSec.style.display = (target === 'tabSettings' || target === 'tabCatalog') ? 'none' : 'grid';
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
      const dates = pendingDuplicateDates;
      const dateCtx = pendingDuplicateDateCtx;
      pendingDuplicateCode = null;
      pendingDuplicateDates = null;
      pendingDuplicateDateCtx = null;
      closeModal('duplicateModal');
      if (code) processSingleBarcode(code, 'ConfirmedDup', true, dates, dateCtx);
    });
    document.getElementById('btnCancelDuplicate').addEventListener('click', function () {
      pendingDuplicateCode = null;
      pendingDuplicateDates = null;
      pendingDuplicateDateCtx = null;
      closeModal('duplicateModal');
    });

    document.getElementById('btnOpenSheetModal').addEventListener('click', openSheetModalUI);
    const btnSettingsCfg = document.getElementById('btnSettingsConfigSheet');
    if (btnSettingsCfg) btnSettingsCfg.addEventListener('click', openSheetModalUI);
    const btnSettingsSync = document.getElementById('btnSettingsForceSync');
    if (btnSettingsSync) btnSettingsSync.addEventListener('click', forceFullPushToSheet);
    const btnSettingsPull = document.getElementById('btnSettingsPullSheet');
    if (btnSettingsPull) btnSettingsPull.addEventListener('click', pullFromGoogleSheet);
    const btnQuickPull = document.getElementById('btnQuickPullSheet');
    if (btnQuickPull) btnQuickPull.addEventListener('click', pullFromGoogleSheet);
    const btnHistPull = document.getElementById('btnHistoryPullSheet');
    if (btnHistPull) btnHistPull.addEventListener('click', pullFromGoogleSheet);

    document.getElementById('btnCopyAppsScript').addEventListener('click', function () {
      const code = window.GOOGLE_APPS_SCRIPT_CODE || '';
      navigator.clipboard.writeText(code).then(function () {
        showBanner('ok', 'Đã sao chép Mã Kết Nối Google Sheet (có NSX & HSD)!');
        document.getElementById('btnCopyAppsScript').textContent = '✅ Đã sao chép mã!';
        setTimeout(function () {
          document.getElementById('btnCopyAppsScript').textContent = '📋 Sao chép Mã Kết Nối Google Sheet (Có NSX & HSD)';
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

      if (urlVal.indexOf('docs.google.com/spreadsheets/') !== -1) {
        document.getElementById('sheetViewUrlInput').value = urlVal;
        document.getElementById('sheetWebAppUrlInput').value = '';
        settings.sheetViewUrl = urlVal;
        saveSettings();
        alert(
          'Đường link "docs.google.com/spreadsheets/..." bạn vừa dán là link MỞ XEM bảng tính (hệ thống đã tự lưu vào ô Link mở xem bên dưới).\n\n' +
          'Để tự động ghi dữ liệu quét vào bảng tính, bạn cần dán đường link có đuôi "/exec" (bắt đầu bằng https://script.google.com/macros/s/.../exec)!'
        );
        return;
      }

      settings.sheetWebAppUrl = urlVal;
      if (viewVal) settings.sheetViewUrl = viewVal;
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
    if (quickClearBtn) quickClearBtn.addEventListener('click', clearAllSessionRecords);
    const settingsClearBtn = document.getElementById('btnSettingsClearSession');
    if (settingsClearBtn) settingsClearBtn.addEventListener('click', clearAllSessionRecords);

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
    box.style.display = (val.indexOf('https://script.google.com/') === 0 || val.indexOf('http://127.0.0.1:') === 0) ? 'block' : 'none';
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
