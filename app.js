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

  const APP_CACHE_VERSION = 'scan-ton-kho-v14';
  const STORAGE_APP_VERSION = 'scan_ton_app_ver_v1';

  // Camera, WASM, Live Pre-Lock Radar & Async Offline OCR state
  let wasmReadyPromise = null;
  let ocrWorkerPromise = null;
  let ocrWorkerResolved = false;
  let ocrQueuePromise = Promise.resolve();
  let activeDateReadsCount = 0;
  let readingDateRecordIds = {};
  let readingDateStartedAt = {};
  let nextOpUid = 1;
  let inFlightOpUids = {};
  let lastLiveAutoRescueAt = 0;
  let syncHoldTimer = null;
  let dateHoldSafetyTimer = null;
  let reconcileInFlight = false;
  let pendingSwReload = false;
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
  let autoSnapStreakCode = '';
  let autoSnapStreakCount = 0;
  let autoSnapStreakLastAt = 0;
  let edgeClipHoldCode = '';
  let edgeClipHoldSince = 0;

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

  async function ensureOcrAssetsInCache(baseNoSlash) {
    if (!('caches' in window) || !navigator.onLine) return;
    try {
      const cache = await window.caches.open(APP_CACHE_VERSION);
      const urls = [
        baseNoSlash + '/eng.traineddata',
        baseNoSlash + '/tesseract-core-simd-lstm.wasm.js',
        baseNoSlash + '/tesseract-core-lstm.wasm.js'
      ];
      for (let i = 0; i < urls.length; i++) {
        const hit = await cache.match(urls[i], { ignoreSearch: true });
        if (!hit) {
          try {
            const resp = await fetch(urls[i]);
            if (resp && resp.ok) {
              await cache.put(urls[i], resp.clone());
            }
          } catch (e) {}
        }
      }
    } catch (e) {}
  }

  function warmUpOcrWorker() {
    if (ocrWorkerPromise) return ocrWorkerPromise;
    if (!window.Tesseract || !window.Tesseract.createWorker) {
      return Promise.resolve(null);
    }
    const baseNoSlash = new URL('./vendor/ocr/', window.location.href).href.replace(/\/+$/, '');
    // Dùng cacheMethod: 'none' để KHÔNG BAO GIỜ bị treo khóa IndexedDB ('keyval-store') khi điện thoại nâng cấp phiên bản hoặc mở nhiều thẻ;
    // Toàn bộ dữ liệu đọc chữ Offline (eng.traineddata + wasm) đã được lưu trực tiếp trong bộ nhớ đệm Service Worker tốc độ 0ms!
    const spawnWorker = function (explicitCoreJs) {
      return window.Tesseract.createWorker('eng', 1, {
        workerPath: baseNoSlash + '/worker.min.js',
        corePath: explicitCoreJs || baseNoSlash,
        langPath: baseNoSlash,
        gzip: false,
        workerBlobURL: false,
        cacheMethod: 'none',
        logger: function () {}
      });
    };

    ocrWorkerPromise = spawnWorker(null).catch(function () {
      return spawnWorker(baseNoSlash + '/tesseract-core-lstm.wasm.js');
    }).then(async function (worker) {
      await worker.setParameters({
        tessedit_pageseg_mode: '6'
      });
      ocrWorkerResolved = true;
      setTimeout(function () { ensureOcrAssetsInCache(baseNoSlash); }, 250);
      return worker;
    }).catch(function () {
      ocrWorkerPromise = null;
      ocrWorkerResolved = false;
      return null;
    });
    return ocrWorkerPromise;
  }

  function purgeLegacyCachesOnce() {
    try {
      const prevVer = localStorage.getItem(STORAGE_APP_VERSION);
      if (prevVer !== APP_CACHE_VERSION) {
        localStorage.setItem(STORAGE_APP_VERSION, APP_CACHE_VERSION);
        if ('caches' in window && navigator.onLine) {
          window.caches.keys().then(function (keys) {
            keys.forEach(function (k) {
              if (k !== APP_CACHE_VERSION) {
                window.caches.delete(k).catch(function () {});
              }
            });
          }).catch(function () {});
        }
      }
    } catch (e) {}
  }

  function checkPendingSwReload() {
    if (!pendingSwReload) return;
    if (singleScanActive || activeDateReadsCount > 0 || syncInProgress || pendingOps.length > 0) return;
    pendingSwReload = false;
    try {
      if (sessionStorage.getItem('sw_reloaded_v14') === '1') return;
      sessionStorage.setItem('sw_reloaded_v14', '1');
    } catch (e) {}
    window.location.reload();
  }

  function registerAndAutoUpdateServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (!(location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      return;
    }
    const hadPreviousController = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.register('./sw.js?v=14', { updateViaCache: 'none' }).then(function (reg) {
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
      setTimeout(function () { reg.update().catch(function () {}); }, 900);
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) reg.update().catch(function () {});
      });
    }).catch(function () {});

    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!hadPreviousController) return;
      if (singleScanActive || activeDateReadsCount > 0 || syncInProgress || pendingOps.length > 0) {
        pendingSwReload = true;
        return;
      }
      try {
        if (sessionStorage.getItem('sw_reloaded_v14') === '1') return;
        sessionStorage.setItem('sw_reloaded_v14', '1');
      } catch (e) {}
      window.location.reload();
    });
  }

  async function initApp() {
    purgeLegacyCachesOnce();
    warmUpWasmEngine();
    setTimeout(function () { warmUpOcrWorker(); }, 40);

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
      if (document.hidden) {
        if (pendingOps.length > 0 && navigator.onLine && settings.sheetWebAppUrl) {
          flushSyncQueue(false);
        }
      } else if (navigator.onLine && settings.sheetWebAppUrl) {
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

  function ensureOpUid(op) {
    if (op && !op._opUid) {
      op._opUid = 'op_' + Date.now() + '_' + (nextOpUid++);
    }
    return op;
  }

  function enqueueOp(op) {
    ensureOpUid(op);
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

    // Dạng dd/MM/yy, dd.MM.yy, dd-MM-yy (tem cân in năm 2 số: 15.11.26 -> 15/11/2026)
    m = s.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](2[4-9]|3[0-6])$/);
    if (m) {
      const d = parseInt(m[1], 10);
      const mo = parseInt(m[2], 10);
      const y = 2000 + parseInt(m[3], 10);
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

    // Dạng gõ nhanh 8 chữ số ddMMyyyy (VD: 12112026 -> 12/11/2026) hoặc 6 chữ số ddMMyy (121126 -> 12/11/2026)
    m = s.match(/^(\d{2})(\d{2})(20[23]\d|2[4-9]|3[0-6])$/);
    if (m) {
      const d = parseInt(m[1], 10);
      const mo = parseInt(m[2], 10);
      const rawY = parseInt(m[3], 10);
      const y = rawY < 100 ? (2000 + rawY) : rawY;
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
  // BỘ ĐỌC TỰ ĐỘNG NSX & HSD TRÊN TEM MEATCOOL & MỌI TEM CÂN KHO (BẢN v13 SIÊU TỐC: ĐA VÙNG THÔNG MINH, HỖ TRỢ MỌI LOẠI TEM & TỰ BÙ RẢNH TAY)
  // =========================================================================
  const OCR_NSX_PREFIX_RE = /N\s*[S58]\s*X|[S58]\s*X\s*:|N\s*[DĐ]\s*G|[DĐ]\s*G\s*:|DONG\s*GOI|MFG|PROD|NGAY\s*SX/;
  const OCR_HSD_PREFIX_RE = /H\s*[S58]\s*[DO0]|[S58]\s*[DO0]\s*:|H\s*[DO0]\s*:|EXP|HAN\s*SD|SU\s*DUNG/;
  const OCR_ANY_DATE_PREFIX_RE = /N\s*[S58]\s*X|H\s*[S58]\s*[DO0]|[S58]\s*X\s*:|[S58]\s*[DO0]\s*:|H\s*[DO0]\s*:|N\s*[DĐ]\s*G|[DĐ]\s*G\s*:|DONG\s*GOI|MFG|EXP|PROD|NGAY|HAN/;

  function parseOcrNsxHsdText(rawText) {
    const rawStr = String(rawText || '');
    if (!rawStr) return { nsx: '', hsd: '' };

    // Làm sạch các ký tự chữ dễ bị lóa bóng nilông nhận nhầm thành số 0/1/5/6/8 nằm trong cụm ngày (tương thích mọi đời iOS/Android/PDA)
    const text = rawStr
      .replace(/([0-9.,\/:-])[Oo]([0-9.,\/:-])/g, '$10$2')
      .replace(/([0-9.,\/:-])[Oo]([0-9.,\/:-])/g, '$10$2')
      .replace(/([0-9])[Oo]\b/g, '$10')
      .replace(/(20[23])[Gg6b]\b/g, '$16')
      .replace(/(^|[\s:])[Il|!](\s*[0-9][.,\/:-])/g, '$11$2')
      .replace(/([.,\/:-]\s*)[Il|!]([0-9])/g, '$11$2')
      .replace(/([0-9])[Il|!](\s*[.,\/:-])/g, '$11$2')
      .replace(/(\b[0-2])[Ss](\s*[.,\/-]\s*[01]?\d)/g, '$15$2')
      .replace(/(\b[0-2])B(\s*[.,\/-]\s*[01]?\d)/g, '$18$2');

    const pad2 = function (n) { return n < 10 ? ('0' + n) : String(n); };
    const found = [];

    function tryPushCandidate(d, mo, y, matchIndex, matchLen, requireLabelPrefix) {
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
      const prefixCtx = text.slice(Math.max(0, matchIndex - 48), matchIndex + 4).toUpperCase();
      if (requireLabelPrefix && !OCR_ANY_DATE_PREFIX_RE.test(prefixCtx) && found.length === 0) {
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

    // Lượt A: Bắt chuẩn ngày 4 số năm có dấu chấm, phẩy, gạch chéo, gạch ngang, hai chấm hoặc khoảng trắng (kể cả dấu chấm mờ thành khoảng trắng: 12 . 11 . 2026)
    const regexSep = /(?:^|[^\d])(0?[1-9]|[12]\d|3[01])[.,\/:\-\s]{1,5}(0?[1-9]|1[0-2])[.,\/:\-\s]{1,5}(20[23]\d)(?!\d)/g;
    let m;
    while ((m = regexSep.exec(text)) !== null) {
      tryPushCandidate(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10), m.index, m[0].length, false);
    }

    // Lượt A2: Cứu trường hợp nếp nhăn bao bì sát sau chữ số năm tạo thêm 1 số nhiễu (VD: 12.11.20261) khi có dấu chấm/gạch rõ ràng cả hai bên
    const regexDotSpeckle = /(?:^|[^\d])(0?[1-9]|[12]\d|3[01])\s*[.,\/-]\s*(0?[1-9]|1[0-2])\s*[.,\/-]\s*(20[23]\d)\d(?!\d)/g;
    while ((m = regexDotSpeckle.exec(text)) !== null) {
      tryPushCandidate(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10), m.index, m[0].length, false);
    }

    // Lượt B: Bắt trường hợp ảnh hơi mờ làm mất 1 hoặc 2 dấu chấm nhỏ (VD: 12.112026, 1211.2026, hoặc NSX: 12112026)
    const regexCompact = /(?:^|[^\d])(0[1-9]|[12]\d|3[01])([.,\/:\-\s]?)(0[1-9]|1[0-2])([.,\/:\-\s]?)(20[23]\d)(?!\d)/g;
    while ((m = regexCompact.exec(text)) !== null) {
      const hasAnySep = Boolean(m[2] || m[4]);
      tryPushCandidate(parseInt(m[1], 10), parseInt(m[3], 10), parseInt(m[5], 10), m.index, m[0].length, !hasAnySep);
    }

    // Lượt C: Hỗ trợ định dạng năm-tháng-ngày yyyy.mm.dd / yyyy/mm/dd / yyyy-mm-dd
    const regexYmd = /(?:^|[^\d])(20[23]\d)\s*[.,\/-]\s*(0?[1-9]|1[0-2])\s*[.,\/-]\s*(0?[1-9]|[12]\d|3[01])(?!\d)/g;
    while ((m = regexYmd.exec(text)) !== null) {
      tryPushCandidate(parseInt(m[3], 10), parseInt(m[2], 10), parseInt(m[1], 10), m.index, m[0].length, false);
    }

    // Lượt D: Hỗ trợ năm 2 chữ số trên tem cân siêu thị/kho (VD: 15.11.26, 15/11/26, 15-11-26) — bắt buộc có đủ 2 dấu phân cách ngày rõ ràng nên 0% nhầm số ký!
    const regexShortYear = /(?:^|[^\d])(0?[1-9]|[12]\d|3[01])\s*[.\/-]\s*(0?[1-9]|1[0-2])\s*[.\/-]\s*(2[4-9]|3[0-6])(?!\d)/g;
    while ((m = regexShortYear.exec(text)) !== null) {
      tryPushCandidate(parseInt(m[1], 10), parseInt(m[2], 10), 2000 + parseInt(m[3], 10), m.index, m[0].length, false);
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
      // Bảo vệ thứ tự vật lý trên tem (NSX luôn in trước/trên HSD):
      // Nếu ngày thứ nhất lại lớn hơn ngày thứ hai (VD: dòng dưới 2026 bị mờ thành 2025 hoặc dòng trên 2026 bị mờ thành 2028)
      // mà dòng đầu KHÔNG có nhãn HSD -> tuyệt đối không đảo ngược sai, chỉ giữ dòng có nhãn rõ để lượt đọc kế tiếp (80ms sau) lấy chuẩn ngày còn lại!
      const DAY_MS = 86400000;
      if (
        unique[0].epoch > unique[1].epoch &&
        !OCR_HSD_PREFIX_RE.test(unique[0].prefixCtx)
      ) {
        if (OCR_NSX_PREFIX_RE.test(unique[0].prefixCtx) && !OCR_HSD_PREFIX_RE.test(unique[1].prefixCtx)) {
          return { nsx: unique[0].str, hsd: '' };
        }
        if (OCR_HSD_PREFIX_RE.test(unique[1].prefixCtx) && !OCR_NSX_PREFIX_RE.test(unique[0].prefixCtx)) {
          return { nsx: '', hsd: unique[1].str };
        }
        return { nsx: '', hsd: '' };
      }
      unique.sort(function (a, b) { return a.epoch - b.epoch; });
      const firstU = unique[0];
      const lastU = unique[unique.length - 1];
      return {
        nsx: firstU.str,
        hsd: lastU.str,
        suspectYearGap: Boolean((lastU.epoch - firstU.epoch) > 350 * DAY_MS)
      };
    }

    if (found.length >= 2 && found[0].str === found[1].str) {
      return { nsx: found[0].str, hsd: found[1].str };
    }

    // Chỉ đọc rõ được 1 ngày duy nhất -> kiểm tra nhãn NSX hay HSD đi kèm, tuyệt đối không tự đoán ngày còn lại!
    const single = unique[0];
    if (OCR_HSD_PREFIX_RE.test(single.prefixCtx)) {
      return { nsx: '', hsd: single.str };
    }
    if (OCR_NSX_PREFIX_RE.test(single.prefixCtx)) {
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
    // Ảnh đủ sáng (nền giấy >= 115): giữ điểm đen siêu mảnh 0.1% để bảo toàn tuyệt đối khe hở chữ số 6 ở cự ly xa; ảnh kho lạnh tối (< 115): kéo 1.8% để nét chữ đen rõ!
    const lowRatio = high < 115 ? 0.018 : 0.001;
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

  // Khôi phục độ sắc nét cho chữ nhỏ & dấu chấm '.' khi điện thoại đưa sát 12-18cm (ngoài khoảng lấy nét tối thiểu) hoặc luồng hình 720p bị mờ
  function sharpenDefocusedTextCanvas(srcCanvas) {
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
    const total = w * h;
    const lumArr = new Uint8Array(total);
    const hist = new Uint32Array(256);

    for (let i = 0, p = 0; i < total; i++, p += 4) {
      const g = (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8;
      lumArr[i] = g;
      hist[g] += 1;
    }

    let sum = 0;
    let high = 230;
    for (let k = 255; k >= 0; k--) {
      sum += hist[k];
      if (sum >= total * 0.12) { high = k; break; }
    }
    const lowRatio = high < 115 ? 0.016 : 0.0015;
    let low = 28;
    sum = 0;
    for (let k = 0; k < 256; k++) {
      sum += hist[k];
      if (sum >= total * lowRatio) { low = k; break; }
    }
    const span = Math.max(14, high - low);

    const norm = new Float32Array(total);
    for (let i = 0; i < total; i++) {
      const v = ((lumArr[i] - low) * 255) / span;
      norm[i] = v < 0 ? 0 : (v > 255 ? 255 : v);
    }

    const hBlur = new Float32Array(total);
    for (let y = 0; y < h; y++) {
      const ro = y * w;
      for (let x = 0; x < w; x++) {
        const xm2 = x > 1 ? x - 2 : 0;
        const xm1 = x > 0 ? x - 1 : 0;
        const xp1 = x + 1 < w ? x + 1 : w - 1;
        const xp2 = x + 2 < w ? x + 2 : w - 1;
        hBlur[ro + x] = (norm[ro + xm2] + norm[ro + xm1] * 3 + norm[ro + x] * 4 + norm[ro + xp1] * 3 + norm[ro + xp2]) / 12;
      }
    }

    for (let y = 0; y < h; y++) {
      const ym2 = (y > 1 ? y - 2 : 0) * w;
      const ym1 = (y > 0 ? y - 1 : 0) * w;
      const y0 = y * w;
      const yp1 = (y + 1 < h ? y + 1 : h - 1) * w;
      const yp2 = (y + 2 < h ? y + 2 : h - 1) * w;
      for (let x = 0; x < w; x++) {
        const idx = y0 + x;
        const b = (hBlur[ym2 + x] + hBlur[ym1 + x] * 3 + hBlur[idx] * 4 + hBlur[yp1 + x] * 3 + hBlur[yp2 + x]) / 12;
        const sv = Math.round(norm[idx] + 1.55 * (norm[idx] - b));
        const clamped = sv < 0 ? 0 : (sv > 255 ? 255 : sv);
        const p = idx * 4;
        d[p] = clamped;
        d[p + 1] = clamped;
        d[p + 2] = clamped;
        d[p + 3] = 255;
      }
    }
    oCtx.putImageData(img, pad, pad);
    return out;
  }

  // Khử sọc lưới điểm ảnh màn hình máy tính (LCD Moiré): lọc trung vị dọc 5 điểm khử sạch cả sọc xám trên giấy trắng lẫn khe đứt nét chữ, bảo toàn 100% dấu chấm '.' và khe hở chữ số 6!
  function descreenLcdCanvas(srcCanvas) {
    const w = srcCanvas.width;
    const h = srcCanvas.height;
    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    const ctx = tmp.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(srcCanvas, 0, 0);
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const lum = new Uint8Array(w * h);
    for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
      lum[i] = (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8;
    }
    const vals = new Uint8Array(5);
    for (let y = 2; y < h - 2; y++) {
      const ym2 = (y - 2) * w;
      const ym1 = (y - 1) * w;
      const y0 = y * w;
      const yp1 = (y + 1) * w;
      const yp2 = (y + 2) * w;
      for (let x = 0; x < w; x++) {
        vals[0] = lum[ym2 + x];
        vals[1] = lum[ym1 + x];
        vals[2] = lum[y0 + x];
        vals[3] = lum[yp1 + x];
        vals[4] = lum[yp2 + x];
        // Sắp xếp chèn 5 phần tử siêu tốc lấy trung vị chính giữa
        for (let a = 1; a < 5; a++) {
          const key = vals[a];
          let b = a - 1;
          while (b >= 0 && vals[b] > key) {
            vals[b + 1] = vals[b];
            b--;
          }
          vals[b + 1] = key;
        }
        const v = vals[2];
        const p = (y0 + x) * 4;
        d[p] = v;
        d[p + 1] = v;
        d[p + 2] = v;
        d[p + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return enhanceSoftGrayscaleCanvas(tmp);
  }

  // Phát hiện & khử tức thì sọc ngang chu kỳ màn hình (LCD) ngay ở tỷ lệ gốc 1.0x trước khi phóng to (0 chạm vào ảnh chụp giấy thường!)
  function tryDescreenPeriodicScanlines1x(fullCanvas, cx, cy, angle, uMin, vMin, uSpan, vSpan, paperRgb) {
    const rawW = Math.max(60, Math.round(uSpan));
    const rawH = Math.max(40, Math.round(vSpan));
    if (rawW > 1200 || rawH > 1200) return null;

    const c1 = document.createElement('canvas');
    c1.width = rawW;
    c1.height = rawH;
    const ctx1 = c1.getContext('2d', { willReadFrequently: true });
    ctx1.fillStyle = paperRgb;
    ctx1.fillRect(0, 0, rawW, rawH);
    ctx1.save();
    ctx1.translate(-uMin, -vMin);
    ctx1.rotate(-angle);
    ctx1.translate(-cx, -cy);
    ctx1.drawImage(fullCanvas, 0, 0);
    ctx1.restore();

    const img = ctx1.getImageData(0, 0, rawW, rawH);
    const d = img.data;
    const x0 = Math.floor(rawW * 0.15);
    const x1 = Math.max(x0 + 8, Math.floor(rawW * 0.85));
    const y0 = Math.max(1, Math.floor(rawH * 0.12));
    const y1 = Math.min(rawH - 2, Math.floor(rawH * 0.88));
    if (y1 - y0 < 8) return null;

    const rowMeans = new Float32Array(rawH);
    const invW = 1 / (x1 - x0);
    for (let y = y0 - 1; y <= y1 + 1; y++) {
      let sum = 0;
      const ro = y * rawW;
      for (let x = x0; x < x1; x++) {
        const p = (ro + x) * 4;
        sum += (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8;
      }
      rowMeans[y] = sum * invW;
    }

    let spikeSum = 0;
    let spikeCnt = 0;
    for (let y = y0; y <= y1; y++) {
      spikeSum += Math.abs(rowMeans[y] - 0.5 * (rowMeans[y - 1] + rowMeans[y + 1]));
      spikeCnt++;
    }
    const avgSpike = spikeCnt > 0 ? (spikeSum / spikeCnt) : 0;
    if (avgSpike <= 2.4) {
      return null;
    }

    // Có sọc ngang màn hình rõ rệt -> lọc trung vị dọc 3 điểm ở đúng độ phân giải gốc 1.0x để xóa sạch 100% vạch sọc!
    const lum = new Uint8Array(rawW * rawH);
    for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
      lum[i] = (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8;
    }
    for (let y = 1; y < rawH - 1; y++) {
      const ym1 = (y - 1) * rawW;
      const yc = y * rawW;
      const yp1 = (y + 1) * rawW;
      for (let x = 0; x < rawW; x++) {
        const a = lum[ym1 + x];
        const b = lum[yc + x];
        const c = lum[yp1 + x];
        const med = a > b ? (b > c ? b : (a > c ? c : a)) : (a > c ? a : (b > c ? c : b));
        const p = (yc + x) * 4;
        d[p] = med;
        d[p + 1] = med;
        d[p + 2] = med;
        d[p + 3] = 255;
      }
    }
    ctx1.putImageData(img, 0, 0);
    return c1;
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
        if (v > 242) {
          v = 255;
        } else {
          v = Math.max(0, Math.min(255, Math.round(((v - 58) * 255) / 184)));
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

  // Chuẩn hóa trục dài của mã vạch 1D: trên một số dòng điện thoại Android khi cầm xoay ngang 90°,
  // bộ nhận diện phần cứng trả về cạnh ngắn trước cạnh dài -> xoay lại đúng trục 95 vạch sọc!
  function normalizeBarcodePosMajorAxis(pos) {
    if (!pos || !pos.topLeft || !pos.topRight || !pos.bottomRight || !pos.bottomLeft) {
      return null;
    }
    const side01 = Math.hypot(pos.topRight.x - pos.topLeft.x, pos.topRight.y - pos.topLeft.y);
    const side12 = Math.hypot(pos.bottomRight.x - pos.topRight.x, pos.bottomRight.y - pos.topRight.y);
    if (side12 > side01 * 1.25) {
      return {
        topLeft: pos.topRight,
        topRight: pos.bottomRight,
        bottomRight: pos.bottomLeft,
        bottomLeft: pos.topLeft
      };
    }
    return pos;
  }

  function hasDateZoneInsideFrame(rawPos, frameW, frameH) {
    const pos = normalizeBarcodePosMajorAxis(rawPos);
    if (!pos || !frameW || !frameH) return true;
    const dx = pos.topRight.x - pos.topLeft.x;
    const dy = pos.topRight.y - pos.topLeft.y;
    const bw = Math.hypot(dx, dy);
    if (!bw || bw < 24) return true;

    const cosA = dx / bw;
    const sinA = dy / bw;
    const cx = (pos.topLeft.x + pos.topRight.x + pos.bottomRight.x + pos.bottomLeft.x) / 4;
    const cy = (pos.topLeft.y + pos.topRight.y + pos.bottomRight.y + pos.bottomLeft.y) / 4;

    // Kiểm tra đúng tâm khung chữ nhật góc trái dưới cùng của tem Meatcool (B2B & Bán lẻ: u = -0.32*bw..-0.76*bw, v = +0.78*bw),
    // giúp cả ảnh dí sát cận cảnh lấp đầy màn hình điện thoại vẫn nhận diện trọn vẹn 100%!
    const margin = 4;
    const pxNum = cx + (-0.32 * bw) * cosA + (0.78 * bw) * (-sinA);
    const pyNum = cy + (-0.32 * bw) * sinA + (0.78 * bw) * cosA;
    const pxLbl = cx + (-0.76 * bw) * cosA + (0.74 * bw) * (-sinA);
    const pyLbl = cy + (-0.76 * bw) * sinA + (0.74 * bw) * cosA;
    return (
      pxNum >= margin &&
      pxNum <= (frameW - margin) &&
      pyNum >= margin &&
      pyNum <= (frameH - margin) &&
      pxLbl >= margin &&
      pxLbl <= (frameW - margin) &&
      pyLbl >= margin &&
      pyLbl <= (frameH - margin)
    );
  }

  function measureDateZoneSharpness(fullCanvas, rawPos) {
    try {
      const pos = normalizeBarcodePosMajorAxis(rawPos);
      if (!fullCanvas || !pos) return 10;
      const dx = pos.topRight.x - pos.topLeft.x;
      const dy = pos.topRight.y - pos.topLeft.y;
      const bw = Math.hypot(dx, dy);
      if (!bw || bw < 24) return 10;

      const angle = Math.atan2(dy, dx);
      const cx = (pos.topLeft.x + pos.topRight.x + pos.bottomRight.x + pos.bottomLeft.x) / 4;
      const cy = (pos.topLeft.y + pos.topRight.y + pos.bottomRight.y + pos.bottomLeft.y) / 4;

      const sw = 96;
      const sh = 48;
      const tiny = document.createElement('canvas');
      tiny.width = sw;
      tiny.height = sh;
      const tCtx = tiny.getContext('2d', { willReadFrequently: true });
      const scaleX = sw / (1.36 * bw);
      const scaleY = sh / (1.16 * bw);
      tCtx.save();
      tCtx.scale(scaleX, scaleY);
      tCtx.translate(0.96 * bw, -0.36 * bw);
      tCtx.rotate(-angle);
      tCtx.translate(-cx, -cy);
      tCtx.drawImage(fullCanvas, 0, 0);
      tCtx.restore();

      const d = tCtx.getImageData(0, 0, sw, sh).data;
      let gradSum = 0;
      let prevG = 0;
      for (let y = 1; y < sh - 1; y++) {
        const rowOff = y * sw;
        prevG = (d[rowOff * 4] * 77 + d[rowOff * 4 + 1] * 150 + d[rowOff * 4 + 2] * 29) >> 8;
        for (let x = 1; x < sw - 1; x++) {
          const p = (rowOff + x) * 4;
          const g = (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8;
          gradSum += Math.abs(g - prevG);
          prevG = g;
        }
      }
      return gradSum / ((sw - 2) * (sh - 2));
    } catch (e) {
      return 10;
    }
  }

  function buildRawBarcodeGuidedCropCanvas(fullCanvas, rawPos, extraDeg, customBounds) {
    const pos = normalizeBarcodePosMajorAxis(rawPos);
    if (!pos) return null;
    const dx = pos.topRight.x - pos.topLeft.x;
    const dy = pos.topRight.y - pos.topLeft.y;
    const bw = Math.hypot(dx, dy);
    if (!bw || bw < 20) return null;

    const angle = Math.atan2(dy, dx) + (((extraDeg || 0) * Math.PI) / 180);
    const cx = (pos.topLeft.x + pos.topRight.x + pos.bottomRight.x + pos.bottomLeft.x) / 4;
    const cy = (pos.topLeft.y + pos.topRight.y + pos.bottomRight.y + pos.bottomLeft.y) / 4;

    // Thu gọn mép phải uMax = +0.42 * bw để chừa khoảng trắng rộng sau chữ số năm 2026 (+0.18 * bw), tách sạch khỏi ô vuông góc phải (+0.51 * bw) và nền tối bên ngoài tem!
    const uMin = ((customBounds && typeof customBounds.uMin === 'number') ? customBounds.uMin : -0.96) * bw;
    const uSpan = ((customBounds && typeof customBounds.uSpan === 'number') ? customBounds.uSpan : 1.38) * bw;
    const vMin = ((customBounds && typeof customBounds.vMin === 'number') ? customBounds.vMin : 0.34) * bw;
    const vSpan = ((customBounds && typeof customBounds.vSpan === 'number') ? customBounds.vSpan : 1.02) * bw;

    // Phóng vùng chữ lên chuẩn 620px chiều ngang sọc (hỗ trợ tới 5.6x cho tem cầm xa 30-45cm trên ống kính rộng ĐT, giữ nguyên khe hở chữ số 6)!
    const targetBw = (customBounds && typeof customBounds.targetBw === 'number') ? customBounds.targetBw : 620;
    const minScale = (customBounds && typeof customBounds.minScale === 'number') ? customBounds.minScale : 1.45;
    const scale = Math.min(5.6, Math.max(minScale, targetBw / bw));
    const outW = Math.max(180, Math.round(uSpan * scale));
    const outH = Math.max(90, Math.round(vSpan * scale));

    const roi = document.createElement('canvas');
    roi.width = outW;
    roi.height = outH;
    const rCtx = roi.getContext('2d', { willReadFrequently: true });
    const paperRgb = sampleBrightPaperRgb(fullCanvas, cx, cy);
    rCtx.fillStyle = paperRgb;
    rCtx.fillRect(0, 0, outW, outH);

    const clean1x = tryDescreenPeriodicScanlines1x(fullCanvas, cx, cy, angle, uMin, vMin, uSpan, vSpan, paperRgb);
    if (clean1x) {
      rCtx.drawImage(clean1x, 0, 0, clean1x.width, clean1x.height, 0, 0, outW, outH);
      return roi;
    }

    rCtx.save();
    rCtx.scale(scale, scale);
    rCtx.translate(-uMin, -vMin);
    rCtx.rotate(-angle);
    rCtx.translate(-cx, -cy);
    rCtx.drawImage(fullCanvas, 0, 0);
    rCtx.restore();

    return roi;
  }

  function cropCenterAimFromCanvas(srcCanvas) {
    if (!srcCanvas) return null;
    const cw = srcCanvas.width;
    const ch = srcCanvas.height;
    const sx = Math.round(cw * 0.06);
    const sy = Math.round(ch * 0.16);
    const sw = Math.max(160, Math.round(cw * 0.88));
    const sh = Math.max(110, Math.round(ch * 0.68));
    const maxOut = 1120;
    const scale = Math.min(1.6, maxOut / Math.max(1, Math.max(sw, sh)));
    const ow = Math.max(180, Math.round(sw * scale));
    const oh = Math.max(110, Math.round(sh * scale));
    const c = document.createElement('canvas');
    c.width = ow;
    c.height = oh;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, ow, oh);
    ctx.drawImage(srcCanvas, sx, sy, sw, sh, 0, 0, ow, oh);
    return c;
  }

  function buildFullFrameDateCanvas(fullCanvas, degRotate) {
    const maxDim = 1280;
    const scale = Math.min(1.5, maxDim / Math.max(1, Math.max(fullCanvas.width, fullCanvas.height)));
    const w = Math.max(180, Math.round(fullCanvas.width * scale));
    const h = Math.max(110, Math.round(fullCanvas.height * scale));
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

  function cropBottomLeftDateZoneFromCanvas(srcCanvas) {
    if (!srcCanvas) return null;
    const cw = srcCanvas.width;
    const ch = srcCanvas.height;
    // Cắt thẳng góc trái dưới cùng của mặt tem (loại bỏ hoàn toàn dãy số mã vạch ở trên và ô vuông góc phải bên dưới!)
    const sx = Math.round(cw * 0.02);
    const sy = Math.round(ch * 0.44);
    const sw = Math.max(140, Math.round(cw * 0.66));
    const sh = Math.max(95, Math.round(ch * 0.52));
    const targetW = 720;
    const scale = Math.min(2.4, Math.max(1.15, targetW / Math.max(1, sw)));
    const ow = Math.max(180, Math.round(sw * scale));
    const oh = Math.max(110, Math.round(sh * scale));
    const c = document.createElement('canvas');
    c.width = ow;
    c.height = oh;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, ow, oh);
    ctx.drawImage(srcCanvas, sx, sy, sw, sh, 0, 0, ow, oh);
    return c;
  }

  function hasWhiteLabelPaperInFrame(srcCanvas) {
    try {
      if (!srcCanvas || srcCanvas.width < 40 || srcCanvas.height < 40) return false;
      const ctx = srcCanvas.getContext('2d', { willReadFrequently: true });
      const sx = Math.floor(srcCanvas.width * 0.16);
      const sy = Math.floor(srcCanvas.height * 0.18);
      const sw = Math.max(20, Math.floor(srcCanvas.width * 0.68));
      const sh = Math.max(20, Math.floor(srcCanvas.height * 0.64));
      const d = ctx.getImageData(sx, sy, sw, sh).data;
      let brightCnt = 0;
      let darkInkCnt = 0;
      let total = 0;
      const stride = Math.max(16, Math.floor(d.length / 1800) * 4);
      for (let i = 0; i < d.length; i += stride) {
        const g = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
        if (g >= 152) brightCnt++;
        else if (g <= 95) darkInkCnt++;
        total++;
      }
      if (total <= 0) return false;
      return (brightCnt / total) >= 0.28 && (darkInkCnt / total) >= 0.015;
    } catch (e) {
      return false;
    }
  }

  function mergeDatePair(base, next) {
    if (!next || (!next.nsx && !next.hsd)) {
      return {
        nsx: (base && base.nsx) ? base.nsx : '',
        hsd: (base && base.hsd) ? base.hsd : '',
        suspectYearGap: Boolean(base && base.suspectYearGap)
      };
    }
    if (!base || (!base.nsx && !base.hsd)) {
      return {
        nsx: next.nsx || '',
        hsd: next.hsd || '',
        suspectYearGap: Boolean(next.suspectYearGap)
      };
    }
    // Nếu kết quả trước bị nghi lệch năm (VD: chữ số 6 vuông bị đọc nhầm thành 2028):
    // - Nếu lượt sau đọc sạch cả 2 ngày khớp năm -> ưu tiên lượt sạch 100%!
    // - Nếu lượt sau đọc rõ 1 ngày (NSX hoặc HSD) mà khi ghép vào sẽ khớp cùng năm hợp lệ (<= 350 ngày) -> thay thế ngay nửa bị nhiễu năm!
    if (base.suspectYearGap && next.nsx && next.hsd && !next.suspectYearGap) {
      return { nsx: next.nsx, hsd: next.hsd, suspectYearGap: false };
    }
    if (base.suspectYearGap && (next.nsx || next.hsd)) {
      const bN = (base.nsx || '').split('/');
      const bH = (base.hsd || '').split('/');
      const minBaseYear = (bN.length === 3 && bH.length === 3)
        ? Math.min(parseInt(bN[2], 10), parseInt(bH[2], 10))
        : 9999;
      const candNsx = next.nsx || base.nsx || '';
      const candHsd = next.hsd || base.hsd || '';
      const cN = candNsx.split('/');
      const cH = candHsd.split('/');
      if (cN.length === 3 && cH.length === 3) {
        const yN = parseInt(cN[2], 10);
        const yH = parseInt(cH[2], 10);
        const ctN = new Date(yN, parseInt(cN[1], 10) - 1, parseInt(cN[0], 10)).getTime();
        const ctH = new Date(yH, parseInt(cH[1], 10) - 1, parseInt(cH[0], 10)).getTime();
        if (yN <= minBaseYear && yH <= minBaseYear && ctH >= ctN && (ctH - ctN) <= 350 * 86400000) {
          return { nsx: candNsx, hsd: candHsd, suspectYearGap: false };
        }
      }
    }
    if (next.suspectYearGap && base.nsx && base.hsd && !base.suspectYearGap) {
      return { nsx: base.nsx, hsd: base.hsd, suspectYearGap: false };
    }
    if (next.nsx && next.hsd && (!base.nsx || !base.hsd)) {
      return {
        nsx: next.nsx,
        hsd: next.hsd,
        suspectYearGap: Boolean(next.suspectYearGap)
      };
    }
    const mergedNsx = base.nsx || next.nsx || '';
    const mergedHsd = base.hsd || next.hsd || '';
    let mergedSuspect = Boolean(base.suspectYearGap || next.suspectYearGap);
    if (mergedNsx && mergedHsd) {
      const pN = mergedNsx.split('/');
      const pH = mergedHsd.split('/');
      if (pN.length === 3 && pH.length === 3) {
        const tN = new Date(parseInt(pN[2], 10), parseInt(pN[1], 10) - 1, parseInt(pN[0], 10)).getTime();
        const tH = new Date(parseInt(pH[2], 10), parseInt(pH[1], 10) - 1, parseInt(pH[0], 10)).getTime();
        if (tN > tH) {
          return (next.nsx && next.hsd)
            ? { nsx: next.nsx, hsd: next.hsd, suspectYearGap: Boolean(next.suspectYearGap) }
            : { nsx: base.nsx || '', hsd: base.hsd || '', suspectYearGap: Boolean(base.suspectYearGap) };
        }
        mergedSuspect = Boolean((tH - tN) > 400 * 86400000);
      }
    }
    return { nsx: mergedNsx, hsd: mergedHsd, suspectYearGap: mergedSuspect };
  }

  // Đo nhanh điểm "giấy trắng có chữ mực đen" ở vùng dưới (+v) so với vùng trên (-v) của mã vạch (~0.15ms):
  // Giúp nhận diện tức thì khi bộ đọc phần cứng Android trả về khung mã vạch bị ngược 180° hoặc cầm ngang 90°!
  function preferFlipped180BarcodeSide(fullCanvas, rawPos) {
    try {
      const pos = normalizeBarcodePosMajorAxis(rawPos);
      if (!fullCanvas || !pos) return false;
      const dx = pos.topRight.x - pos.topLeft.x;
      const dy = pos.topRight.y - pos.topLeft.y;
      const bw = Math.hypot(dx, dy);
      if (!bw || bw < 24) return false;

      const scoreSide = function (degAdd) {
        const angle = Math.atan2(dy, dx) + ((degAdd * Math.PI) / 180);
        const cx = (pos.topLeft.x + pos.topRight.x + pos.bottomRight.x + pos.bottomLeft.x) / 4;
        const cy = (pos.topLeft.y + pos.topRight.y + pos.bottomRight.y + pos.bottomLeft.y) / 4;
        const sw = 48;
        const sh = 28;
        const tiny = document.createElement('canvas');
        tiny.width = sw;
        tiny.height = sh;
        const tCtx = tiny.getContext('2d', { willReadFrequently: true });
        tCtx.fillStyle = '#000000';
        tCtx.fillRect(0, 0, sw, sh);
        tCtx.save();
        tCtx.scale(sw / (1.10 * bw), sh / (0.68 * bw));
        tCtx.translate(0.78 * bw, -0.56 * bw);
        tCtx.rotate(-angle);
        tCtx.translate(-cx, -cy);
        tCtx.drawImage(fullCanvas, 0, 0);
        tCtx.restore();

        const d = tCtx.getImageData(0, 0, sw, sh).data;
        let brightCnt = 0;
        let edgeSum = 0;
        for (let y = 1; y < sh - 1; y++) {
          const ro = y * sw;
          let prev = (d[ro * 4] * 77 + d[ro * 4 + 1] * 150 + d[ro * 4 + 2] * 29) >> 8;
          for (let x = 1; x < sw - 1; x++) {
            const p = (ro + x) * 4;
            const g = (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8;
            if (g > 155) brightCnt++;
            edgeSum += Math.abs(g - prev);
            prev = g;
          }
        }
        const total = (sw - 2) * (sh - 2);
        return (brightCnt / total) * 100 + (edgeSum / total);
      };

      const s0 = scoreSide(0);
      const s180 = scoreSide(180);
      return s180 > s0 + 18;
    } catch (e) {
      return false;
    }
  }

  function canvasHasTextContrast(c) {
    try {
      if (!c || c.width < 12 || c.height < 12) return true;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      const sx = Math.floor(c.width * 0.08);
      const sy = Math.floor(c.height * 0.10);
      const sw = Math.max(8, Math.floor(c.width * 0.84));
      const sh = Math.max(8, Math.floor(c.height * 0.80));
      const d = ctx.getImageData(sx, sy, sw, sh).data;
      let minG = 255;
      let maxG = 0;
      for (let i = 0; i < d.length; i += 16) {
        const g = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
        if (g < minG) minG = g;
        if (g > maxG) maxG = g;
        if ((maxG - minG) >= 26) return true;
      }
      return (maxG - minG) >= 26;
    } catch (e) {
      return true;
    }
  }

  async function runQueuedOcrOnCanvas(worker, fullCanvas, barcodePos, allowTiltedFallback, cancelState, rescueAimCropCanvas) {
    let best = { nsx: '', hsd: '' };
    const DATE_WHITELIST = '0123456789.:/-NSXHD ';
    const DIGITS_ONLY_WHITELIST = '0123456789.:/- ';
    const isAborted = function () { return Boolean(cancelState && cancelState.aborted); };
    const recordHit = function (resObj) {
      const parsed = parseOcrNsxHsdText(resObj && resObj.data ? resObj.data.text : '');
      best = mergeDatePair(best, parsed);
      if (cancelState) cancelState.partial = best;
      return Boolean(best.nsx && best.hsd && !best.suspectYearGap);
    };

    if (isAborted()) return best;

    // TRƯỜNG HỢP 1: ĐÃ BIẾT TỌA ĐỘ MÃ VẠCH (99% các ca quét Camera & Ảnh tem)
    if (barcodePos) {
      // Vùng chuẩn bao trọn góc trái dưới cùng của cả tem Meatcool Bán lẻ lẫn tem B2B Kho (tách sạch mép ngoài tránh ăn nền tối kho lạnh!)
      const rawRoi = buildRawBarcodeGuidedCropCanvas(fullCanvas, barcodePos, 0);
      // Vùng tách riêng đúng cột chữ số ngày bên phải (u = -0.56..+0.30, v = 0.36..1.26):
      // Tách sạch nhãn NSX:/HSD: bên trái -> triệt tiêu 100% hiện tượng cong bao bì làm chữ NSX: tụt thấp hơn dãy số ngày!
      const datesColRoi = buildRawBarcodeGuidedCropCanvas(fullCanvas, barcodePos, 0, {
        uMin: -0.56,
        uSpan: 0.86,
        vMin: 0.36,
        vSpan: 0.90,
        targetBw: 620
      });
      const deepRoi = buildRawBarcodeGuidedCropCanvas(fullCanvas, barcodePos, 0, {
        uMin: -0.96,
        uSpan: 1.38,
        vMin: 0.34,
        vSpan: 1.24
      });

      const inkCheckRoi = buildRawBarcodeGuidedCropCanvas(fullCanvas, barcodePos, 0, {
        uMin: -0.60,
        uSpan: 1.00,
        vMin: 0.52,
        vSpan: 0.72,
        targetBw: 260,
        minScale: 0.8
      });
      const bottomZoneHasInk = canvasHasTextContrast(inkCheckRoi);
      let softRawCanvas = null;
      const getSoftRaw = function () {
        if (!softRawCanvas && rawRoi) softRawCanvas = enhanceSoftGrayscaleCanvas(rawRoi);
        return softRawCanvas;
      };

      // 1A: Xám mịn độ phân giải cao ở góc 0° (PSM 6 — ~85ms cho tem phẳng Bán lẻ & chụp xa 35-50cm)
      if (bottomZoneHasInk && rawRoi && !isAborted()) {
        await worker.setParameters({
          tessedit_pageseg_mode: '6',
          tessedit_char_whitelist: DATE_WHITELIST
        });
        const resSoft6 = await worker.recognize(getSoftRaw());
        if (recordHit(resSoft6)) return best;
      }

      // 1B: Khôi phục nét chữ mờ cận cảnh 12-18cm / luồng video Camera nén (~90ms, giữ chuẩn chữ số 6 trên luồng video trực tiếp!)
      if (bottomZoneHasInk && rawRoi && !isAborted()) {
        await worker.setParameters({
          tessedit_pageseg_mode: '6',
          tessedit_char_whitelist: DATE_WHITELIST
        });
        const resSharp6 = await worker.recognize(sharpenDefocusedTextCanvas(rawRoi));
        if (recordHit(resSharp6)) return best;
      }

      // 1B-2: Tách đảo chữ độc lập ở tỷ lệ chuẩn 520px (PSM 11 trên nền xám mịn — ĐẶC TRỊ TEM B2B KHO DÁN TRÊN TÚI THỊT 6-8KG PHỒNG CONG ở mọi cự ly gần/vừa/xa, không bao giờ nhầm 2028 trên tem bóng đổ!)
      if (bottomZoneHasInk && !isAborted()) {
        const b2bRoi = buildRawBarcodeGuidedCropCanvas(fullCanvas, barcodePos, 0, {
          uMin: -0.96,
          uSpan: 1.38,
          vMin: 0.34,
          vSpan: 0.96,
          targetBw: 520,
          minScale: 1.15
        });
        if (b2bRoi) {
          await worker.setParameters({
            tessedit_pageseg_mode: '11',
            tessedit_char_whitelist: DATE_WHITELIST
          });
          const resB2b11 = await worker.recognize(enhanceSoftGrayscaleCanvas(b2bRoi));
          if (recordHit(resB2b11)) return best;
        }
      }

      // 1C: Khử bóng đổ / Khử sọc màn hình máy tính & góc chúc kéo dài dọc 1.18x (~0.18s — đọc chuẩn tem bóng đổ trên luồng video!)
      if (bottomZoneHasInk && (rawRoi || deepRoi) && !isAborted()) {
        await worker.setParameters({
          tessedit_pageseg_mode: '11',
          tessedit_char_whitelist: DATE_WHITELIST
        });
        if (rawRoi && !isAborted()) {
          const resFlat = await worker.recognize(flattenIlluminationToCanvas(rawRoi));
          if (recordHit(resFlat)) return best;
        }
        if (deepRoi && !isAborted()) {
          const resDeepFlat = await worker.recognize(flattenIlluminationToCanvas(deepRoi));
          if (recordHit(resDeepFlat)) return best;
        }
      }

      // 1C-2: Cắt riêng cột chữ số ngày bên phải trên nền xám mịn (~70ms, dự phòng cho tem B2B khung viền đỏ hoặc chỉ có boundingBox!)
      if (bottomZoneHasInk && datesColRoi && !isAborted()) {
        const colSoft = enhanceSoftGrayscaleCanvas(datesColRoi);
        await worker.setParameters({
          tessedit_pageseg_mode: '6',
          tessedit_char_whitelist: DIGITS_ONLY_WHITELIST
        });
        const resColSoft = await worker.recognize(colSoft);
        if (recordHit(resColSoft)) return best;
      }

      // 1D: Bù góc nghiêng tay cầm dư [-4°, +4°, -8°, +8°] ngay lập tức (~0.13s/góc, chuẩn cho kho lạnh tối 28% & ảnh nghiêng 5°..20°)
      await worker.setParameters({
        tessedit_pageseg_mode: '6',
        tessedit_char_whitelist: DATE_WHITELIST
      });
      if (bottomZoneHasInk) {
        const tiltMicroAngles = [-4, 4, -8, 8];
        for (let tIdx = 0; tIdx < tiltMicroAngles.length; tIdx++) {
          if (isAborted()) return best;
          const adjRoi = buildRawBarcodeGuidedCropCanvas(fullCanvas, barcodePos, tiltMicroAngles[tIdx]);
          if (adjRoi) {
            const resAdj6 = await worker.recognize(enhanceSoftGrayscaleCanvas(adjRoi));
            if (recordHit(resAdj6)) return best;
          }
        }
      }

      // 1E: Túi hàng đặt lộn ngược đầu [180°] hoặc cầm ngang 90° trên điện thoại Android (~0.16s)
      if (!isAborted()) {
        const roi180 = buildRawBarcodeGuidedCropCanvas(fullCanvas, barcodePos, 180);
        if (roi180 && canvasHasTextContrast(roi180)) {
          const soft180 = enhanceSoftGrayscaleCanvas(roi180);
          await worker.setParameters({
            tessedit_pageseg_mode: '6',
            tessedit_char_whitelist: DATE_WHITELIST
          });
          const res180 = await worker.recognize(soft180);
          if (recordHit(res180)) return best;
          if (!isAborted()) {
            const datesCol180 = buildRawBarcodeGuidedCropCanvas(fullCanvas, barcodePos, 180, {
              uMin: -0.56,
              uSpan: 0.86,
              vMin: 0.36,
              vSpan: 0.90,
              targetBw: 620
            });
            if (datesCol180) {
              await worker.setParameters({
                tessedit_pageseg_mode: '6',
                tessedit_char_whitelist: DIGITS_ONLY_WHITELIST
              });
              const resCol180 = await worker.recognize(enhanceSoftGrayscaleCanvas(datesCol180));
              if (recordHit(resCol180)) return best;
            }
          }
          if (!isAborted()) {
            await worker.setParameters({
              tessedit_pageseg_mode: '11',
              tessedit_char_whitelist: DATE_WHITELIST
            });
            const res180Sparse = await worker.recognize(soft180);
            if (recordHit(res180Sparse)) return best;
          }
          if (!isAborted()) {
            await worker.setParameters({
              tessedit_pageseg_mode: '6',
              tessedit_char_whitelist: DATE_WHITELIST
            });
            const res180Sharp = await worker.recognize(sharpenDefocusedTextCanvas(roi180));
            if (recordHit(res180Sharp)) return best;
          }
        }
      }

      if (bottomZoneHasInk && deepRoi && !isAborted()) {
        await worker.setParameters({
          tessedit_pageseg_mode: '6',
          tessedit_char_whitelist: DATE_WHITELIST
        });
        const resDeepSoft = await worker.recognize(enhanceSoftGrayscaleCanvas(deepRoi));
        if (recordHit(resDeepSoft)) return best;
      }
      if (bottomZoneHasInk && (deepRoi || rawRoi) && !isAborted()) {
        const resLcd = await worker.recognize(descreenLcdCanvas(deepRoi || rawRoi));
        if (recordHit(resLcd)) return best;
      }

      // 1F: Mở rộng toàn chiều ngang tem cân kho/siêu thị (cho loại tem in NSX bên trái — HSD bên phải sang tận mép phải u=+0.9*bw hoặc năm 2 số!)
      if (bottomZoneHasInk && !isAborted()) {
        const wideScaleRoi = buildRawBarcodeGuidedCropCanvas(fullCanvas, barcodePos, 0, {
          uMin: -1.04,
          uSpan: 2.08,
          vMin: 0.36,
          vSpan: 1.24,
          targetBw: 420,
          minScale: 1.0
        });
        if (wideScaleRoi) {
          await worker.setParameters({
            tessedit_pageseg_mode: '6',
            tessedit_char_whitelist: DATE_WHITELIST
          });
          if (!isAborted()) {
            const resWide6 = await worker.recognize(enhanceSoftGrayscaleCanvas(wideScaleRoi));
            if (recordHit(resWide6)) return best;
          }
          await worker.setParameters({
            tessedit_pageseg_mode: '11',
            tessedit_char_whitelist: DATE_WHITELIST
          });
          if (!isAborted()) {
            const resWideFlat = await worker.recognize(flattenIlluminationToCanvas(wideScaleRoi));
            if (recordHit(resWideFlat)) return best;
          }
        }
      }

      // 1G: Dự phòng toàn mặt tem (cho ảnh chụp tem cân đặc thù in NSX/HSD phía TRÊN mã vạch!)
      if (allowTiltedFallback && (!best.nsx || !best.hsd) && !isAborted()) {
        const wholeLabelRoi = buildRawBarcodeGuidedCropCanvas(fullCanvas, barcodePos, 0, {
          uMin: -1.06,
          uSpan: 2.12,
          vMin: -1.02,
          vSpan: 2.50,
          targetBw: 380,
          minScale: 0.95
        });
        if (wholeLabelRoi) {
          await worker.setParameters({
            tessedit_pageseg_mode: '11',
            tessedit_char_whitelist: DATE_WHITELIST
          });
          if (!isAborted()) {
            const resWhole = await worker.recognize(enhanceSoftGrayscaleCanvas(wholeLabelRoi));
            if (recordHit(resWhole)) return best;
          }
        }
      }

      // Nếu đã tìm đủ hoặc vùng dưới hoàn toàn trống trơn (tem rách cụt phần dưới) thì trả về ngay;
      // Ngược lại nếu tọa độ mã vạch trên một số dòng điện thoại bị lệch tỷ lệ khung hình -> rơi tiếp xuống quét trực tiếp góc trái dưới!
      if ((best.nsx && best.hsd) || !bottomZoneHasInk || isAborted()) {
        return best;
      }
    }

    // TRƯỜNG HỢP 2: QUÉT TRỰC TIẾP GÓC TRÁI DƯỚI TEM / CHỤP BÙ NGÀY CẬN CẢNH (KHI KHÔNG CÓ TỌA ĐỘ MÃ VẠCH HOẶC TỌA ĐỘ CAMERA BỊ LỆCH)
    if ((!best.nsx || !best.hsd || best.suspectYearGap) && !isAborted()) {
      const botLeftCrop = cropBottomLeftDateZoneFromCanvas(fullCanvas);
      if (botLeftCrop && canvasHasTextContrast(botLeftCrop)) {
        const softBL = enhanceSoftGrayscaleCanvas(botLeftCrop);
        await worker.setParameters({
          tessedit_pageseg_mode: '11',
          tessedit_char_whitelist: DATE_WHITELIST
        });
        if (!isAborted()) {
          const resBL11 = await worker.recognize(softBL);
          if (recordHit(resBL11)) return best;
        }
        await worker.setParameters({
          tessedit_pageseg_mode: '6',
          tessedit_char_whitelist: DATE_WHITELIST
        });
        if (!isAborted()) {
          const resBL6 = await worker.recognize(softBL);
          if (recordHit(resBL6)) return best;
        }
      }
    }

    if (rescueAimCropCanvas && !isAborted()) {
      const softAim = enhanceSoftGrayscaleCanvas(rescueAimCropCanvas);
      await worker.setParameters({
        tessedit_pageseg_mode: '6',
        tessedit_char_whitelist: ''
      });
      if (isAborted()) return best;
      const resAimSoft = await worker.recognize(softAim);
      if (recordHit(resAimSoft)) return best;
      if (!isAborted()) {
        await worker.setParameters({
          tessedit_pageseg_mode: '11',
          tessedit_char_whitelist: DATE_WHITELIST
        });
        const resAim11 = await worker.recognize(softAim);
        if (recordHit(resAim11)) return best;
      }
      if (!isAborted()) {
        await worker.setParameters({
          tessedit_pageseg_mode: '6',
          tessedit_char_whitelist: ''
        });
        const resAimSharp = await worker.recognize(sharpenDefocusedTextCanvas(rescueAimCropCanvas));
        if (recordHit(resAimSharp)) return best;
      }
    }

    if (isAborted()) return best;
    await worker.setParameters({
      tessedit_pageseg_mode: '11',
      tessedit_char_whitelist: ''
    });
    if (isAborted()) return best;
    const full0 = buildFullFrameDateCanvas(fullCanvas, 0);
    const resFull0 = await worker.recognize(full0);
    if (recordHit(resFull0)) return best;

    if (allowTiltedFallback && (!best.nsx || !best.hsd) && !isAborted()) {
      const angles = [-14, 14, 180];
      for (let i = 0; i < angles.length; i++) {
        if (isAborted()) return best;
        const tiltedCanvas = buildFullFrameDateCanvas(fullCanvas, angles[i]);
        const resTilt = await worker.recognize(tiltedCanvas);
        if (recordHit(resTilt)) return best;
      }
    }

    return best;
  }

  async function extractNsxHsdWithTimeout(fullCanvas, barcodePos, timeoutMs, allowTiltedFallback, rescueAimCropCanvas) {
    if (!fullCanvas || !window.Tesseract) return { nsx: '', hsd: '' };

    // Chờ nạp bộ đọc chữ lần đầu riêng biệt (tối đa 10 giây nếu sóng 4G yếu lần đầu mở), không để ăn lẹm vào thời gian đọc ảnh!
    const worker = await new Promise(function (resolve) {
      let done = false;
      const wTimer = setTimeout(function () {
        if (!done) { done = true; resolve(null); }
      }, ocrWorkerResolved ? 2000 : 10000);
      warmUpOcrWorker().then(function (w) {
        if (!done) { done = true; clearTimeout(wTimer); resolve(w); }
      }).catch(function () {
        if (!done) { done = true; clearTimeout(wTimer); resolve(null); }
      });
    });
    if (!worker) return { nsx: '', hsd: '' };

    // Hàng đợi tuần tự tuyệt đối (0 bao giờ gọi chồng 2 lệnh lên cùng 1 worker!), kết hợp cờ hủy tức thì (cancelState.aborted)
    const perItemBudgetMs = timeoutMs || (barcodePos ? 2600 : 4000);
    return new Promise(function (resolve) {
      let settled = false;
      let itemTimer = null;
      const cancelState = { aborted: false, partial: { nsx: '', hsd: '' } };

      const finishCaller = function (val) {
        if (settled) return;
        settled = true;
        clearTimeout(outerSafetyTimer);
        if (itemTimer) clearTimeout(itemTimer);
        resolve(val || cancelState.partial || { nsx: '', hsd: '' });
      };

      const outerSafetyTimer = setTimeout(function () {
        cancelState.aborted = true;
        finishCaller(cancelState.partial);
      }, 9500);

      ocrQueuePromise = ocrQueuePromise.then(function () {
        if (settled || cancelState.aborted) return;
        itemTimer = setTimeout(function () {
          cancelState.aborted = true;
          finishCaller(cancelState.partial);
        }, perItemBudgetMs);

        return runQueuedOcrOnCanvas(
          worker,
          fullCanvas,
          barcodePos,
          Boolean(allowTiltedFallback),
          cancelState,
          rescueAimCropCanvas || null
        ).then(function (res) {
          finishCaller(res);
        }).catch(function () {
          finishCaller(cancelState.partial);
        });
      }).catch(function () {
        finishCaller(cancelState.partial);
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

  function isOpHeldForDateRead(op) {
    if (!op || op.type !== 'add' || !op.record || !op.record.id) return false;
    const rid = op.record.id;
    if (!readingDateRecordIds[rid]) return false;
    const started = readingDateStartedAt[rid] || 0;
    const maxHold = ocrWorkerResolved ? 4200 : 8500;
    if (started > 0 && (Date.now() - started) >= maxHold) {
      return false;
    }
    return true;
  }

  function hasAnyReadyPendingOps() {
    for (let i = 0; i < pendingOps.length; i++) {
      if (!isOpHeldForDateRead(pendingOps[i])) return true;
    }
    return false;
  }

  function hasAnyHeldPendingOps() {
    for (let i = 0; i < pendingOps.length; i++) {
      if (isOpHeldForDateRead(pendingOps[i])) return true;
    }
    return false;
  }

  function armDateReadSyncSafetyTimer(maxWaitMs) {
    if (dateHoldSafetyTimer) {
      clearTimeout(dateHoldSafetyTimer);
      dateHoldSafetyTimer = null;
    }
    const waitMs = maxWaitMs || (ocrWorkerResolved ? 4300 : 8600);
    dateHoldSafetyTimer = setTimeout(function () {
      dateHoldSafetyTimer = null;
      flushSyncQueue(false);
    }, waitMs);
  }

  function clearDateReadSyncSafetyTimerIfIdle() {
    if (activeDateReadsCount <= 0 && !hasAnyHeldPendingOps() && dateHoldSafetyTimer) {
      clearTimeout(dateHoldSafetyTimer);
      dateHoldSafetyTimer = null;
    }
  }

  function scheduleSyncFlush(delayMs) {
    if (syncHoldTimer) {
      clearTimeout(syncHoldTimer);
      syncHoldTimer = null;
    }
    if (hasAnyHeldPendingOps()) {
      armDateReadSyncSafetyTimer();
    } else {
      clearDateReadSyncSafetyTimerIfIdle();
    }
    if (!hasAnyReadyPendingOps()) {
      updateSyncBadge();
      return;
    }
    if (!delayMs || delayMs <= 0) {
      flushSyncQueue(false);
      return;
    }
    syncHoldTimer = setTimeout(function () {
      syncHoldTimer = null;
      if (hasAnyReadyPendingOps()) {
        flushSyncQueue(false);
      }
    }, delayMs);
  }

  async function fillRecordDatesInBackground(recordId, ctx) {
    if (!recordId || !ctx || !ctx.frameCanvas) return;
    activeDateReadsCount += 1;
    readingDateRecordIds[recordId] = true;
    if (!readingDateStartedAt[recordId]) {
      readingDateStartedAt[recordId] = Date.now();
    }
    let collected = { nsx: '', hsd: '' };

    try {
      const targetRec = records.find(function (r) { return r.id === recordId; });
      const expectedBarcode = (!ctx.ignoreBarcodeMismatch && targetRec) ? String(targetRec.rawBarcode || '') : '';

      // Gom danh sách các khung hình ứng viên (ưu tiên khung độ nét gốc cao nhất thấy trọn vùng ngày bên dưới mã vạch)
      const candidates = [];
      if (Array.isArray(ctx.candidateFrames) && ctx.candidateFrames.length > 0) {
        for (let cIdx = 0; cIdx < ctx.candidateFrames.length; cIdx++) {
          const cf = ctx.candidateFrames[cIdx];
          if (cf && cf.canvas) candidates.push(cf);
        }
      } else {
        candidates.push({
          canvas: ctx.frameCanvas,
          pos: ctx.barcodePos || null
        });
      }
      if (
        ctx.liveVideo &&
        ctx.liveVideo.readyState >= 2 &&
        Math.max(ctx.liveVideo.videoWidth || 0, ctx.liveVideo.videoHeight || 0) > Math.max(ctx.frameCanvas.width, ctx.frameCanvas.height) * 1.12
      ) {
        const asyncHiRes = captureVideoToCanvas(ctx.liveVideo, null, 2400);
        candidates.push({ canvas: asyncHiRes, pos: null });
      }

      for (let i = 0; i < candidates.length; i++) {
        if (!readingDateRecordIds[recordId]) break;
        const item = candidates[i];
        let posUse = item.pos || null;
        if (!posUse) {
          const det = (i === 0 && !ctx.ignoreBarcodeMismatch)
            ? (await detectBarcodeCodeAndPosOnCanvas(item.canvas))
            : (await detectBarcodeQuickOnCanvas(item.canvas));
          if (!ctx.ignoreBarcodeMismatch) {
            if (det && det.code && expectedBarcode && det.code !== expectedBarcode) {
              continue;
            }
            if (i > 0 && (!det || !det.pos)) {
              // Khung phụ không thấy mã vạch (người dùng đã hạ máy khỏi tem) -> bỏ qua ngay 0ms, tuyệt đối không đọc nhầm bàn phím/nền bàn!
              continue;
            }
          }
          posUse = det ? det.pos : null;
        }

        const rescueCrop = (!posUse) ? (ctx.rescueAimCropCanvas || cropCenterAimFromCanvas(item.canvas)) : null;
        const allowFullTilt = posUse ? Boolean(ctx.allowTilt && !ctx.liveVideo) : Boolean(ctx.ignoreBarcodeMismatch && ctx.allowTilt);
        const budgetMs = posUse ? (ctx.liveVideo ? 1750 : 3800) : (ctx.ignoreBarcodeMismatch ? 3800 : 2200);
        const dRes = await extractNsxHsdWithTimeout(item.canvas, posUse, budgetMs, allowFullTilt, rescueCrop);
        collected = mergeDatePair(collected, dRes);
        if (collected.nsx && collected.hsd && !collected.suspectYearGap) break;
      }

      // Nếu khung đầu bị rung tay hoặc ống kính điện thoại đang lấy nét lúc bấm chụp mà Camera vẫn đang mở:
      // - Nếu người dùng đã hạ máy xuống bàn phím/mặt bàn (không còn mặt giấy tem trắng trong khung ~0.25s) -> ngắt ngay tức khắc, KHÔNG BAO GIỜ treo "⏳ Đang đọc..."!
      // - Nếu người dùng vẫn đang soi vào mặt giấy tem trắng (kể cả túi thịt cong phồng hoặc đưa sát vào góc trái dưới NSX/HSD) -> đọc bồi sắc nét cho tới khi đủ NSX & HSD!
      if ((!collected.nsx || !collected.hsd) && ctx.liveVideo) {
        const followDelays = ctx.ignoreBarcodeMismatch ? [120, 220] : [115, 175, 225, 260, 300];
        let consecutiveOffLabel = 0;
        let closeUpPaperTries = 0;
        for (let f = 0; f < followDelays.length; f++) {
          if (!readingDateRecordIds[recordId]) break;
          await new Promise(function (r) { setTimeout(r, followDelays[f]); });
          if (!cameraActive || !mediaStream || !ctx.liveVideo || ctx.liveVideo.readyState < 2 || ctx.liveVideo.videoWidth <= 0) {
            break;
          }
          const nextCanvas = captureCleanFullVideoCanvas(ctx.liveVideo);
          const nextDet = await detectBarcodeQuickOnCanvas(nextCanvas);

          if (!ctx.ignoreBarcodeMismatch) {
            if (nextDet && nextDet.code && expectedBarcode && nextDet.code !== expectedBarcode) {
              // Người dùng đã chuyển ống kính sang túi thịt khác -> dừng ngay để bảo vệ tính chính xác!
              break;
            }
            if (!nextDet || !nextDet.pos) {
              // Nếu vẫn thấy rõ nền giấy trắng có chữ của tem (người dùng đang soi cận cảnh góc trái dưới NSX/HSD hoặc bao bì cong) -> đọc trực tiếp góc trái dưới tối đa 2 nhịp!
              if (closeUpPaperTries < 2 && hasWhiteLabelPaperInFrame(nextCanvas)) {
                closeUpPaperTries += 1;
                consecutiveOffLabel = 0;
                const directDates = await extractNsxHsdWithTimeout(
                  nextCanvas,
                  null,
                  1800,
                  false,
                  cropCenterAimFromCanvas(nextCanvas)
                );
                collected = mergeDatePair(collected, directDates);
                if (collected.nsx && collected.hsd && !collected.suspectYearGap) break;
                continue;
              }
              consecutiveOffLabel += 1;
              if (consecutiveOffLabel >= 2) {
                // Đã hạ điện thoại khỏi mặt tem (VD: quay vào bàn phím máy tính / mặt bàn) -> dừng hẳn ngay lập tức!
                break;
              }
              continue;
            }
            consecutiveOffLabel = 0;
            const nextDates = await extractNsxHsdWithTimeout(nextCanvas, nextDet.pos, 2500, false, null);
            collected = mergeDatePair(collected, nextDates);
          } else {
            const rescueNextPos = nextDet ? nextDet.pos : null;
            const rescueNextCrop = rescueNextPos ? null : cropCenterAimFromCanvas(nextCanvas);
            const nextDates = await extractNsxHsdWithTimeout(nextCanvas, rescueNextPos, 3200, true, rescueNextCrop);
            collected = mergeDatePair(collected, nextDates);
          }
          if (collected.nsx && collected.hsd && !collected.suspectYearGap) break;
        }
      }
    } catch (e) {
    } finally {
      delete readingDateRecordIds[recordId];
      delete readingDateStartedAt[recordId];
      activeDateReadsCount = Math.max(0, activeDateReadsCount - 1);
      clearDateReadSyncSafetyTimerIfIdle();
    }

    const rec = records.find(function (r) { return r.id === recordId; });
    if (!rec) {
      renderAll(false);
      scheduleSyncFlush(25);
      setTimeout(checkPendingSwReload, 120);
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
      for (let i = pendingOps.length - 1; i >= 0; i--) {
        const op = pendingOps[i];
        if (
          op &&
          !inFlightOpUids[op._opUid] &&
          (op.type === 'add' || op.type === 'update') &&
          op.record &&
          op.record.id === recordId
        ) {
          op.record = toSyncRecord(rec);
          patchedInPlace = true;
          break;
        }
      }
      if (patchedInPlace) {
        persistPendingOps();
      } else {
        enqueueOp({ type: 'update', record: toSyncRecord(rec) });
      }
      persistRecords();

      if (ctx.fromLiveAutoRescue) {
        lastAutoSnappedCode = rec.rawBarcode || lastAutoSnappedCode;
        lastAutoSnappedEpoch = Date.now();
        playBeep('ok');
        vibrateDevice([40]);
      }

      if (records.length > 0 && records[records.length - 1].id === recordId) {
        showBanner(
          'ok',
          '✅ Đã quét: ' + (rec.productName || ('Mã ' + rec.productCode)) + ' (' + rec.productCode + ') — ' +
          formatKg(rec.grams) + ' Kg | NSX: ' + formatLotDateDisplay(rec.nsx) + ' • HSD: ' + formatLotDateDisplay(rec.hsd)
        );
      }
    } else if (!ctx.ignoreBarcodeMismatch && !ctx.fromLiveAutoRescue && records.length > 0 && records[records.length - 1].id === recordId && (!rec.nsx || !rec.hsd)) {
      showBanner(
        'warn',
        '⚠️ Đã lưu ' + (rec.productName || ('Mã ' + rec.productCode)) + ' (' + formatKg(rec.grams) + ' Kg) nhưng khuất dòng NSX/HSD — Giữ tem trước Camera để tự bù hoặc bấm "📷 Bù ngày"!'
      );
    }

    renderAll(false);
    scheduleSyncFlush(25);
    setTimeout(checkPendingSwReload, 120);
  }

  function commitParsedScan(parsed, datesObj, asyncDateContext) {
    const now = new Date();
    const nsxClean = (datesObj && datesObj.nsx) ? normalizeDateVN(datesObj.nsx) : '';
    const hsdClean = (datesObj && datesObj.hsd) ? normalizeDateVN(datesObj.hsd) : '';
    const canReadAsync = Boolean(window.Tesseract && window.Tesseract.createWorker);
    const willReadDatesAsync = Boolean(canReadAsync && asyncDateContext && asyncDateContext.frameCanvas && (!nsxClean || !hsdClean));

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
      readingDateStartedAt[record.id] = Date.now();
    }

    records.push(record);
    lastScannedCode = parsed.rawBarcode;
    lastScannedEpoch = Date.now();

    const kcs = verifyKcsIntegrity();
    if (!kcs.ok) {
      delete readingDateRecordIds[record.id];
      delete readingDateStartedAt[record.id];
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
      // Giữ nhịp đợi riêng cho từng dòng đang đọc NSX/HSD để gộp trọn Mã + Số ký + NSX + HSD đẩy lên Google Sheet ngay lần đầu!
      armDateReadSyncSafetyTimer();
      setTimeout(function () {
        fillRecordDatesInBackground(record.id, asyncDateContext);
      }, 0);
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
        rescueDatesForLatestRecord();
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
        hudDatesEl.style.color = (latest.nsx && latest.hsd) ? '#86efac' : (readingNow ? '#fde047' : '#fca5a5');
      }
      document.getElementById('hudWeight').textContent = formatKg(latest.grams) + ' Kg';
      const btnHudDates = document.getElementById('btnHudScanDates');
      if (btnHudDates) {
        const needRescue = (!readingNow && (!latest.nsx || !latest.hsd));
        btnHudDates.style.display = needRescue ? 'inline-block' : 'none';
        btnHudDates.onclick = function () {
          rescueDatesForLatestRecord();
        };
      }
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
    // Ưu tiên chuẩn 2K QHD (2560x1440) & FullHD (1920x1080) trước 4K:
    // Giúp mọi điện thoại iOS/Android lấy nét cận cảnh tự động (Macro/PDAF 10-15cm) nhanh gấp đôi và tốc độ màn trập nhanh không nhòe chữ NSX/HSD!
    const constraintsList = [
      {
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 2560 },
          height: { ideal: 1440 }
        }
      },
      {
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        }
      },
      {
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 3840 },
          height: { ideal: 2160 }
        }
      },
      {
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 }
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
    setTimeout(function () { warmUpOcrWorker(); }, 40);

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
        ? '⚡ Tự chốt v14 đang BẬT: Giữ trọn tem (cả góc trái dưới NSX/HSD) trong khung!'
        : '👆 Bản v14: Đưa trọn tem (cả góc trái dưới NSX/HSD) vào khung → Bấm nút tròn chốt!';
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

  function captureVideoToCanvas(video, targetCanvas, maxDimLimit) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const maxDim = maxDimLimit || 2200;
    const scale = Math.min(1, maxDim / Math.max(1, Math.max(vw, vh)));
    const ow = Math.max(200, Math.round(vw * scale));
    const oh = Math.max(150, Math.round(vh * scale));
    const c = targetCanvas || document.createElement('canvas');
    if (c.width !== ow) c.width = ow;
    if (c.height !== oh) c.height = oh;
    const ctx = c.getContext('2d');
    ctx.drawImage(video, 0, 0, vw, vh, 0, 0, ow, oh);
    return c;
  }

  function cloneCanvas(srcCanvas) {
    const c = document.createElement('canvas');
    c.width = srcCanvas.width;
    c.height = srcCanvas.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(srcCanvas, 0, 0);
    return c;
  }

  function captureCleanFullVideoCanvas(video) {
    return captureVideoToCanvas(video, null, 2200);
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
    return normalizeBarcodePosMajorAxis({
      topLeft: mapPointFromCropToFull(pos.topLeft, dw, dh, angleDeg, cropX, cropY, cropW, cropH, srcW, srcH, outW, outH, padPx),
      topRight: mapPointFromCropToFull(pos.topRight, dw, dh, angleDeg, cropX, cropY, cropW, cropH, srcW, srcH, outW, outH, padPx),
      bottomRight: mapPointFromCropToFull(pos.bottomRight, dw, dh, angleDeg, cropX, cropY, cropW, cropH, srcW, srcH, outW, outH, padPx),
      bottomLeft: mapPointFromCropToFull(pos.bottomLeft, dw, dh, angleDeg, cropX, cropY, cropW, cropH, srcW, srcH, outW, outH, padPx)
    });
  }

  function extractPosFromNativeHit(natHit, scaleX, scaleY) {
    if (!natHit) return null;
    const sx = scaleX || 1;
    const sy = scaleY || 1;
    const corners = natHit.cornerPoints;
    if (Array.isArray(corners) && corners.length >= 4) {
      return normalizeBarcodePosMajorAxis({
        topLeft: { x: corners[0].x * sx, y: corners[0].y * sy },
        topRight: { x: corners[1].x * sx, y: corners[1].y * sy },
        bottomRight: { x: corners[2].x * sx, y: corners[2].y * sy },
        bottomLeft: { x: corners[3].x * sx, y: corners[3].y * sy }
      });
    }
    if (Array.isArray(corners) && corners.length >= 2) {
      const x0 = corners[0].x * sx;
      const y0 = corners[0].y * sy;
      const x1 = corners[1].x * sx;
      const y1 = corners[1].y * sy;
      const dx = x1 - x0;
      const dy = y1 - y0;
      const len = Math.hypot(dx, dy);
      if (len >= 16) {
        const nx = (-dy / len) * (len * 0.14);
        const ny = (dx / len) * (len * 0.14);
        return normalizeBarcodePosMajorAxis({
          topLeft: { x: x0 - nx, y: y0 - ny },
          topRight: { x: x1 - nx, y: y1 - ny },
          bottomRight: { x: x1 + nx, y: y1 + ny },
          bottomLeft: { x: x0 + nx, y: y0 + ny }
        });
      }
    }
    const bb = natHit.boundingBox;
    if (bb) {
      const bx = (typeof bb.x === 'number' ? bb.x : bb.left) * sx;
      const by = (typeof bb.y === 'number' ? bb.y : bb.top) * sy;
      const bw = (bb.width || 0) * sx;
      const bh = (bb.height || 0) * sy;
      if (bw >= 12 && bh >= 4) {
        return normalizeBarcodePosMajorAxis({
          topLeft: { x: bx, y: by },
          topRight: { x: bx + bw, y: by },
          bottomRight: { x: bx + bw, y: by + bh },
          bottomLeft: { x: bx, y: by + bh }
        });
      }
    }
    return null;
  }

  function convertCornerPointsToPos(corners, scaleX, scaleY) {
    return extractPosFromNativeHit({ cornerPoints: corners }, scaleX, scaleY);
  }

  async function tryDecodeRegionOnCanvas(workCanvas, workCtx, src, sx, sy, sw, sh, angleDeg, maxDim, padPx, doSharpen, useNative, needPosOnly) {
    const maxSide = Math.max(1, Math.max(sw, sh));
    const minSide = Math.max(1, Math.min(sw, sh));
    const ratio = (doSharpen && minSide < 820)
      ? Math.min(2.0, 1080 / minSide)
      : Math.min(1, (maxDim || 1900) / maxSide);
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
              const natPos = extractPosFromNativeHit(natHits[k], 1, 1);
              if (!needPosOnly || natPos) {
                return {
                  code: rawV,
                  posOnWork: natPos,
                  dw: dw,
                  dh: dh,
                  pad: pad
                };
              }
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

    const jsHit = decodeEan13PureJsFromImageData(imgData);
    if (jsHit && jsHit.code) {
      if (needPosOnly && !jsHit.pos) return null;
      return {
        code: jsHit.code,
        posOnWork: jsHit.pos || null,
        fromPureJs: true,
        isFlatJs: Boolean(jsHit.isFlat),
        dw: dw,
        dh: dh,
        pad: pad
      };
    }

    return null;
  }

  // Kiểm tra nhanh có mã vạch trong khung hình tiếp theo hay không (<25ms — dùng để ngắt tức thì khi người dùng vừa hạ điện thoại xuống bàn phím!)
  async function detectBarcodeQuickOnCanvas(canvas) {
    if (!canvas) return null;
    const cw = canvas.width;
    const ch = canvas.height;

    if (nativeDetector) {
      try {
        const natHits = await nativeDetector.detect(canvas);
        if (natHits && natHits.length > 0) {
          for (let k = 0; k < natHits.length; k++) {
            const rawV = String(natHits[k].rawValue || '').trim();
            if (parseSingle13DigitScaleBarcode(rawV).ok) {
              const natPos = extractPosFromNativeHit(natHits[k], 1, 1);
              if (natPos) {
                return {
                  code: rawV,
                  pos: natPos
                };
              }
            }
          }
        }
      } catch (e) {}
    }

    const rotCanvas = document.createElement('canvas');
    const rotCtx = rotCanvas.getContext('2d', { willReadFrequently: true });
    const quickPlans = [
      { crop: 1.0, deg: 0, sharp: false },
      { crop: 1.0, deg: 0, sharp: true },
      { crop: 0.56, deg: 0, sharp: true }
    ];

    for (let i = 0; i < quickPlans.length; i++) {
      const p = quickPlans[i];
      const sw = Math.max(120, Math.round(cw * p.crop));
      const sh = Math.max(90, Math.round(ch * p.crop));
      const sx = Math.round((cw - sw) / 2);
      const sy = Math.round((ch - sh) / 2);
      try {
        const hit = await tryDecodeRegionOnCanvas(
          rotCanvas, rotCtx, canvas, sx, sy, sw, sh, p.deg, 1750, 20, p.sharp, false, true
        );
        if (hit && hit.posOnWork) {
          return {
            code: hit.code || '',
            pos: mapPositionToTargetCanvas(
              hit.posOnWork, hit.dw, hit.dh, p.deg, sx, sy, sw, sh, cw, ch, cw, ch, hit.pad
            )
          };
        }
      } catch (e) {}
    }
    return null;
  }

  async function detectBarcodeCodeAndPosOnCanvas(canvas) {
    if (!canvas) return null;
    const cw = canvas.width;
    const ch = canvas.height;

    if (nativeDetector) {
      try {
        const natHits = await nativeDetector.detect(canvas);
        if (natHits && natHits.length > 0) {
          for (let k = 0; k < natHits.length; k++) {
            const rawV = String(natHits[k].rawValue || '').trim();
            if (parseSingle13DigitScaleBarcode(rawV).ok) {
              const natPos = extractPosFromNativeHit(natHits[k], 1, 1);
              if (natPos) {
                return {
                  code: rawV,
                  pos: natPos
                };
              }
            }
          }
        }
      } catch (e) {}
    }

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

    let pureJsFallback = null;
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
          const mapped = {
            code: hit.code || '',
            pos: mapPositionToTargetCanvas(
              hit.posOnWork, hit.dw, hit.dh, p.deg, sx, sy, sw, sh, cw, ch, cw, ch, hit.pad
            )
          };
          if (!hit.fromPureJs) {
            return mapped;
          }
          if (!pureJsFallback) {
            pureJsFallback = mapped;
            pureJsFallback.isFlat = Boolean(hit.isFlatJs);
          }
        }
        if (pureJsFallback && pureJsFallback.isFlat && i >= 1) {
          return pureJsFallback;
        }
      } catch (e) {}
    }
    return pureJsFallback;
  }

  async function detectBarcodePositionOnCanvas(canvas) {
    const det = await detectBarcodeCodeAndPosOnCanvas(canvas);
    return det ? det.pos : null;
  }

  function scalePosBetweenCanvases(pos, srcW, srcH, dstW, dstH) {
    if (!pos || !srcW || !srcH || !dstW || !dstH) return pos || null;
    if (srcW === dstW && srcH === dstH) return pos;
    const rx = dstW / srcW;
    const ry = dstH / srcH;
    return normalizeBarcodePosMajorAxis({
      topLeft: { x: pos.topLeft.x * rx, y: pos.topLeft.y * ry },
      topRight: { x: pos.topRight.x * rx, y: pos.topRight.y * ry },
      bottomRight: { x: pos.bottomRight.x * rx, y: pos.bottomRight.y * ry },
      bottomLeft: { x: pos.bottomLeft.x * rx, y: pos.bottomLeft.y * ry }
    });
  }

  function startLivePreLockLoop() {
    const myLoopId = ++radarLoopId;
    const video = document.getElementById('cameraVideo');
    const radarFrameCanvas = document.createElement('canvas');
    const workCanvas = document.createElement('canvas');
    const workCtx = workCanvas.getContext('2d', { willReadFrequently: true });
    let tick = 0;

    async function step() {
      if (!cameraActive || !mediaStream || radarLoopId !== myLoopId) return;

      if (!singleScanActive && video && video.readyState >= 2 && video.videoWidth > 0) {
        tick += 1;
        const vw = video.videoWidth;
        const vh = video.videoHeight;

        // ĐÓNG BĂNG KHUNG HÌNH TRƯỚC KHI GIẢI MÃ MÃ VẠCH -> Sai số dịch chuyển tay bằng 0.00px tuyệt đối!
        captureVideoToCanvas(video, radarFrameCanvas, 1680);
        const fw = radarFrameCanvas.width;
        const fh = radarFrameCanvas.height;

        let foundCode = null;
        let foundParsed = null;
        let foundPosOnFrame = null;

        // 1. Thử bộ giải mã phần cứng trực tiếp trên khung đóng băng (~3ms)
        if (nativeDetector) {
          try {
            const vHits = await nativeDetector.detect(radarFrameCanvas);
            if (vHits && vHits.length > 0) {
              for (let k = 0; k < vHits.length; k++) {
                const raw = String(vHits[k].rawValue || '').trim();
                const chk = parseSingle13DigitScaleBarcode(raw);
                if (chk.ok) {
                  foundCode = raw;
                  foundParsed = chk;
                  foundPosOnFrame = extractPosFromNativeHit(vHits[k], 1, 1);
                  break;
                }
              }
            }
          } catch (e) {}
        }

        // 2. Xoay vòng quét độ phân giải cao trên cùng khung đóng băng (cận cảnh, cự ly xa 45cm, thiếu sáng, cầm nghiêng)
        if (!foundCode && cameraActive && !singleScanActive && radarLoopId === myLoopId) {
          const vis = getVisibleAimRectInVideo(video, 0.08);
          const scaleX = fw / Math.max(1, vw);
          const scaleY = fh / Math.max(1, vh);
          const alreadyLockedFresh = Boolean(livePreLock && (Date.now() - livePreLock.lockedAt) < 420);
          const modeIdx = alreadyLockedFresh ? (tick % 2) : (tick % 5);
          let rx = Math.round(vis.sx * scaleX);
          let ry = Math.round(vis.sy * scaleY);
          let rw = Math.max(120, Math.round(vis.sw * scaleX));
          let rh = Math.max(90, Math.round(vis.sh * scaleY));
          let deg = 0;
          let doSharp = true;

          if (modeIdx === 0) {
            doSharp = false;
          } else if (modeIdx === 2) {
            // Phóng tâm quang học giữ nguyên điểm ảnh gốc cho tem đặt ở xa 35-50cm
            const zw = Math.max(160, Math.round(rw * 0.56));
            const zh = Math.max(110, Math.round(rh * 0.56));
            rx = rx + Math.round((rw - zw) / 2);
            ry = ry + Math.round((rh - zh) / 2);
            rw = zw;
            rh = zh;
          } else if (modeIdx === 3) {
            deg = -11;
          } else if (modeIdx === 4) {
            deg = 11;
          }

          rx = Math.max(0, Math.min(fw - 10, rx));
          ry = Math.max(0, Math.min(fh - 10, ry));
          rw = Math.max(10, Math.min(fw - rx, rw));
          rh = Math.max(10, Math.min(fh - ry, rh));

          const hit = await tryDecodeRegionOnCanvas(
            workCanvas, workCtx, radarFrameCanvas, rx, ry, rw, rh, deg, 1650, 22, doSharp, false
          );
          if (hit && hit.code && !(hit.fromPureJs && deg !== 0 && !hit.isFlatJs && window.ZXingWASM)) {
            const chk = parseSingle13DigitScaleBarcode(hit.code);
            if (chk.ok) {
              foundCode = hit.code;
              foundParsed = chk;
              if (hit.posOnWork) {
                foundPosOnFrame = mapPositionToTargetCanvas(
                  hit.posOnWork, hit.dw, hit.dh, deg, rx, ry, rw, rh, fw, fh, fw, fh, hit.pad
                );
              }
            }
          }
        }

        if (foundCode && foundParsed && cameraActive && !singleScanActive && radarLoopId === myLoopId) {
          const mappedPos = foundPosOnFrame;
          const dateInFrame = hasDateZoneInsideFrame(mappedPos, fw, fh);
          const sharpness = measureDateZoneSharpness(radarFrameCanvas, mappedPos);
          const frameScore = (dateInFrame ? 1000 : 0) + sharpness;

          const nowTick = Date.now();
          if (foundCode === autoSnapStreakCode && (nowTick - autoSnapStreakLastAt) < 900) {
            autoSnapStreakCount += 1;
          } else {
            autoSnapStreakCode = foundCode;
            autoSnapStreakCount = 1;
          }
          autoSnapStreakLastAt = nowTick;

          // Giữ lại khung sắc nét nhất thấy trọn cả vùng NSX/HSD của cùng tem này
          if (
            livePreLock &&
            livePreLock.code === foundCode &&
            (nowTick - livePreLock.lockedAt) < 580 &&
            (livePreLock.frameScore || 0) > frameScore + 1.8
          ) {
            livePreLock.lockedAt = nowTick;
          } else {
            livePreLock = {
              code: foundCode,
              parsed: foundParsed,
              frameCanvas: cloneCanvas(radarFrameCanvas),
              barcodePos: mappedPos,
              dateInFrame: dateInFrame,
              frameScore: frameScore,
              lockedAt: nowTick
            };
          }

          const viewportBox = document.getElementById('cameraViewportBox');
          const statusEl = document.getElementById('cameraStatusBadge');

          // TỰ BÙ RẢNH TAY THÔNG MINH: Nếu tem vừa quét (trong 25 giây gần nhất) có đúng mã vạch 13 số này mà lúc đầu bị mờ/khuất chưa có NSX/HSD,
          // chỉ cần giữ ống kính trước tem là máy TỰ ĐỘNG đọc bù NSX/HSD điền thẳng vào dòng đó & đẩy lên Sheet (không tạo dòng trùng rỗng)!
          const latestRec = records.length > 0 ? records[records.length - 1] : null;
          const sameLatestMissingDates = Boolean(
            latestRec &&
            latestRec.rawBarcode === foundCode &&
            (!latestRec.nsx || !latestRec.hsd) &&
            (nowTick - lastScannedEpoch) < 25000
          );

          if (
            sameLatestMissingDates &&
            autoSnapStreakCount >= 2 &&
            !readingDateRecordIds[latestRec.id] &&
            dateInFrame &&
            (nowTick - lastLiveAutoRescueAt) > 950
          ) {
            lastLiveAutoRescueAt = nowTick;
            lastAutoSnappedCode = foundCode;
            lastAutoSnappedEpoch = nowTick;
            const frozenRescue = cloneCanvas(radarFrameCanvas);
            readingDateRecordIds[latestRec.id] = true;
            readingDateStartedAt[latestRec.id] = nowTick;
            renderAll(false);
            fillRecordDatesInBackground(latestRec.id, {
              frameCanvas: frozenRescue,
              barcodePos: mappedPos,
              candidateFrames: [
                { canvas: frozenRescue, pos: mappedPos }
              ],
              liveVideo: video,
              allowTilt: true,
              fromLiveAutoRescue: true
            });
          }

          let holdAutoSnapForDates = false;
          if (!livePreLock.dateInFrame) {
            if (edgeClipHoldCode !== foundCode) {
              edgeClipHoldCode = foundCode;
              edgeClipHoldSince = nowTick;
            }
            if ((nowTick - edgeClipHoldSince) < 950) {
              holdAutoSnapForDates = true;
            }
          } else {
            edgeClipHoldCode = '';
            edgeClipHoldSince = 0;
          }

          // Chế độ ⚡ Tự chốt: Đợi đúng 2 nhịp bắt nét liên tiếp (~0.09 giây) + lấy khung độ nét gốc 2400px!
          if (
            settings.autoSnapCamera &&
            autoSnapStreakCount >= 2 &&
            !holdAutoSnapForDates &&
            !sameLatestMissingDates &&
            nowTick >= shutterLockUntil &&
            !(foundCode === lastAutoSnappedCode && (nowTick - lastAutoSnappedEpoch) < 4200)
          ) {
            lastAutoSnappedCode = foundCode;
            lastAutoSnappedEpoch = nowTick;
            autoSnapStreakCount = 0;
            shutterLockUntil = nowTick + 650;
            const snapUse = livePreLock;
            livePreLock = null;
            setShutterUIState(
              'captured',
              '⚡ Tự chốt: ' + (foundParsed.productName || foundParsed.productCode) + ' (' + formatKg(foundParsed.grams) + ' Kg)'
            );
            handleBarcodeInput(snapUse.code, 'Camera Auto', null, {
              frameCanvas: snapUse.frameCanvas,
              barcodePos: snapUse.barcodePos,
              candidateFrames: [
                { canvas: snapUse.frameCanvas, pos: snapUse.barcodePos }
              ],
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
            statusEl.textContent = !dateInFrame
              ? ('📐 Đã thấy mã ' + foundParsed.productCode + ' — Hạ nhẹ khung xuống để thấy trọn dòng NSX/HSD bên dưới!')
              : (sameLatestMissingDates
                ? ('⏳ Đang tự đọc bù NSX/HSD cho ' + (foundParsed.productName || foundParsed.productCode) + ' — Giữ yên 0.3s!')
                : ('🟢 Đã bắt nét: ' + (foundParsed.productName || ('Mã ' + foundParsed.productCode)) +
                  ' (' + formatKg(foundParsed.grams) + ' Kg) — Bấm nút tròn chốt ngay!'));
          }
        } else {
          if ((Date.now() - autoSnapStreakLastAt) > 450) {
            autoSnapStreakCount = 0;
            autoSnapStreakCode = '';
          }
          if (livePreLock && (Date.now() - livePreLock.lockedAt) > 980) {
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
      }

      if (cameraActive && mediaStream && radarLoopId === myLoopId) {
        const nextDelay = (settings.autoSnapCamera && autoSnapStreakCount === 1)
          ? 70
          : (livePreLock ? 145 : 95);
        setTimeout(step, nextDelay);
      }
    }

    setTimeout(step, 55);
  }

  async function runSingleShotCameraScan() {
    if (!cameraActive || !mediaStream) return;
    const video = document.getElementById('cameraVideo');

    // Chốt 0.00 giây nếu bộ bắt nét ngầm đã khóa sẵn mã hợp lệ trong 0.98 giây gần nhất!
    if (livePreLock && (Date.now() - livePreLock.lockedAt) <= 980) {
      const snap = livePreLock;
      livePreLock = null;
      shutterLockUntil = Date.now() + 180;

      const candidateFrames = [{ canvas: snap.frameCanvas, pos: snap.barcodePos, score: snap.frameScore || 500 }];

      setShutterUIState('captured');
      handleBarcodeInput(snap.code, 'Camera', null, {
        frameCanvas: snap.frameCanvas,
        barcodePos: snap.barcodePos,
        candidateFrames: candidateFrames,
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

    const frozenCanvas = document.createElement('canvas');
    const workCanvas = document.createElement('canvas');
    const workCtx = workCanvas.getContext('2d', { willReadFrequently: true });

    const deadline = Date.now() + 1450;
    let attempt = 0;
    let lastInvalidError = null;

    // 11 cấu hình quét siêu tốc trên khung đóng băng (0.00px lệch tọa độ): tâm chuẩn, tăng nét thiếu sáng, phóng xa 50%, toàn khung, nghiêng ±10°, ±21°, ±34°, dọc 90°
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
        captureVideoToCanvas(video, frozenCanvas, 2200);
        const fw = frozenCanvas.width;
        const fh = frozenCanvas.height;

        const cfg = sweepPlan[attempt % sweepPlan.length];
        attempt += 1;

        let candidate = null;
        let posOnFrozen = null;

        if (cfg.nativeFirst && nativeDetector && cfg.deg === 0) {
          try {
            const vHits = await nativeDetector.detect(frozenCanvas);
            if (vHits && vHits.length > 0 && vHits[0].rawValue) {
              candidate = String(vHits[0].rawValue).trim();
              posOnFrozen = extractPosFromNativeHit(vHits[0], 1, 1);
            }
          } catch (e) {}
        }

        if (!candidate) {
          const vis = getVisibleAimRectInVideo(video, 0.10);
          const scaleX = fw / Math.max(1, vw);
          const scaleY = fh / Math.max(1, vh);
          let sx = Math.round(vis.sx * scaleX);
          let sy = Math.round(vis.sy * scaleY);
          let sw = Math.max(120, Math.round(vis.sw * scaleX));
          let sh = Math.max(90, Math.round(vis.sh * scaleY));

          if (cfg.mode === 'zoom') {
            const zw = Math.max(160, Math.round(sw * 0.50));
            const zh = Math.max(110, Math.round(sh * 0.50));
            sx = sx + Math.round((sw - zw) / 2);
            sy = sy + Math.round((sh - zh) / 2);
            sw = zw;
            sh = zh;
          } else if (cfg.mode === 'full') {
            sx = 0;
            sy = 0;
            sw = fw;
            sh = fh;
          }

          sx = Math.max(0, Math.min(fw - 10, sx));
          sy = Math.max(0, Math.min(fh - 10, sy));
          sw = Math.max(10, Math.min(fw - sx, sw));
          sh = Math.max(10, Math.min(fh - sy, sh));

          const hit = await tryDecodeRegionOnCanvas(
            workCanvas, workCtx, frozenCanvas, sx, sy, sw, sh, cfg.deg, 1850, 24, cfg.sharp, false
          );
          if (hit && hit.code) {
            candidate = hit.code;
            if (hit.posOnWork) {
              posOnFrozen = mapPositionToTargetCanvas(
                hit.posOnWork, hit.dw, hit.dh, cfg.deg, sx, sy, sw, sh, fw, fh, fw, fh, hit.pad
              );
            }
          }
        }

        if (candidate && singleScanToken === myToken && singleScanActive) {
          const check = parseSingle13DigitScaleBarcode(candidate);
          if (check.ok) {
            const fullFrameCanvas = cloneCanvas(frozenCanvas);
            singleScanActive = false;
            singleScanToken += 1;
            shutterLockUntil = Date.now() + 180;

            setShutterUIState('captured');
            handleBarcodeInput(candidate, 'Camera', null, {
              frameCanvas: fullFrameCanvas,
              barcodePos: posOnFrozen,
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
    autoSnapStreakCode = '';
    autoSnapStreakCount = 0;
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

      let hit = await decodePhotoInBrowserWasm(file, cleanCanvas);
      if (!hit && navigator.onLine && location.protocol.startsWith('http') && (location.port === '8088' || location.port === '8443')) {
        const srvCode = await decodePhotoViaLocalCppServer(file);
        if (srvCode) hit = { code: srvCode, position: null };
      }

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
        const onlyDates = await extractNsxHsdWithTimeout(cleanCanvas, null, 2800, true, cropCenterAimFromCanvas(cleanCanvas));
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

  async function rescueDatesForLatestRecord() {
    if (records.length === 0) return;
    const targetRec = records[records.length - 1];
    const video = document.getElementById('cameraVideo');

    // Nếu Camera trực tiếp đang mở -> chụp thẳng từ luồng hình Camera để đọc bù NSX/HSD tức thì (0.25 giây), không bắt mở hộp chọn tệp!
    if (cameraActive && mediaStream && video && video.readyState >= 2 && video.videoWidth > 0) {
      showBanner('warn', '⚡ Đang chụp đọc bù NSX & HSD trực tiếp từ Camera...');
      readingDateRecordIds[targetRec.id] = true;
      renderAll(false);
      const snapRescue = captureCleanFullVideoCanvas(video);
      await fillRecordDatesInBackground(targetRec.id, {
        frameCanvas: snapRescue,
        barcodePos: null,
        rescueAimCropCanvas: cropCenterAimFromCanvas(snapRescue),
        liveVideo: video,
        allowTilt: true,
        ignoreBarcodeMismatch: true
      });
      const updated = records.find(function (r) { return r.id === targetRec.id; });
      if (updated && (updated.nsx || updated.hsd)) {
        playBeep('ok');
      } else {
        playBeep('error');
        showBanner('error', 'Chưa thấy rõ chữ NSX / HSD trong khung Camera. Đưa dòng chữ NSX / HSD rõ nét vào giữa khung rồi bấm lại!');
      }
      return;
    }

    dateOnlyTarget = 'latest';
    document.getElementById('hiddenDateOnlyImageInput').click();
  }

  async function decodeDateOnlyImageFile(file) {
    if (!file) return;
    showBanner('warn', '⚡ Đang đọc tự động NSX & HSD từ ảnh tem...');
    try {
      const cleanPack = await loadCleanCanvasFromFile(file, 2200);
      const hitPos = await detectBarcodePositionOnCanvas(cleanPack.canvas);
      const dates = await extractNsxHsdWithTimeout(
        cleanPack.canvas,
        hitPos,
        4200,
        true,
        hitPos ? null : cropCenterAimFromCanvas(cleanPack.canvas)
      );
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
        flushSyncQueue(false);
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
    const runStarts = [];
    let idx = 0;
    while (idx < len && bits[idx] === 0) idx++;
    while (idx < len) {
      const startX = idx;
      const val = bits[idx];
      let count = 1;
      idx++;
      while (idx < len && bits[idx] === val) {
        count++;
        idx++;
      }
      runStarts.push(startX);
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
        return {
          code: full13,
          x0: runStarts[s],
          x1: runStarts[s + 58] + runs[s + 58]
        };
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
      if (c1 && c1.code) {
        let rec = votes[c1.code];
        if (!rec) {
          rec = { code: c1.code, rev: false, count: 0, sumXStart: 0, sumXEnd: 0, minY: y, maxY: y, firstX: c1.x0, lastX: c1.x0 };
          votes[c1.code] = rec;
        }
        rec.count += 1;
        rec.sumXStart += c1.x0;
        rec.sumXEnd += c1.x1;
        if (y < rec.minY) { rec.minY = y; rec.firstX = c1.x0; }
        if (y >= rec.maxY) { rec.maxY = y; rec.lastX = c1.x0; }
      }
      const c2 = decodeEan13FromBitLine(revBits, w);
      if (c2 && c2.code) {
        const origStart = w - 1 - c2.x0;
        const origEnd = w - 1 - c2.x1;
        const revKey = 'rev_' + c2.code;
        let rec = votes[revKey];
        if (!rec) {
          rec = { code: c2.code, rev: true, count: 0, sumXStart: 0, sumXEnd: 0, minY: y, maxY: y, firstX: origStart, lastX: origStart };
          votes[revKey] = rec;
        }
        rec.count += 1;
        rec.sumXStart += origStart;
        rec.sumXEnd += origEnd;
        if (y < rec.minY) { rec.minY = y; rec.firstX = origStart; }
        if (y >= rec.maxY) { rec.maxY = y; rec.lastX = origStart; }
      }
    }

    let bestRec = null;
    const keys = Object.keys(votes);
    for (let k = 0; k < keys.length; k++) {
      const r = votes[keys[k]];
      if (r.count >= 2 && (!bestRec || r.count > bestRec.count)) {
        bestRec = r;
      }
    }
    if (!bestRec) return null;

    const xStart = bestRec.sumXStart / bestRec.count;
    const xEnd = bestRec.sumXEnd / bestRec.count;
    const barHalfH = Math.max(12, Math.max((bestRec.maxY - bestRec.minY) / 2, Math.abs(xEnd - xStart) * 0.12));
    const cy = (bestRec.minY + bestRec.maxY) / 2;
    const isFlat = Math.abs(bestRec.lastX - bestRec.firstX) <= 5;
    if (bestRec.rev) {
      return {
        code: bestRec.code,
        isFlat: isFlat,
        pos: {
          topLeft: { x: xStart, y: cy + barHalfH },
          topRight: { x: xEnd, y: cy + barHalfH },
          bottomRight: { x: xEnd, y: cy - barHalfH },
          bottomLeft: { x: xStart, y: cy - barHalfH }
        }
      };
    }
    return {
      code: bestRec.code,
      isFlat: isFlat,
      pos: {
        topLeft: { x: xStart, y: cy - barHalfH },
        topRight: { x: xEnd, y: cy - barHalfH },
        bottomRight: { x: xEnd, y: cy + barHalfH },
        bottomLeft: { x: xStart, y: cy + barHalfH }
      }
    };
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

      const hasWasmEngine = Boolean(window.ZXingWASM && window.ZXingWASM.readBarcodesFromImageData);
      let pureJsVerified = null;
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
            if (!hit.fromPureJs || !hasWasmEngine) {
              if (bmp.close) bmp.close();
              return { code: hit.code, position: mappedPos };
            } else if (!pureJsVerified) {
              pureJsVerified = { code: hit.code, position: mappedPos, isFlat: Boolean(hit.isFlatJs) };
            }
          } else if (!fallbackUnverified) {
            fallbackUnverified = { code: hit.code, position: mappedPos };
          }
        }
        if (pureJsVerified && pureJsVerified.isFlat && i >= 1) {
          if (bmp.close) bmp.close();
          return { code: pureJsVerified.code, position: pureJsVerified.position };
        }
      }

      if (bmp.close) bmp.close();
      if (pureJsVerified) return pureJsVerified;
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

    const readyBatch = [];
    for (let i = 0; i < pendingOps.length; i++) {
      ensureOpUid(pendingOps[i]);
      if (!isOpHeldForDateRead(pendingOps[i])) {
        readyBatch.push(pendingOps[i]);
      }
    }
    if (readyBatch.length === 0) {
      if (hasAnyHeldPendingOps()) {
        armDateReadSyncSafetyTimer();
      }
      updateSyncBadge();
      return;
    }

    syncInProgress = true;
    inFlightOpUids = {};
    const cleanWireBatch = [];
    for (let i = 0; i < readyBatch.length; i++) {
      const item = readyBatch[i];
      inFlightOpUids[item._opUid] = true;
      const wireOp = { type: item.type };
      if (item.id !== undefined) wireOp.id = item.id;
      if (item.record !== undefined) wireOp.record = item.record;
      cleanWireBatch.push(wireOp);
    }
    updateSyncBadge();

    let hadError = false;
    try {
      const catalogArray = Object.keys(catalogMap).map(function (k) { return catalogMap[k]; });
      const res = await postToGoogleSheet({
        action: 'sync_ops',
        ops: cleanWireBatch,
        catalog: catalogArray
      });

      if (res && res.ok) {
        pendingOps = pendingOps.filter(function (op) {
          return !(op && op._opUid && inFlightOpUids[op._opUid]);
        });
        inFlightOpUids = {};
        if (res.sheetUrl && !settings.sheetViewUrl) {
          settings.sheetViewUrl = res.sheetUrl;
          saveSettings();
        }
        persistPendingOps();

        // Nếu không còn mục Offline nào đang chờ và không còn tem đang đọc NSX/HSD ngầm, cập nhật ngay danh sách chuẩn thực tế từ Google Sheet!
        if (pendingOps.length === 0 && activeDateReadsCount === 0 && Array.isArray(res.records)) {
          applyAuthoritativeSheetRecords(res.records, false);
        }

        if (fromAutoReconnect && cleanWireBatch.length > 0) {
          showBanner(
            'ok',
            '🌐 Đã có mạng trở lại! Đã tự động cập nhật ' + cleanWireBatch.length + ' thao tác tồn kho lên Google Sheet!'
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
      inFlightOpUids = {};
      if (!hadError || pendingOps.length === 0) {
        updateSyncBadge();
      }
      // BẮT BUỘC: Bất kỳ thao tác đã hoàn tất nào (kể cả cập nhật NSX/HSD của tem trước trong lúc đang quét tem kế tiếp!) đều phải đẩy ngay tức khắc!
      if (!hadError && navigator.onLine && hasAnyReadyPendingOps()) {
        setTimeout(function () { flushSyncQueue(false); }, 65);
      } else if (!hadError && hasAnyHeldPendingOps()) {
        armDateReadSyncSafetyTimer();
      } else if (pendingOps.length === 0 && activeDateReadsCount === 0) {
        setTimeout(checkPendingSwReload, 120);
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
    if (!navigator.onLine) return;
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
