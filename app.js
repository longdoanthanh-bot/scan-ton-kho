(function () {
  'use strict';

  const STORAGE_RECORDS = 'scan_ton_records_v1';
  const STORAGE_CUSTOM_CATALOG = 'scan_ton_custom_catalog_v1';
  const STORAGE_PENDING_OPS = 'scan_ton_pending_ops_v1';
  const STORAGE_SETTINGS = 'scan_ton_settings_v1';
  const STORAGE_ACTIVE_CUSTOMER = 'scan_ton_active_customer_v1';

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

  // Tùy chọn giải mã mọi loại Barcode 1D + QR Code cho trường Barcode khách hàng (Code128, Code39, Code93, Codabar, EAN-13, EAN-8, ITF, UPC-A, QRCode)
  const WASM_CUSTOMER_1D_OPTIONS = {
    formats: ['Code128', 'Code39', 'Code93', 'Codabar', 'EAN-13', 'EAN-8', 'ITF', 'UPC-A', 'QRCode'],
    tryHarder: true,
    tryRotate: true,
    tryInvert: true,
    tryDownscale: false,
    binarizer: 'LocalAverage',
    maxNumberOfSymbols: 2
  };

  const WASM_1D_OPTIONS = WASM_1D_LOCAL_OPTIONS;

  const LEGACY_SHEET_WEB_APP_ID = 'AKfycbxlF9UorbWyYzxFA4avEIkloBab44VZzqznaxTXSSTAZtb13QRp5GQoHb_KGCAnAayg';
  const DEFAULT_SHEET_WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbw_vz2A35sbBHaPgDSkCuUFl_fW7QIsghCsACc92aDs_kyOiC9ea39ZpyWu3_MaccTn/exec';
  const DEFAULT_SHEET_VIEW_URL = 'https://docs.google.com/spreadsheets/d/1jmwE8LBV4XroBIKVohHFDXwWjEhDwSHZnUb-ziLrDgk/edit?gid=0#gid=0';

  // State
  let records = [];
  let catalogMap = {};
  let pendingOps = [];
  let settings = {
    sheetWebAppUrl: DEFAULT_SHEET_WEB_APP_URL,
    sheetViewUrl: DEFAULT_SHEET_VIEW_URL,
    soundEnabled: true,
    duplicateAskSec: 0,
    scalePrefixOnly: true
  };

  let currentMode = 'camera';
  let syncInProgress = false;
  let lastScannedCode = '';
  let lastScannedEpoch = 0;
  let pendingDuplicateCode = null;
  let pendingDuplicateDates = null;
  let pendingDuplicateDateCtx = null;
  let dateOnlyTarget = 'latest';
  let dateOnlyTargetRecordId = null;
  let rescueTargetRecordId = null;
  let currentSummaryDim = 'sku_date';
  let activeCustomerBarcode = '';
  let customerScanArmed = false;
  let activeRecordCustomerFilter = 'ALL';
  let customerProdListExpanded = false;

  const APP_CACHE_VERSION = 'scan-ton-kho-v31';
  const STORAGE_APP_VERSION = 'scan_ton_app_ver_v1';

  // 1-Tap Still-Photo Camera, ImageCapture, Batch Upload & Offline OCR state
  let wasmReadyPromise = null;
  let nativeDetectorInitPromise = null;
  let batchProcessingActive = false;
  let batchCancelRequested = false;
  let rearVideoDevices = [];
  let selectedRearDeviceIdx = -1;
  let ocrWorkerPromise = null;
  let ocrWorkerResolved = false;
  let ocrQueuePromise = Promise.resolve();
  let photoSnapQueue = Promise.resolve();
  let pendingSnapJobsCount = 0;
  let imageCaptureDevice = null;
  let activeDateReadsCount = 0;
  let readingDateRecordIds = {};
  let readingDateStartedAt = {};
  let nextOpUid = 1;
  let inFlightOpUids = {};
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
  let shutterLockUntil = 0;
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

  function ensureNativeBarcodeDetector() {
    if (!('BarcodeDetector' in window) || !window.BarcodeDetector) {
      nativeDetector = null;
      nativeDetectorInitPromise = null;
      return Promise.resolve(null);
    }
    const Ctor = window.BarcodeDetector;
    if (nativeDetector && nativeDetector._ctor === Ctor) return Promise.resolve(nativeDetector);
    if (nativeDetector && nativeDetector._ctor !== Ctor) {
      nativeDetector = null;
      nativeDetectorInitPromise = null;
    }
    if (nativeDetectorInitPromise) return nativeDetectorInitPromise;
    nativeDetectorInitPromise = Ctor.getSupportedFormats().then(function (supported) {
      const formats1D = ['ean_13', 'code_128', 'code_39', 'code_93', 'codabar', 'ean_8', 'itf', 'upc_a', 'upc_e'].filter(function (f) {
        return supported.indexOf(f) !== -1;
      });
      if (formats1D.length > 0) {
        nativeDetector = new Ctor({ formats: formats1D });
        try { nativeDetector._ctor = Ctor; } catch (e) {}
      }
      nativeDetectorInitPromise = null;
      return nativeDetector;
    }).catch(function () {
      nativeDetectorInitPromise = null;
      return null;
    });
    return nativeDetectorInitPromise;
  }

  let nativeCustomerDetector = null;
  let nativeCustomerDetectorInitPromise = null;
  function ensureNativeCustomerDetector() {
    if (!('BarcodeDetector' in window) || !window.BarcodeDetector) {
      nativeCustomerDetector = null;
      nativeCustomerDetectorInitPromise = null;
      return Promise.resolve(null);
    }
    const Ctor = window.BarcodeDetector;
    if (nativeCustomerDetector && nativeCustomerDetector._ctor === Ctor) return Promise.resolve(nativeCustomerDetector);
    if (nativeCustomerDetector && nativeCustomerDetector._ctor !== Ctor) {
      nativeCustomerDetector = null;
      nativeCustomerCustomerDetectorInitPromise = null;
    }
    if (nativeCustomerDetectorInitPromise) return nativeCustomerDetectorInitPromise;
    nativeCustomerDetectorInitPromise = Ctor.getSupportedFormats().then(function (supported) {
      const formatsCust = ['code_128', 'code_39', 'code_93', 'codabar', 'ean_13', 'ean_8', 'itf', 'upc_a', 'upc_e', 'qr_code'].filter(function (f) {
        return supported.indexOf(f) !== -1;
      });
      if (formatsCust.length > 0) {
        nativeCustomerDetector = new Ctor({ formats: formatsCust });
        try { nativeCustomerDetector._ctor = Ctor; } catch (e) {}
      }
      nativeCustomerDetectorInitPromise = null;
      return nativeCustomerDetector;
    }).catch(function () {
      nativeCustomerDetectorInitPromise = null;
      return null;
    });
    return nativeCustomerDetectorInitPromise;
  }

  function warmUpWasmEngine() {
    ensureNativeBarcodeDetector();
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
    if (singleScanActive || pendingSnapJobsCount > 0 || batchProcessingActive || activeDateReadsCount > 0 || syncInProgress || pendingOps.length > 0) return;
    pendingSwReload = false;
    try {
      if (sessionStorage.getItem('sw_reloaded_v20') === '1') return;
      sessionStorage.setItem('sw_reloaded_v20', '1');
    } catch (e) {}
    window.location.reload();
  }

  function registerAndAutoUpdateServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (!(location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      return;
    }
    const hadPreviousController = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.register('./sw.js?v=20', { updateViaCache: 'none' }).then(function (reg) {
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
      if (singleScanActive || pendingSnapJobsCount > 0 || batchProcessingActive || activeDateReadsCount > 0 || syncInProgress || pendingOps.length > 0) {
        pendingSwReload = true;
        return;
      }
      try {
        if (sessionStorage.getItem('sw_reloaded_v20') === '1') return;
        sessionStorage.setItem('sw_reloaded_v20', '1');
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
    loadActiveCustomerState();
    checkUrlParamsForSheet();
    loadCatalog();
    await loadRecordsAndOpsWithVaultRecovery();

    bindEvents();
    syncCustomerScanBarUI();
    updateOfflineBannerUI();
    refreshSettingsSheetLinkUI();

    // Bản v27: Camera đóng gọn mặc định để màn hình chỉ có 2 ô trống; chỉ mở khi bấm biểu tượng 📷 ở Ô 1 hoặc Ô 2!

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
      if (!document.hidden && navigator.onLine && settings.sheetWebAppUrl && !singleScanActive && pendingSnapJobsCount === 0 && !batchProcessingActive && activeDateReadsCount === 0) {
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
          'Đang không có mạng (Offline) — Bạn cứ chụp bình thường! Đã lưu an toàn trên máy (' +
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
      if (!localStorage.getItem('scan_ton_v18_no_ok')) {
        settings.duplicateAskSec = 0;
        localStorage.setItem('scan_ton_v18_no_ok', '1');
        localStorage.setItem(STORAGE_SETTINGS, JSON.stringify(settings));
      }
      if (!settings.sheetWebAppUrl || String(settings.sheetWebAppUrl).indexOf(LEGACY_SHEET_WEB_APP_ID) !== -1) {
        settings.sheetWebAppUrl = DEFAULT_SHEET_WEB_APP_URL;
        localStorage.setItem(STORAGE_SETTINGS, JSON.stringify(settings));
      }
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
      if (!settings.sheetWebAppUrl || String(settings.sheetWebAppUrl).indexOf(LEGACY_SHEET_WEB_APP_ID) !== -1) {
        settings.sheetWebAppUrl = DEFAULT_SHEET_WEB_APP_URL;
        localStorage.setItem(STORAGE_SETTINGS, JSON.stringify(settings));
      }
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

  function cleanCustomerBarcode(raw) {
    const s = String(raw || '').replace(/[\u0000-\u001F\u007F]+/g, ' ').trim();
    if (!s || s === '—' || s === '-' || s === 'null' || s === 'undefined') return '';
    return s.slice(0, 64);
  }

  function formatCustomerDisplay(val) {
    const clean = cleanCustomerBarcode(val);
    return clean || '—';
  }

  function loadActiveCustomerState() {
    try {
      const saved = localStorage.getItem(STORAGE_ACTIVE_CUSTOMER);
      activeCustomerBarcode = cleanCustomerBarcode(saved);
    } catch (e) {
      activeCustomerBarcode = '';
    }
  }

  function setActiveCustomerBarcode(rawVal, disarmAfterSet) {
    activeCustomerBarcode = cleanCustomerBarcode(rawVal);
    if (disarmAfterSet) {
      customerScanArmed = false;
    }
    try {
      if (activeCustomerBarcode) {
        localStorage.setItem(STORAGE_ACTIVE_CUSTOMER, activeCustomerBarcode);
      } else {
        localStorage.removeItem(STORAGE_ACTIVE_CUSTOMER);
      }
    } catch (e) {}
    syncCustomerScanBarUI();
  }

  function toggleCustomerScanMode(forceState) {
    customerScanArmed = (typeof forceState === 'boolean') ? forceState : !customerScanArmed;
    if (customerScanArmed) {
      rescueTargetRecordId = null;
    }
    syncCustomerScanBarUI();
  }

  function getActiveCustomerMetrics() {
    if (!activeCustomerBarcode) return { count: 0, grams: 0, items: [] };
    const cleanActive = cleanCustomerBarcode(activeCustomerBarcode);
    const skuMap = {};
    let count = 0;
    let grams = 0;
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      if (cleanCustomerBarcode(r.customerBarcode) === cleanActive) {
        count += 1;
        grams += (r.grams || 0);
        const codeKey = r.productCode || 'UNKNOWN';
        if (!skuMap[codeKey]) {
          skuMap[codeKey] = {
            code: r.productCode || '—',
            name: r.productName || '',
            count: 0,
            grams: 0,
            lots: {}
          };
        }
        skuMap[codeKey].count += 1;
        skuMap[codeKey].grams += (r.grams || 0);
        if (r.productName && !skuMap[codeKey].name) skuMap[codeKey].name = r.productName;
        const lotKey = (r.nsx || r.hsd) ? (formatLotDateDisplay(r.nsx) + ' ➜ ' + formatLotDateDisplay(r.hsd)) : '';
        if (lotKey) {
          skuMap[codeKey].lots[lotKey] = (skuMap[codeKey].lots[lotKey] || 0) + 1;
        }
      }
    }
    const items = Object.keys(skuMap).map(function (k) { return skuMap[k]; });
    items.sort(function (a, b) { return b.grams - a.grams; });
    return { count: count, grams: grams, items: items };
  }

  function syncCustomerScanBarUI() {
    const bar = document.getElementById('customerScanBar');
    const inp = document.getElementById('customerBarcodeInput');
    const chip = document.getElementById('customerActiveChip');
    const btnScan = document.getElementById('btnScanCustomerBarcode');
    const btnSave = document.getElementById('btnSaveCustomerInput');
    const btnNext = document.getElementById('btnNextCustomer');
    const btnSkip = document.getElementById('btnClearCustomerBarcode');
    const quickPills = document.getElementById('customerQuickPills');
    const viewportBox = document.getElementById('cameraViewportBox');
    const aimTop = document.getElementById('aimZoneTop');
    const aimBottom = document.getElementById('aimZoneBottom');
    const stepInd = document.getElementById('customerStepIndicator');
    const barTitle = document.getElementById('customerBarTitle');
    const prodBox = document.getElementById('customerProductsSummaryBox');
    const prodHeadTxt = document.getElementById('custProdHeadText');
    const prodListContent = document.getElementById('custProdListContent');

    if (inp && document.activeElement !== inp && inp.value !== activeCustomerBarcode) {
      inp.value = activeCustomerBarcode;
    }
    if (bar) {
      bar.classList.toggle('is-armed', Boolean(customerScanArmed));
      const hasCust = Boolean(!customerScanArmed && activeCustomerBarcode);
      bar.classList.toggle('has-value', hasCust);
      bar.classList.toggle('field-ok', hasCust);
    }
    const custTick = document.getElementById('custDoneTick');
    if (custTick) {
      custTick.style.display = (!customerScanArmed && activeCustomerBarcode) ? 'inline-flex' : 'none';
    }

    // Bản v28: Không hiển thị thống kê hay liệt kê tên khách dưới ô Tên khách
    if (quickPills) {
      quickPills.innerHTML = '';
      quickPills.style.display = 'none';
    }
    if (prodBox) {
      prodBox.style.display = 'none';
    }

    if (customerScanArmed) {
      if (stepInd) stepInd.textContent = 'KH';
      if (barTitle) barTitle.textContent = 'Đang quét mã khách';
      if (chip) {
        chip.style.display = 'inline-block';
        chip.textContent = 'Quét mã KH';
      }
      if (btnScan) btnScan.textContent = '📷';
      if (btnNext) btnNext.style.display = 'none';
      if (btnSkip) {
        btnSkip.style.display = 'inline-flex';
        btnSkip.textContent = '✕';
      }
      if (prodBox) prodBox.style.display = 'none';
      if (viewportBox) viewportBox.classList.add('is-customer-mode');
      if (aimTop) aimTop.textContent = 'Quét tên khách';
      if (aimBottom) aimBottom.textContent = '';
      const drawerTitle1 = document.getElementById('cameraDrawerTitle');
      if (drawerTitle1) drawerTitle1.textContent = '📷 Bước 1: Quét Tên khách';
      const prodCard1 = document.getElementById('latestScanCard');
      if (prodCard1) prodCard1.classList.remove('step-focused');
    } else if (activeCustomerBarcode) {
      const custMet = getActiveCustomerMetrics();
      if (stepInd) stepInd.textContent = 'KH';
      if (barTitle) barTitle.innerHTML = '<strong>' + escapeHtml(activeCustomerBarcode) + '</strong>';
      if (chip) {
        chip.style.display = 'inline-block';
        chip.textContent = activeCustomerBarcode + ' (' + custMet.count + ')';
      }
      if (btnScan) btnScan.textContent = '📷';
      if (btnNext) btnNext.style.display = 'none';
      if (btnSkip) {
        btnSkip.style.display = 'inline-flex';
        btnSkip.textContent = '✕';
      }
      if (prodBox) prodBox.style.display = 'none';
      if (viewportBox) viewportBox.classList.remove('is-customer-mode');
      if (aimTop) aimTop.textContent = 'Bước 2: Quét sản phẩm (' + activeCustomerBarcode + ')';
      if (aimBottom) aimBottom.textContent = '';
      const drawerTitle2 = document.getElementById('cameraDrawerTitle');
      if (drawerTitle2) drawerTitle2.textContent = '📷 Bước 2: Quét Sản phẩm cho ' + activeCustomerBarcode;
      const prodCard2 = document.getElementById('latestScanCard');
      if (prodCard2) prodCard2.classList.add('step-focused');
    } else {
      if (stepInd) stepInd.textContent = 'KH';
      if (barTitle) barTitle.textContent = 'Tên khách';
      if (chip) chip.style.display = 'none';
      if (btnScan) btnScan.textContent = '📷';
      if (btnNext) btnNext.style.display = 'none';
      if (btnSkip) btnSkip.style.display = 'none';
      if (prodBox) prodBox.style.display = 'none';
      if (viewportBox) viewportBox.classList.remove('is-customer-mode');
      if (aimTop) aimTop.textContent = 'Bước 2: Quét sản phẩm';
      if (aimBottom) aimBottom.textContent = '';
      const drawerTitle3 = document.getElementById('cameraDrawerTitle');
      if (drawerTitle3) drawerTitle3.textContent = '📷 Bước 2: Quét Sản phẩm (Mã SP • Tên SP • Số ký)';
      const prodCard3 = document.getElementById('latestScanCard');
      if (prodCard3) prodCard3.classList.remove('step-focused');
    }
    setShutterUIState('ready');
  }

  function getActivePdaLotDates() {
    return { nsx: '', hsd: '' };
  }

  // =========================================================================
  // BỘ ĐỌC TỰ ĐỘNG NSX & HSD TRÊN TEM MEATCOOL & MỌI TEM CÂN KHO (BẢN v13 SIÊU TỐC: ĐA VÙNG THÔNG MINH, HỖ TRỢ MỌI LOẠI TEM & TỰ BÙ RẢNH TAY)
  // =========================================================================
  const OCR_NSX_PREFIX_RE = /N\s*[S58]\s*X|N\s*X\s*:|[S58]\s*X\s*:|N\s*[DĐ]\s*G|[DĐ]\s*G\s*:|DONG\s*GOI|MFG|PROD|NGAY\s*SX/;
  const OCR_HSD_PREFIX_RE = /H\s*[S58]\s*[DO0]|H\s*[S58]\s*:|[S58]\s*[DO0]\s*:|H\s*[DO0]\s*:|EXP|HAN\s*SD|SU\s*DUNG/;
  const OCR_ANY_DATE_PREFIX_RE = /N\s*[S58]\s*X|H\s*[S58]\s*[DO0]|N\s*X\s*:|H\s*[S58]\s*:|[S58]\s*X\s*:|[S58]\s*[DO0]\s*:|H\s*[DO0]\s*:|N\s*[DĐ]\s*G|[DĐ]\s*G\s*:|DONG\s*GOI|MFG|EXP|PROD|NGAY|HAN/;

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

    function tryPushCandidate(d, mo, y, matchIndex, matchLen, requireLabelPrefix, isSingleDigitDM) {
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
        end: mEnd,
        singleDigitDM: Boolean(isSingleDigitDM)
      });
    }

    // Lượt A: Bắt chuẩn ngày 4 số năm có dấu chấm, phẩy, gạch chéo, gạch ngang, hai chấm hoặc khoảng trắng ngang (không ăn sang dòng khác!)
    const regexSep = /(?:^|[^\d])(0?[1-9]|[12]\d|3[01])[.,\/:\- \t]{1,5}(0?[1-9]|1[0-2])[.,\/:\- \t]{1,5}(20[23]\d)(?!\d)/g;
    let m;
    while ((m = regexSep.exec(text)) !== null) {
      const sd = (m[1].length < 2 || m[2].length < 2);
      tryPushCandidate(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10), m.index, m[0].length, false, sd);
    }

    // Lượt A2: Cứu trường hợp nếp nhăn bao bì sát sau chữ số năm tạo thêm 1 số nhiễu (VD: 12.11.20261) khi có dấu chấm/gạch rõ ràng cả hai bên
    const regexDotSpeckle = /(?:^|[^\d])(0?[1-9]|[12]\d|3[01])[ \t]*[.,\/-][ \t]*(0?[1-9]|1[0-2])[ \t]*[.,\/-][ \t]*(20[23]\d)\d(?!\d)/g;
    while ((m = regexDotSpeckle.exec(text)) !== null) {
      const sd = (m[1].length < 2 || m[2].length < 2);
      tryPushCandidate(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10), m.index, m[0].length, false, sd);
    }

    // Lượt B: Bắt trường hợp ảnh hơi mờ làm mất 1 hoặc 2 dấu chấm nhỏ (VD: 12.112026, 1211.2026, hoặc NSX: 12112026)
    const regexCompact = /(?:^|[^\d])(0[1-9]|[12]\d|3[01])([.,\/:\- \t]?)(0[1-9]|1[0-2])([.,\/:\- \t]?)(20[23]\d)(?!\d)/g;
    while ((m = regexCompact.exec(text)) !== null) {
      const hasAnySep = Boolean(m[2] || m[4]);
      tryPushCandidate(parseInt(m[1], 10), parseInt(m[3], 10), parseInt(m[5], 10), m.index, m[0].length, !hasAnySep, false);
    }

    // Lượt C: Hỗ trợ định dạng năm-tháng-ngày yyyy.mm.dd / yyyy/mm/dd / yyyy-mm-dd
    const regexYmd = /(?:^|[^\d])(20[23]\d)\s*[.,\/-]\s*(0?[1-9]|1[0-2])\s*[.,\/-]\s*(0?[1-9]|[12]\d|3[01])(?!\d)/g;
    while ((m = regexYmd.exec(text)) !== null) {
      const sd = (m[2].length < 2 || m[3].length < 2);
      tryPushCandidate(parseInt(m[3], 10), parseInt(m[2], 10), parseInt(m[1], 10), m.index, m[0].length, false, sd);
    }

    // Lượt D: Hỗ trợ năm 2 chữ số trên tem cân siêu thị/kho (VD: 15.11.26, 15/11/26, 15-11-26) — bắt buộc có đủ 2 dấu phân cách ngày rõ ràng nên 0% nhầm số ký!
    const regexShortYear = /(?:^|[^\d])(0?[1-9]|[12]\d|3[01])\s*[.\/-]\s*(0?[1-9]|1[0-2])\s*[.\/-]\s*(2[4-9]|3[0-6])(?!\d)/g;
    while ((m = regexShortYear.exec(text)) !== null) {
      const sd = (m[1].length < 2 || m[2].length < 2);
      tryPushCandidate(parseInt(m[1], 10), parseInt(m[2], 10), 2000 + parseInt(m[3], 10), m.index, m[0].length, false, sd);
    }

    if (found.length === 0) return { nsx: '', hsd: '' };

    const unique = [];
    const seen = {};
    for (let i = 0; i < found.length; i++) {
      if (!seen[found[i].str]) {
        seen[found[i].str] = true;
        unique.push(found[i]);
      } else {
        for (let uIdx = 0; uIdx < unique.length; uIdx++) {
          if (unique[uIdx].str === found[i].str && !found[i].singleDigitDM) {
            unique[uIdx].singleDigitDM = false;
          }
        }
      }
    }

    const DAY_MS = 86400000;
    // Quy luật vật lý Fail-Closed: Ngày sản xuất (NSX) in trên tem hàng trong kho KHÔNG BAO GIỜ nằm ở tương lai xa (> hôm nay + 30 ngày, VD: nhầm 2026 thành 2028)!
    const maxValidNsxEpoch = Date.now() + 30 * DAY_MS;

    if (unique.length >= 2) {
      if (
        unique[0].epoch > unique[1].epoch &&
        !OCR_HSD_PREFIX_RE.test(unique[0].prefixCtx)
      ) {
        if (OCR_NSX_PREFIX_RE.test(unique[0].prefixCtx) && !OCR_HSD_PREFIX_RE.test(unique[1].prefixCtx) && unique[0].epoch <= maxValidNsxEpoch) {
          return {
            nsx: unique[0].str,
            hsd: '',
            suspectYearGap: Boolean(unique[0].singleDigitDM),
            suspectTruncatedNsx: Boolean(unique[0].singleDigitDM)
          };
        }
        if (OCR_HSD_PREFIX_RE.test(unique[1].prefixCtx) && !OCR_NSX_PREFIX_RE.test(unique[0].prefixCtx)) {
          return {
            nsx: '',
            hsd: unique[1].str,
            suspectYearGap: Boolean(unique[1].singleDigitDM),
            suspectTruncatedHsd: Boolean(unique[1].singleDigitDM)
          };
        }
        return { nsx: '', hsd: '' };
      }
      unique.sort(function (a, b) { return a.epoch - b.epoch; });
      const firstU = unique[0];
      const lastU = unique[unique.length - 1];
      const isFutureNsx = Boolean(firstU.epoch > maxValidNsxEpoch);
      const isWideGap = Boolean((lastU.epoch - firstU.epoch) > 190 * DAY_MS);
      const isTruncNsx = Boolean(firstU.singleDigitDM);
      const isTruncHsd = Boolean(lastU.singleDigitDM);
      return {
        nsx: firstU.str,
        hsd: lastU.str,
        suspectYearGap: Boolean(isWideGap || isFutureNsx || isTruncNsx || isTruncHsd),
        suspectFutureNsx: isFutureNsx,
        suspectTruncatedNsx: isTruncNsx,
        suspectTruncatedHsd: isTruncHsd
      };
    }

    if (found.length >= 2 && found[0].str === found[1].str) {
      const isFutSame = Boolean(found[0].epoch > maxValidNsxEpoch);
      const isTruncSame = Boolean(found[0].singleDigitDM && found[1].singleDigitDM);
      return {
        nsx: found[0].str,
        hsd: found[1].str,
        suspectYearGap: Boolean(isFutSame || isTruncSame),
        suspectFutureNsx: isFutSame,
        suspectTruncatedNsx: isTruncSame,
        suspectTruncatedHsd: isTruncSame
      };
    }

    // Chỉ đọc rõ được 1 ngày duy nhất -> kiểm tra nhãn NSX hay HSD đi kèm, tuyệt đối không tự đoán ngày còn lại!
    const single = unique[0];
    if (OCR_HSD_PREFIX_RE.test(single.prefixCtx)) {
      return {
        nsx: '',
        hsd: single.str,
        suspectYearGap: Boolean(single.singleDigitDM),
        suspectTruncatedHsd: Boolean(single.singleDigitDM)
      };
    }
    if (OCR_NSX_PREFIX_RE.test(single.prefixCtx)) {
      const isFutSingle = Boolean(single.epoch > maxValidNsxEpoch);
      return {
        nsx: single.str,
        hsd: '',
        suspectYearGap: Boolean(isFutSingle || single.singleDigitDM),
        suspectFutureNsx: isFutSingle,
        suspectTruncatedNsx: Boolean(single.singleDigitDM)
      };
    }
    return { nsx: '', hsd: '' };
  }

  function enhanceSoftGrayscaleCanvas(srcCanvas, customPad, customLowRatio) {
    const w = srcCanvas.width;
    const h = srcCanvas.height;
    const out = document.createElement('canvas');
    const pad = typeof customPad === 'number' ? customPad : 14;
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
    // Tuyệt đối không dùng gamma < 1 làm bạc mất nét số '1' trong '15' -> kéo tương phản tuyến tính sạch 100%!
    const lowRatio = (typeof customLowRatio === 'number' && customLowRatio > 0)
      ? customLowRatio
      : (high < 115 ? 0.018 : 0.002);
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

  // Bộ cân bằng sáng cục bộ chống lóa nilông, chống sọc màn hình & giữ mở khe hở chữ số 6 ở cự ly xa (~1.8ms)
  function enhanceLocalGlareAndLcdCanvas(srcCanvas, customPad) {
    const w = srcCanvas.width;
    const h = srcCanvas.height;
    const out = document.createElement('canvas');
    const pad = typeof customPad === 'number' ? customPad : 20;
    out.width = w + pad * 2;
    out.height = h + pad * 2;
    const oCtx = out.getContext('2d', { willReadFrequently: true });
    oCtx.fillStyle = '#ffffff';
    oCtx.fillRect(0, 0, out.width, out.height);
    oCtx.drawImage(srcCanvas, pad, pad);

    const img = oCtx.getImageData(pad, pad, w, h);
    const d = img.data;
    const total = w * h;
    const lum = new Uint8Array(total);
    for (let i = 0, p = 0; i < total; i++, p += 4) {
      lum[i] = (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8;
    }

    // Làm mịn nhẹ 3x3 [1, 2, 1] ở độ phân giải đã phóng to: xóa sạch sóng điểm ảnh màn hình mà không bào mòn nét dưới của chữ số 6
    const hSmooth = new Uint16Array(total);
    for (let y = 0; y < h; y++) {
      const ro = y * w;
      for (let x = 0; x < w; x++) {
        const xm1 = x > 0 ? x - 1 : 0;
        const xp1 = x + 1 < w ? x + 1 : w - 1;
        hSmooth[ro + x] = lum[ro + xm1] + (lum[ro + x] << 1) + lum[ro + xp1];
      }
    }
    const smooth = new Uint8Array(total);
    const stride = w + 1;
    const integral = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      const ym1 = (y > 0 ? y - 1 : 0) * w;
      const y0 = y * w;
      const yp1 = (y + 1 < h ? y + 1 : h - 1) * w;
      const intOff = (y + 1) * stride;
      const prevIntOff = y * stride;
      let rowSum = 0;
      for (let x = 0; x < w; x++) {
        const s = (hSmooth[ym1 + x] + (hSmooth[y0 + x] << 1) + hSmooth[yp1 + x] + 8) >> 4;
        smooth[y0 + x] = s;
        rowSum += s;
        integral[intOff + x + 1] = integral[prevIntOff + x + 1] + rowSum;
      }
    }

    const R = Math.max(18, Math.round(Math.min(w, h) * 0.12));
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - R);
      const y1 = Math.min(h - 1, y + R);
      const r0 = y0 * stride;
      const r1 = (y1 + 1) * stride;
      const ro = y * w;
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - R);
        const x1 = Math.min(w - 1, x + R);
        const cnt = (x1 - x0 + 1) * (y1 - y0 + 1);
        const localMean = (integral[r1 + x1 + 1] - integral[r0 + x1 + 1] - integral[r1 + x0] + integral[r0 + x0]) / cnt;
        const rel = localMean > 10 ? (smooth[ro + x] / localMean) : 1;
        let outV = 255;
        if (rel <= 0.74) {
          outV = 0;
        } else if (rel < 0.955) {
          const t = (rel - 0.74) / 0.215;
          outV = Math.max(0, Math.min(255, Math.round(Math.pow(t, 0.80) * 255)));
        }
        const p = (ro + x) * 4;
        d[p] = outV;
        d[p + 1] = outV;
        d[p + 2] = outV;
        d[p + 3] = 255;
      }
    }
    oCtx.putImageData(img, pad, pad);
    return out;
  }

  // Khôi phục độ sắc nét cho chữ nhỏ & dấu chấm '.' khi điện thoại đưa sát 12-18cm (ngoài khoảng lấy nét tối thiểu) hoặc luồng hình 720p bị mờ
  function sharpenDefocusedTextCanvas(srcCanvas, customPad) {
    const w = srcCanvas.width;
    const h = srcCanvas.height;
    const out = document.createElement('canvas');
    const pad = typeof customPad === 'number' ? customPad : 22;
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
        const sv = Math.round(norm[idx] + 1.42 * (norm[idx] - b));
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
    const vSpan = ((customBounds && typeof customBounds.vSpan === 'number') ? customBounds.vSpan : 0.96) * bw;

    // Tỷ lệ vàng 490px chiều ngang sọc: nhẹ hơn 2.2 lần cho chip điện thoại (đọc vèo ~120ms/lượt) mà vẫn giữ nguyên nét chữ số 6 ở cự ly xa 35-50cm!
    const targetBw = (customBounds && typeof customBounds.targetBw === 'number') ? customBounds.targetBw : 490;
    const minScale = (customBounds && typeof customBounds.minScale === 'number') ? customBounds.minScale : 1.20;
    const scale = Math.min(5.2, Math.max(minScale, targetBw / bw));
    const outW = Math.max(150, Math.round(uSpan * scale));
    const outH = Math.max(78, Math.round(vSpan * scale));

    const roi = document.createElement('canvas');
    roi.width = outW;
    roi.height = outH;
    const rCtx = roi.getContext('2d', { willReadFrequently: true });
    const paperRgb = sampleBrightPaperRgb(fullCanvas, cx, cy);
    rCtx.fillStyle = paperRgb;
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

  function parseStrDateEpochLocal(s) {
    if (!s) return NaN;
    const parts = String(s).split('/');
    if (parts.length !== 3) return NaN;
    return new Date(parseInt(parts[2], 10), parseInt(parts[1], 10) - 1, parseInt(parts[0], 10)).getTime();
  }

  // Cầu dao vật lý Fail-Closed cho kết quả NSX/HSD trước khi trả ra ngoài:
  // Chặn năm tương lai xa bất hợp lý (VD: NSX 2028 do lóa nặng không lượt nào xác thực được), tuyệt đối KHÔNG xóa nhầm HSD hợp lệ!
  function sanitizeFinalDatePair(pair) {
    if (!pair) return { nsx: '', hsd: '' };
    let nsx = pair.nsx || '';
    let hsd = pair.hsd || '';
    const DAY_MS = 86400000;
    const nowMs = Date.now();
    const maxValidNsxEpoch = nowMs + 30 * DAY_MS;
    const tN = parseStrDateEpochLocal(nsx);
    const tH = parseStrDateEpochLocal(hsd);

    if (!isNaN(tN) && tN > maxValidNsxEpoch) {
      nsx = '';
    }
    if (!isNaN(tH) && pair.suspectYearGap && (tH - nowMs) > 500 * DAY_MS) {
      hsd = '';
    }
    if (nsx && hsd && !isNaN(tN) && !isNaN(tH) && tN > tH) {
      return { nsx: '', hsd: '' };
    }
    return { nsx: nsx, hsd: hsd };
  }

  function mergeDatePair(base, next) {
    if (!next || (!next.nsx && !next.hsd)) {
      return {
        nsx: (base && base.nsx) ? base.nsx : '',
        hsd: (base && base.hsd) ? base.hsd : '',
        suspectYearGap: Boolean(base && base.suspectYearGap),
        suspectFutureNsx: Boolean(base && base.suspectFutureNsx),
        suspectTruncatedNsx: Boolean(base && base.suspectTruncatedNsx),
        suspectTruncatedHsd: Boolean(base && base.suspectTruncatedHsd)
      };
    }
    if (!base || (!base.nsx && !base.hsd)) {
      return {
        nsx: next.nsx || '',
        hsd: next.hsd || '',
        suspectYearGap: Boolean(next.suspectYearGap),
        suspectFutureNsx: Boolean(next.suspectFutureNsx),
        suspectTruncatedNsx: Boolean(next.suspectTruncatedNsx),
        suspectTruncatedHsd: Boolean(next.suspectTruncatedHsd)
      };
    }
    if (base.suspectYearGap && next.nsx && next.hsd && !next.suspectYearGap) {
      return { nsx: next.nsx, hsd: next.hsd, suspectYearGap: false, suspectFutureNsx: false, suspectTruncatedNsx: false, suspectTruncatedHsd: false };
    }
    if (base.suspectYearGap && (next.nsx || next.hsd) && !next.suspectFutureNsx) {
      const DAY_MS = 86400000;
      const maxValidNsx = Date.now() + 30 * DAY_MS;
      const candNsx = (next.nsx && !next.suspectTruncatedNsx)
        ? next.nsx
        : ((base.suspectFutureNsx || base.suspectTruncatedNsx) ? '' : (base.nsx || ''));
      const candHsd = (next.hsd && !next.suspectTruncatedHsd)
        ? next.hsd
        : (base.suspectTruncatedHsd ? '' : (base.hsd || ''));
      const ctN = parseStrDateEpochLocal(candNsx);
      const ctH = parseStrDateEpochLocal(candHsd);
      if (!isNaN(ctN) && !isNaN(ctH) && ctN <= maxValidNsx && ctH > ctN && (ctH - ctN) <= 190 * DAY_MS) {
        return { nsx: candNsx, hsd: candHsd, suspectYearGap: false, suspectFutureNsx: false, suspectTruncatedNsx: false, suspectTruncatedHsd: false };
      }
    }
    if (next.suspectYearGap && base.nsx && base.hsd && !base.suspectYearGap) {
      return { nsx: base.nsx, hsd: base.hsd, suspectYearGap: false, suspectFutureNsx: false, suspectTruncatedNsx: false, suspectTruncatedHsd: false };
    }
    if (next.nsx && next.hsd && (!base.nsx || !base.hsd) && !next.suspectFutureNsx) {
      return {
        nsx: next.nsx,
        hsd: next.hsd,
        suspectYearGap: Boolean(next.suspectYearGap),
        suspectFutureNsx: Boolean(next.suspectFutureNsx),
        suspectTruncatedNsx: Boolean(next.suspectTruncatedNsx),
        suspectTruncatedHsd: Boolean(next.suspectTruncatedHsd)
      };
    }
    const nextNsxDiffersFromHsd = Boolean(next.nsx && next.nsx !== (base.hsd || next.hsd || ''));
    const useNextNsx = Boolean(
      (!base.nsx && nextNsxDiffersFromHsd) ||
      (base.suspectFutureNsx && nextNsxDiffersFromHsd) ||
      (base.suspectTruncatedNsx && nextNsxDiffersFromHsd && !next.suspectTruncatedNsx && !next.suspectFutureNsx)
    );
    const useNextHsd = Boolean(
      (!base.hsd) ||
      (base.suspectTruncatedHsd && next.hsd && !next.suspectTruncatedHsd)
    );
    const mergedNsx = useNextNsx ? (next.nsx || base.nsx || '') : (base.nsx || next.nsx || '');
    const mergedHsd = useNextHsd ? (next.hsd || base.hsd || '') : (base.hsd || next.hsd || '');
    const mTruncNsx = useNextNsx ? Boolean(next.nsx ? next.suspectTruncatedNsx : base.suspectTruncatedNsx) : Boolean(base.suspectTruncatedNsx);
    const mTruncHsd = useNextHsd ? Boolean(next.hsd ? next.suspectTruncatedHsd : base.suspectTruncatedHsd) : Boolean(base.suspectTruncatedHsd);
    const mFut = Boolean((parseStrDateEpochLocal(mergedNsx) || 0) > (Date.now() + 30 * 86400000));
    let mergedSuspect = Boolean(base.suspectYearGap || next.suspectYearGap || mFut || mTruncNsx || mTruncHsd);
    if (mergedNsx && mergedHsd) {
      const tN = parseStrDateEpochLocal(mergedNsx);
      const tH = parseStrDateEpochLocal(mergedHsd);
      if (!isNaN(tN) && !isNaN(tH)) {
        if (tN > tH) {
          return (next.nsx && next.hsd && !next.suspectFutureNsx)
            ? { nsx: next.nsx, hsd: next.hsd, suspectYearGap: Boolean(next.suspectYearGap), suspectFutureNsx: false, suspectTruncatedNsx: Boolean(next.suspectTruncatedNsx), suspectTruncatedHsd: Boolean(next.suspectTruncatedHsd) }
            : { nsx: base.nsx || '', hsd: base.hsd || '', suspectYearGap: Boolean(base.suspectYearGap), suspectFutureNsx: Boolean(base.suspectFutureNsx), suspectTruncatedNsx: Boolean(base.suspectTruncatedNsx), suspectTruncatedHsd: Boolean(base.suspectTruncatedHsd) };
        }
        mergedSuspect = Boolean(mFut || mTruncNsx || mTruncHsd || (tH - tN) > 190 * 86400000);
      }
    }
    return {
      nsx: mergedNsx,
      hsd: mergedHsd,
      suspectYearGap: mergedSuspect,
      suspectFutureNsx: mFut,
      suspectTruncatedNsx: mTruncNsx,
      suspectTruncatedHsd: mTruncHsd
    };
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
    const isAborted = function () {
      return Boolean(cancelState && (cancelState.aborted || (cancelState.shouldAbort && cancelState.shouldAbort())));
    };
    const recordHit = function (resObj) {
      const parsed = parseOcrNsxHsdText(resObj && resObj.data ? resObj.data.text : '');
      best = mergeDatePair(best, parsed);
      if (cancelState) cancelState.partial = best;
      return Boolean(best.nsx && best.hsd && !best.suspectYearGap);
    };

    if (isAborted()) return best;

    // TRƯỜNG HỢP 1: ĐÃ BIẾT TỌA ĐỘ MÃ VẠCH (99% các ca quét Camera ĐT & Ảnh chụp điện thoại)
    // LUÔN ĐỌC CHIỀU THUẬN 0° TRƯỚC TIÊN (tuyệt đối không đảo ngược nhầm trên khung dọc 1080x1920 của điện thoại!)
    if (barcodePos) {
      const inkCheck0 = buildRawBarcodeGuidedCropCanvas(fullCanvas, barcodePos, 0, {
        uMin: -0.60,
        uSpan: 1.00,
        vMin: 0.50,
        vSpan: 0.78,
        targetBw: 240,
        minScale: 0.8
      });
      const bottomZoneHasInk = canvasHasTextContrast(inkCheck0);

      if (bottomZoneHasInk && !isAborted()) {
        // Khung chuẩn 490px vừa vặn trong lòng giấy trắng (nhẹ gấp 2.3 lần, đọc siêu tốc ~110ms trên ĐT!)
        const b2bRoi = buildRawBarcodeGuidedCropCanvas(fullCanvas, barcodePos, 0, {
          uMin: -0.96,
          uSpan: 1.38,
          vMin: 0.34,
          vSpan: 0.96,
          targetBw: 490,
          minScale: 1.2
        });
        // Vùng tách riêng cột chữ số ngày bên phải (tách sạch chữ NSX:/HSD: đậm bên trái & viền khung đỏ!)
        const datesColRoi = buildRawBarcodeGuidedCropCanvas(fullCanvas, barcodePos, 0, {
          uMin: -0.56,
          uSpan: 0.85,
          vMin: 0.35,
          vSpan: 0.92,
          targetBw: 560,
          minScale: 1.25
        });

        let b2bSoft = null;
        // 1A (Nhanh & chuẩn #1 trên điện thoại ~110ms): Tách cụm chữ độc lập trên nền xám mịn tự nhiên (PSM 11 — ăn ngay tem B2B phồng cong, tem Bán lẻ đủ sáng & giữ nguyên chữ số 6!)
        if (b2bRoi && !isAborted()) {
          b2bSoft = enhanceSoftGrayscaleCanvas(b2bRoi, 12);
          await worker.setParameters({
            tessedit_pageseg_mode: '11',
            tessedit_char_whitelist: DATE_WHITELIST
          });
          const resB2bSoft11 = await worker.recognize(b2bSoft);
          if (recordHit(resB2bSoft11)) return best;
        }

        // 1B (Nhanh & chuẩn #2 trên điện thoại ~130ms): Khử bóng đổ điện thoại che đèn & chống lóa túi nilông (tỷ lệ 410px rộng + cân bằng sáng cục bộ PSM 11 — ăn ngay Chân giò bóng đổ & Cốt lết lóa nilông!)
        if (!isAborted()) {
          const glareWideRoi = buildRawBarcodeGuidedCropCanvas(fullCanvas, barcodePos, 0, {
            uMin: -1.04,
            uSpan: 2.08,
            vMin: 0.36,
            vSpan: 1.20,
            targetBw: 410,
            minScale: 1.0
          });
          if (glareWideRoi) {
            await worker.setParameters({
              tessedit_pageseg_mode: '11',
              tessedit_char_whitelist: DATE_WHITELIST
            });
            const resGlareWide = await worker.recognize(enhanceLocalGlareAndLcdCanvas(glareWideRoi, 12));
            if (recordHit(resGlareWide)) return best;
          }
        }

        // 1B-2: Cột số ngày bên phải — kéo xám tự nhiên trước (giữ nguyên nét mảnh số '1' trong '15' và '11'!), sau đó cân bằng lóa cục bộ!
        if (datesColRoi && !isAborted()) {
          await worker.setParameters({
            tessedit_pageseg_mode: '6',
            tessedit_char_whitelist: DIGITS_ONLY_WHITELIST
          });
          const resColSoft = await worker.recognize(enhanceSoftGrayscaleCanvas(datesColRoi, 12, 0.003));
          if (recordHit(resColSoft)) return best;

          if (!isAborted()) {
            const resColLocal = await worker.recognize(enhanceLocalGlareAndLcdCanvas(datesColRoi, 12));
            if (recordHit(resColLocal)) return best;
          }
        }

        // 1C: Khung gọn vSpan=0.88 nằm trọn 100% trong lòng giấy trắng (tránh viền tối ngoài mép dưới tem ở cự ly xa 38% làm nhòe chữ số 6 thành 8!)
        if ((!best.nsx || !best.hsd || best.suspectYearGap) && !isAborted()) {
          await worker.setParameters({
            tessedit_pageseg_mode: '11',
            tessedit_char_whitelist: DATE_WHITELIST
          });
          const farCrispScales = [520, 440];
          for (let fIdx = 0; fIdx < farCrispScales.length; fIdx++) {
            if (isAborted()) break;
            const farB2b = buildRawBarcodeGuidedCropCanvas(fullCanvas, barcodePos, 0, {
              uMin: -0.96,
              uSpan: 1.36,
              vMin: 0.35,
              vSpan: 0.88,
              targetBw: farCrispScales[fIdx],
              minScale: 1.15
            });
            if (farB2b) {
              const resFar11 = await worker.recognize(enhanceSoftGrayscaleCanvas(farB2b, 12, 0.005));
              if (recordHit(resFar11)) return best;
            }
          }
        }

        // 1D: Khôi phục nét chữ mờ cận cảnh 12-18cm (ưu tiên PSM 11 trước giúp bắt ngay trên túi phồng cong!) & dòng ngang chuẩn PSM 6
        if (b2bRoi && !isAborted()) {
          const sharpB2b = sharpenDefocusedTextCanvas(b2bRoi, 12);
          await worker.setParameters({
            tessedit_pageseg_mode: '11',
            tessedit_char_whitelist: DATE_WHITELIST
          });
          const resB2bSharp11 = await worker.recognize(sharpB2b);
          if (recordHit(resB2bSharp11)) return best;

          await worker.setParameters({
            tessedit_pageseg_mode: '6',
            tessedit_char_whitelist: DATE_WHITELIST
          });
          if (b2bSoft && !isAborted()) {
            const resB2bSoft6 = await worker.recognize(b2bSoft);
            if (recordHit(resB2bSoft6)) return best;
          }
          if (!isAborted()) {
            const resB2bSharp6 = await worker.recognize(sharpB2b);
            if (recordHit(resB2bSharp6)) return best;
          }
          if (!isAborted() && datesColRoi) {
            await worker.setParameters({
              tessedit_pageseg_mode: '6',
              tessedit_char_whitelist: DIGITS_ONLY_WHITELIST
            });
            const resColSharp6 = await worker.recognize(sharpenDefocusedTextCanvas(datesColRoi, 12));
            if (recordHit(resColSharp6)) return best;
          }
        }

        // 1D-2: Khung sâu vSpan=1.24 khử bóng đổ điện thoại che đèn & góc chúc màn hình kéo dài dọc 1.18x (không bao giờ cắt cụt dòng HSD!)
        if ((!best.nsx || !best.hsd || best.suspectYearGap) && !isAborted()) {
          const deepRoi = buildRawBarcodeGuidedCropCanvas(fullCanvas, barcodePos, 0, {
            uMin: -0.96,
            uSpan: 1.38,
            vMin: 0.34,
            vSpan: 1.24,
            targetBw: 480,
            minScale: 1.15
          });
          if (deepRoi && !isAborted()) {
            await worker.setParameters({
              tessedit_pageseg_mode: '11',
              tessedit_char_whitelist: DATE_WHITELIST
            });
            const resDeepFlat = await worker.recognize(flattenIlluminationToCanvas(deepRoi));
            if (recordHit(resDeepFlat)) return best;

            if (!isAborted()) {
              await worker.setParameters({
                tessedit_pageseg_mode: '6',
                tessedit_char_whitelist: DATE_WHITELIST
              });
              const resDeepLcd = await worker.recognize(descreenLcdCanvas(deepRoi));
              if (recordHit(resDeepLcd)) return best;
            }
          }
        }

        // 1E: Bù góc nghiêng tay cầm điện thoại (Camera trực tiếp quét gọn [-7°, +7°] PSM 11 ~180ms để ngắt nhanh khi hạ máy; Ảnh tĩnh/Loạt ảnh quét sâu [-7°, +7°, -13°, +13°] vSpan=1.18!)
        const tiltMicroAngles = allowTiltedFallback ? [-7, 7, -13, 13] : [-7, 7];
        const tiltVSpan = allowTiltedFallback ? 1.18 : 1.04;
        for (let tIdx = 0; tIdx < tiltMicroAngles.length; tIdx++) {
          if (isAborted()) return best;
          const adjB2b = buildRawBarcodeGuidedCropCanvas(fullCanvas, barcodePos, tiltMicroAngles[tIdx], {
            uMin: -0.96,
            uSpan: 1.38,
            vMin: 0.34,
            vSpan: tiltVSpan,
            targetBw: 460,
            minScale: 1.15
          });
          if (adjB2b) {
            const adjSoft = enhanceSoftGrayscaleCanvas(adjB2b, 12);
            await worker.setParameters({
              tessedit_pageseg_mode: '11',
              tessedit_char_whitelist: DATE_WHITELIST
            });
            const resAdj11 = await worker.recognize(adjSoft);
            if (recordHit(resAdj11)) return best;
            if (allowTiltedFallback && !isAborted()) {
              await worker.setParameters({
                tessedit_pageseg_mode: '6',
                tessedit_char_whitelist: DATE_WHITELIST
              });
              const resAdj6 = await worker.recognize(adjSoft);
              if (recordHit(resAdj6)) return best;
            }
          }
        }
      }

      // 1F: Túi hàng đặt lộn ngược đầu [180°] hoặc cầm ngang 90° trên điện thoại Android (chạy ngay lập tức nếu vùng 0° trống mực!)
      let hasInk180 = false;
      if (!isAborted()) {
        const roi180 = buildRawBarcodeGuidedCropCanvas(fullCanvas, barcodePos, 180, {
          uMin: -0.96,
          uSpan: 1.38,
          vMin: 0.34,
          vSpan: 0.96,
          targetBw: 480,
          minScale: 1.2
        });
        if (roi180 && canvasHasTextContrast(roi180)) {
          hasInk180 = true;
          const soft180 = enhanceSoftGrayscaleCanvas(roi180, 12);
          await worker.setParameters({
            tessedit_pageseg_mode: '11',
            tessedit_char_whitelist: DATE_WHITELIST
          });
          const res180Sparse = await worker.recognize(soft180);
          if (recordHit(res180Sparse)) return best;

          if (!isAborted()) {
            await worker.setParameters({
              tessedit_pageseg_mode: '6',
              tessedit_char_whitelist: DATE_WHITELIST
            });
            const res180 = await worker.recognize(soft180);
            if (recordHit(res180)) return best;
          }
          if (!isAborted()) {
            const datesCol180 = buildRawBarcodeGuidedCropCanvas(fullCanvas, barcodePos, 180, {
              uMin: -0.56,
              uSpan: 0.86,
              vMin: 0.35,
              vSpan: 0.92,
              targetBw: 520,
              minScale: 1.2
            });
            if (datesCol180) {
              await worker.setParameters({
                tessedit_pageseg_mode: '6',
                tessedit_char_whitelist: DIGITS_ONLY_WHITELIST
              });
              const resCol180 = await worker.recognize(enhanceLocalGlareAndLcdCanvas(datesCol180, 12));
              if (recordHit(resCol180)) return best;
            }
          }
          if (!isAborted()) {
            await worker.setParameters({
              tessedit_pageseg_mode: '6',
              tessedit_char_whitelist: DATE_WHITELIST
            });
            const res180Sharp = await worker.recognize(sharpenDefocusedTextCanvas(roi180, 12));
            if (recordHit(res180Sharp)) return best;
          }
        }
      }

      // 1G: Mở rộng toàn chiều ngang tem cân kho/siêu thị (năm 2 số 14.11.26) + Toàn mặt tem
      if (bottomZoneHasInk && !isAborted()) {
        const wideScaleRoi = buildRawBarcodeGuidedCropCanvas(fullCanvas, barcodePos, 0, {
          uMin: -1.04,
          uSpan: 2.08,
          vMin: 0.36,
          vSpan: 1.22,
          targetBw: 410,
          minScale: 1.0
        });
        if (wideScaleRoi) {
          await worker.setParameters({
            tessedit_pageseg_mode: '6',
            tessedit_char_whitelist: DATE_WHITELIST
          });
          if (!isAborted()) {
            const resWide6 = await worker.recognize(enhanceSoftGrayscaleCanvas(wideScaleRoi, 12));
            if (recordHit(resWide6)) return best;
          }
          await worker.setParameters({
            tessedit_pageseg_mode: '11',
            tessedit_char_whitelist: DATE_WHITELIST
          });
          if (!isAborted()) {
            const resWideLocal = await worker.recognize(enhanceLocalGlareAndLcdCanvas(wideScaleRoi, 12));
            if (recordHit(resWideLocal)) return best;
          }
        }

        if (allowTiltedFallback && (!best.nsx || !best.hsd) && !isAborted()) {
          const wholeLabelRoi = buildRawBarcodeGuidedCropCanvas(fullCanvas, barcodePos, 0, {
            uMin: -1.06,
            uSpan: 2.12,
            vMin: -1.02,
            vSpan: 2.50,
            targetBw: 360,
            minScale: 0.95
          });
          if (wholeLabelRoi) {
            await worker.setParameters({
              tessedit_pageseg_mode: '11',
              tessedit_char_whitelist: DATE_WHITELIST
            });
            if (!isAborted()) {
              const resWhole = await worker.recognize(enhanceSoftGrayscaleCanvas(wholeLabelRoi, 12));
              if (recordHit(resWhole)) return best;
            }
          }
        }
      }

      if ((best.nsx && best.hsd && !best.suspectYearGap) || (!bottomZoneHasInk && !hasInk180) || isAborted()) {
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
      const angles = [-7, 7, -14, 14, 180];
      for (let i = 0; i < angles.length; i++) {
        if (isAborted()) return best;
        const tiltedCanvas = buildFullFrameDateCanvas(fullCanvas, angles[i]);
        const resTilt = await worker.recognize(tiltedCanvas);
        if (recordHit(resTilt)) return best;
      }
    }

    return best;
  }

  async function extractNsxHsdWithTimeout(fullCanvas, barcodePos, timeoutMs, allowTiltedFallback, rescueAimCropCanvas, shouldAbortFn) {
    // Bản v25 Siêu Tốc: Đã bỏ hoàn toàn đọc NSX/HSD để quét mã vạch tức thì (<50ms)!
    return { nsx: '', hsd: '' };
  }
  async function _legacyExtractNsxHsdWithTimeout(fullCanvas, barcodePos, timeoutMs, allowTiltedFallback, rescueAimCropCanvas, shouldAbortFn) {
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
    const perItemBudgetMs = timeoutMs || (barcodePos ? 3000 : 4000);
    return new Promise(function (resolve) {
      let settled = false;
      let itemTimer = null;
      const cancelState = { aborted: false, shouldAbort: shouldAbortFn || null, partial: { nsx: '', hsd: '' } };

      const finishCaller = function (val) {
        if (settled) return;
        settled = true;
        clearTimeout(outerSafetyTimer);
        if (itemTimer) clearTimeout(itemTimer);
        resolve(sanitizeFinalDatePair(val || cancelState.partial || { nsx: '', hsd: '' }));
      };

      const outerSafetyTimer = setTimeout(function () {
        cancelState.aborted = true;
        finishCaller(cancelState.partial);
      }, 9500);

      ocrQueuePromise = ocrQueuePromise.then(function () {
        if (settled || cancelState.aborted || (cancelState.shouldAbort && cancelState.shouldAbort())) {
          finishCaller(cancelState.partial);
          return;
        }
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
    const maxHold = ocrWorkerResolved ? 6800 : 9500;
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
    const waitMs = maxWaitMs || (ocrWorkerResolved ? 6900 : 9600);
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

      // Khung ảnh gốc của chính tem đó: luôn được đọc trọn vẹn (chỉ hủy nếu người dùng bấm xóa dòng đó);
      // Các khung chụp bồi sau đó từ Camera trực tiếp: hủy ngay nếu người dùng đã quét sang túi mới (tránh đọc nhầm túi mới vào túi cũ!)
      const shouldAbortInitial = function () {
        return !readingDateRecordIds[recordId];
      };
      const shouldAbortFollowUp = function () {
        return (
          !readingDateRecordIds[recordId] ||
          (!ctx.ignoreBarcodeMismatch && records.length > 0 && records[records.length - 1].id !== recordId)
        );
      };

      // Gom danh sách khung hình ứng viên: chỉ dùng khung sắc nét nhất trước cú chạm (không chèn thêm khung rung tay giây thứ 0!),
      // chỉ chụp thêm khung độ nét cao nếu luồng video rộng hơn >20% so với khung gốc!
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
        Math.max(ctx.liveVideo.videoWidth || 0, ctx.liveVideo.videoHeight || 0) > Math.max(ctx.frameCanvas.width, ctx.frameCanvas.height) * 1.22
      ) {
        const asyncHiRes = captureVideoToCanvas(ctx.liveVideo, null, 2560);
        candidates.push({ canvas: asyncHiRes, pos: null });
      }

      for (let i = 0; i < candidates.length; i++) {
        if (shouldAbortInitial()) break;
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
        const allowFullTilt = posUse
          ? Boolean(ctx.allowTilt && !ctx.liveVideo)
          : Boolean((!ctx.liveVideo || ctx.ignoreBarcodeMismatch) && ctx.allowTilt);
        const budgetMs = posUse
          ? (ctx.liveVideo ? 1850 : 5800)
          : (!ctx.liveVideo ? 5200 : (ctx.ignoreBarcodeMismatch ? 3800 : 1850));
        const dRes = await extractNsxHsdWithTimeout(item.canvas, posUse, budgetMs, allowFullTilt, rescueCrop, shouldAbortInitial);
        collected = mergeDatePair(collected, dRes);
        if (collected.nsx && collected.hsd && !collected.suspectYearGap) break;
      }

      // Nếu khung đầu bị rung tay lúc ngón cái chạm màn hình điện thoại bấm chụp mà Camera vẫn đang mở:
      // - Chờ 175ms cho hết hẳn rung ngón cái rồi lấy tối đa 3 nhịp ổn định nét (~0.17s -> 0.65s);
      // - Nếu người dùng đã hạ máy xuống bàn phím/mặt bàn (2 nhịp liên tiếp không còn mặt giấy tem) hoặc quét sang túi mới -> ngắt ngay tức khắc!
      if ((!collected.nsx || !collected.hsd) && ctx.liveVideo && !shouldAbortFollowUp()) {
        const followDelays = ctx.ignoreBarcodeMismatch ? [120, 210] : [175, 220, 260];
        let consecutiveOffLabel = 0;
        let closeUpPaperTries = 0;
        for (let f = 0; f < followDelays.length; f++) {
          if (shouldAbortFollowUp()) break;
          await new Promise(function (r) { setTimeout(r, followDelays[f]); });
          if (!cameraActive || !mediaStream || !ctx.liveVideo || ctx.liveVideo.readyState < 2 || ctx.liveVideo.videoWidth <= 0) {
            break;
          }
          if (shouldAbortFollowUp()) break;
          const nextCanvas = captureCleanFullVideoCanvas(ctx.liveVideo);
          const nextDet = await detectBarcodeQuickOnCanvas(nextCanvas);

          if (!ctx.ignoreBarcodeMismatch) {
            if (nextDet && nextDet.code && expectedBarcode && nextDet.code !== expectedBarcode) {
              // Người dùng đã chuyển ống kính sang túi thịt khác -> dừng ngay để bảo vệ tính chính xác!
              break;
            }
            if (!nextDet || !nextDet.pos) {
              if (closeUpPaperTries < 2 && hasWhiteLabelPaperInFrame(nextCanvas)) {
                closeUpPaperTries += 1;
                consecutiveOffLabel = 0;
                const directDates = await extractNsxHsdWithTimeout(
                  nextCanvas,
                  null,
                  1600,
                  false,
                  cropCenterAimFromCanvas(nextCanvas),
                  shouldAbortFollowUp
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
            const nextDates = await extractNsxHsdWithTimeout(nextCanvas, nextDet.pos, 2200, false, null, shouldAbortFollowUp);
            collected = mergeDatePair(collected, nextDates);
          } else {
            const rescueNextPos = nextDet ? nextDet.pos : null;
            const rescueNextCrop = rescueNextPos ? null : cropCenterAimFromCanvas(nextCanvas);
            const nextDates = await extractNsxHsdWithTimeout(nextCanvas, rescueNextPos, 2800, true, rescueNextCrop, shouldAbortFollowUp);
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
      } else {
        vibrateDevice([35]);
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
    const nsxClean = '';
    const hsdClean = '';
    const willReadDatesAsync = false;

    const record = {
      id: 'scan_' + now.getTime() + '_' + Math.random().toString(36).slice(2, 7),
      scannedAt: formatDateTimeVN(now),
      customerBarcode: cleanCustomerBarcode(activeCustomerBarcode),
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

    // Không rung mô-tơ điện thoại ngay giây thứ 0 khi đang đọc NSX/HSD từ Camera để tránh rung ống kính làm mờ chữ; chỉ kêu BÍP tức thì và rung sau khi đọc xong!
    if (parsed.productName === null) {
      playBeep('warn');
      if (!willReadDatesAsync) vibrateDevice([80, 40, 80]);
      showBanner('warn', 'Đã ghi nhận mã ' + parsed.productCode + ' (' + formatKg(parsed.grams) + ' Kg' + dateSuffix + ') nhưng chưa có Tên SP. Bấm "Sửa" để đặt tên!');
    } else {
      playBeep('ok');
      if (!willReadDatesAsync) vibrateDevice([45]);
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
      customerBarcode: cleanCustomerBarcode(r.customerBarcode),
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
  // CẦU DAO TỰ NGẮT KCS & TỔNG HỢP 4 CHIỀU (SKU × DATE | THEO SKU | THEO DATE | THEO KHÁCH HÀNG)
  // =========================================================================
  function parseDateVNForSort(rawStr) {
    const clean = normalizeDateVN(rawStr);
    if (!clean) return { ok: false, utc: Number.MAX_SAFE_INTEGER, display: '—' };
    const p = clean.split('/');
    const d = parseInt(p[0], 10);
    const m = parseInt(p[1], 10);
    const y = parseInt(p[2], 10);
    return {
      ok: true,
      utc: Date.UTC(y, m - 1, d),
      display: clean
    };
  }

  function evaluateShelfLifeApp(hsdStr) {
    const p = parseDateVNForSort(hsdStr);
    // Nguyên tắc Fail-Closed: Thiếu ngày thì trả về '—', tuyệt đối không tự đoán!
    if (!p.ok) return { text: '—', cls: 'unknown' };
    const now = new Date();
    const todayUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    const diffDays = Math.round((p.utc - todayUtc) / 86400000);
    if (diffDays < 0) {
      return { text: 'Quá hạn ' + Math.abs(diffDays) + ' ngày', cls: 'expired' };
    }
    if (diffDays === 0) {
      return { text: 'Hết hạn hôm nay', cls: 'near' };
    }
    if (diffDays <= 2) {
      return { text: 'Còn ' + diffDays + ' ngày (Cận date)', cls: 'near' };
    }
    return { text: 'Còn ' + diffDays + ' ngày', cls: 'ok' };
  }

  function computeMetrics() {
    let totalGrams = 0;
    const byCode = {};
    const bySkuDate = {};
    const byDate = {};
    const byCustomer = {};
    const knownDateKeys = {};
    const knownCustomerKeys = {};

    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      const g = Math.round(Number(r.grams));
      totalGrams += g;

      const custClean = cleanCustomerBarcode(r.customerBarcode);
      const hasCustomer = Boolean(custClean !== '');
      const custKey = hasCustomer ? ('KH_' + custClean) : '__SKIPPED__';
      if (hasCustomer) knownCustomerKeys[custClean] = true;

      const code = String(r.productCode || '').trim() || 'CHUA_RO';
      const pNsx = parseDateVNForSort(r.nsx);
      const pHsd = parseDateVNForSort(r.hsd);
      const nsxDisp = pNsx.ok ? pNsx.display : '—';
      const hsdDisp = pHsd.ok ? pHsd.display : '—';
      const hasDate = Boolean(pNsx.ok || pHsd.ok);
      const datePairKey = hsdDisp + '|' + nsxDisp;
      const skuDateKey = code + '|' + datePairKey;
      if (hasDate) knownDateKeys[datePairKey] = true;

      // 1. Theo SKU (Mã sản phẩm)
      if (!byCode[code]) {
        byCode[code] = {
          code: code,
          name: r.productName ? r.productName : null,
          count: 0,
          grams: 0,
          lots: {},
          dateMap: {}
        };
      }
      if (!byCode[code].name && r.productName) {
        byCode[code].name = r.productName;
      }
      if (hasDate) {
        const lotKey = nsxDisp + ' → ' + hsdDisp;
        byCode[code].lots[lotKey] = true;
      }
      if (!byCode[code].dateMap[datePairKey]) {
        byCode[code].dateMap[datePairKey] = {
          nsx: nsxDisp,
          hsd: hsdDisp,
          hsdUtc: pHsd.utc,
          nsxUtc: pNsx.utc,
          hasDate: hasDate,
          count: 0,
          grams: 0
        };
      }
      byCode[code].dateMap[datePairKey].count += 1;
      byCode[code].dateMap[datePairKey].grams += g;
      byCode[code].count += 1;
      byCode[code].grams += g;

      // 2. Theo SKU × Date (NSX / HSD)
      if (!bySkuDate[skuDateKey]) {
        bySkuDate[skuDateKey] = {
          code: code,
          name: r.productName ? r.productName : null,
          nsx: nsxDisp,
          hsd: hsdDisp,
          nsxUtc: pNsx.utc,
          hsdUtc: pHsd.utc,
          hasDate: hasDate,
          count: 0,
          grams: 0
        };
      }
      if (!bySkuDate[skuDateKey].name && r.productName) {
        bySkuDate[skuDateKey].name = r.productName;
      }
      bySkuDate[skuDateKey].count += 1;
      bySkuDate[skuDateKey].grams += g;

      // 3. Theo Date (HSD / NSX)
      if (!byDate[datePairKey]) {
        byDate[datePairKey] = {
          nsx: nsxDisp,
          hsd: hsdDisp,
          nsxUtc: pNsx.utc,
          hsdUtc: pHsd.utc,
          hasDate: hasDate,
          count: 0,
          grams: 0,
          skuMap: {}
        };
      }
      byDate[datePairKey].count += 1;
      byDate[datePairKey].grams += g;
      if (!byDate[datePairKey].skuMap[code]) {
        byDate[datePairKey].skuMap[code] = {
          code: code,
          name: r.productName ? r.productName : null,
          count: 0,
          grams: 0
        };
      }
      if (!byDate[datePairKey].skuMap[code].name && r.productName) {
        byDate[datePairKey].skuMap[code].name = r.productName;
      }
      byDate[datePairKey].skuMap[code].count += 1;
      byDate[datePairKey].skuMap[code].grams += g;

      // 4. Theo Barcode Khách hàng (Tùy chọn — bỏ qua thì gom về '—')
      if (!byCustomer[custKey]) {
        byCustomer[custKey] = {
          customer: hasCustomer ? custClean : '—',
          hasCustomer: hasCustomer,
          count: 0,
          grams: 0,
          skuMap: {}
        };
      }
      byCustomer[custKey].count += 1;
      byCustomer[custKey].grams += g;
      if (!byCustomer[custKey].skuMap[code]) {
        byCustomer[custKey].skuMap[code] = {
          code: code,
          name: r.productName ? r.productName : null,
          count: 0,
          grams: 0,
          dateLots: {}
        };
      }
      if (!byCustomer[custKey].skuMap[code].name && r.productName) {
        byCustomer[custKey].skuMap[code].name = r.productName;
      }
      if (hasDate) {
        const lotKey = nsxDisp + ' → ' + hsdDisp;
        byCustomer[custKey].skuMap[code].dateLots[lotKey] = true;
      }
      byCustomer[custKey].skuMap[code].count += 1;
      byCustomer[custKey].skuMap[code].grams += g;
    }

    const productGroups = Object.keys(byCode).map(function (k) { return byCode[k]; });
    productGroups.sort(function (a, b) { return b.grams - a.grams; });

    const skuDateGroups = Object.keys(bySkuDate).map(function (k) { return bySkuDate[k]; });
    skuDateGroups.sort(function (a, b) {
      if (a.code !== b.code) return String(a.code).localeCompare(String(b.code));
      if (a.hsdUtc !== b.hsdUtc) return a.hsdUtc - b.hsdUtc;
      return a.nsxUtc - b.nsxUtc;
    });

    const dateGroups = Object.keys(byDate).map(function (k) { return byDate[k]; });
    dateGroups.sort(function (a, b) {
      if (a.hasDate !== b.hasDate) return a.hasDate ? -1 : 1;
      if (a.hsdUtc !== b.hsdUtc) return a.hsdUtc - b.hsdUtc;
      if (a.nsxUtc !== b.nsxUtc) return a.nsxUtc - b.nsxUtc;
      return b.grams - a.grams;
    });

    const customerGroups = Object.keys(byCustomer).map(function (k) { return byCustomer[k]; });
    customerGroups.sort(function (a, b) {
      if (a.hasCustomer !== b.hasCustomer) return a.hasCustomer ? -1 : 1;
      if (b.grams !== a.grams) return b.grams - a.grams;
      return String(a.customer).localeCompare(String(b.customer));
    });

    return {
      totalScans: records.length,
      totalProducts: productGroups.length,
      totalDateLots: Object.keys(knownDateKeys).length,
      totalCustomers: Object.keys(knownCustomerKeys).length,
      totalGrams: totalGrams,
      productGroups: productGroups,
      skuDateGroups: skuDateGroups,
      dateGroups: dateGroups,
      customerGroups: customerGroups
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
    let sumSdCount = 0, sumSdGrams = 0;
    for (let i = 0; i < m.skuDateGroups.length; i++) {
      sumSdCount += m.skuDateGroups[i].count;
      sumSdGrams += m.skuDateGroups[i].grams;
    }
    let sumDtCount = 0, sumDtGrams = 0;
    for (let i = 0; i < m.dateGroups.length; i++) {
      sumDtCount += m.dateGroups[i].count;
      sumDtGrams += m.dateGroups[i].grams;
    }
    let sumCustCount = 0, sumCustGrams = 0;
    for (let i = 0; i < m.customerGroups.length; i++) {
      sumCustCount += m.customerGroups[i].count;
      sumCustGrams += m.customerGroups[i].grams;
    }
    if (sumGroupCount !== m.totalScans || sumSdCount !== m.totalScans || sumDtCount !== m.totalScans || sumCustCount !== m.totalScans) {
      return { ok: false, error: 'Lệch tổng số tem đối chiếu 4 chiều (' + sumGroupCount + '/' + sumSdCount + '/' + sumDtCount + '/' + sumCustCount + ' != ' + m.totalScans + ')' };
    }
    if (sumGroupGrams !== m.totalGrams || sumSdGrams !== m.totalGrams || sumDtGrams !== m.totalGrams || sumCustGrams !== m.totalGrams) {
      return { ok: false, error: 'Lệch tổng số ký đối chiếu 4 chiều (' + sumGroupGrams + '/' + sumSdGrams + '/' + sumDtGrams + '/' + sumCustGrams + ' != ' + m.totalGrams + ')' };
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

  function getDuplicateCodeWeightInfo(rec) {
    if (!rec || !rec.productCode || !rec.grams) return { count: 0, sameCustCount: 0, isDup: false, isSameCustDup: false };
    const codeKey = String(rec.productCode).trim();
    const gramsVal = Math.round(Number(rec.grams) || 0);
    const custKey = cleanCustomerBarcode(rec.customerBarcode).toLowerCase();
    let count = 0;
    let sameCustCount = 0;
    for (let i = 0; i < records.length; i++) {
      const it = records[i];
      if (String(it.productCode || '').trim() === codeKey && Math.round(Number(it.grams) || 0) === gramsVal) {
        count += 1;
        if (custKey && cleanCustomerBarcode(it.customerBarcode).toLowerCase() === custKey) {
          sameCustCount += 1;
        }
      }
    }
    return {
      count: count,
      sameCustCount: sameCustCount,
      isDup: count >= 2,
      isSameCustDup: sameCustCount >= 2
    };
  }

  function renderLatestCard(flash) {
    const card = document.getElementById('latestScanCard');
    const emptyState = document.getElementById('latestEmptyState');
    const contentState = document.getElementById('latestContentState');
    const prodTick = document.getElementById('prodDoneTick');
    const dupStrip = document.getElementById('dupAlertStrip');
    const dupStripText = document.getElementById('dupAlertStripText');
    const btnUndoDup = document.getElementById('btnUndoDupScan');

    if (records.length === 0) {
      emptyState.style.display = 'none';
      contentState.style.display = 'none';
      card.classList.remove('flash-ok', 'flash-warn', 'field-ok', 'field-dup-warn');
      if (prodTick) {
        prodTick.style.display = 'none';
        prodTick.classList.remove('is-dup');
      }
      if (dupStrip) dupStrip.style.display = 'none';
      return;
    }

    emptyState.style.display = 'none';
    contentState.style.display = 'block';

    const latest = records[records.length - 1];
    const dupInfo = getDuplicateCodeWeightInfo(latest);
    if (dupInfo.isDup) {
      card.classList.remove('field-ok');
      card.classList.add('field-dup-warn');
      if (prodTick) {
        prodTick.style.display = 'inline-flex';
        prodTick.classList.add('is-dup');
        prodTick.textContent = dupInfo.isSameCustDup
          ? ('⚠️ TRÙNG KH + MÃ + KÝ (x' + dupInfo.count + ')')
          : ('⚠️ TRÙNG MÃ + KÝ (x' + dupInfo.count + ')');
      }
      if (dupStrip && dupStripText) {
        dupStrip.style.display = 'flex';
        dupStripText.textContent = (dupInfo.isSameCustDup ? '⚠️ TRÙNG KHÁCH + MÃ + SỐ KÝ: ' : '⚠️ TRÙNG MÃ + SỐ KÝ: ') +
          (latest.productCode || '—') + ' (' + formatKg(latest.grams) + ' Kg) đã quét ' + dupInfo.count + ' lần!';
      }
      if (btnUndoDup) {
        btnUndoDup.onclick = function () {
          deleteRecordById(latest.id);
        };
      }
    } else {
      card.classList.remove('field-dup-warn');
      card.classList.add('field-ok');
      if (prodTick) {
        prodTick.style.display = 'inline-flex';
        prodTick.classList.remove('is-dup');
        prodTick.textContent = '✅ Đã ghi nhận';
      }
      if (dupStrip) dupStrip.style.display = 'none';
    }
    document.getElementById('latestTime').textContent = latest.scannedAt;

    const latestCustEl = document.getElementById('latestCustomer');
    if (latestCustEl) {
      const custVal = cleanCustomerBarcode(latest.customerBarcode);
      latestCustEl.textContent = custVal || '—';
      if (latestCustEl.parentElement) {
        latestCustEl.parentElement.classList.toggle('has-cust', Boolean(custVal));
      }
    }

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
        rescueDatesForRecord(latest.id);
      };
    }

    if (flash) {
      card.classList.remove('flash-ok', 'flash-warn');
      void card.offsetWidth;
      card.classList.add(latest.productName ? 'flash-ok' : 'flash-warn');
    }
  }

  function renderCustomerFilterBarUI(m) {
    const bar = document.getElementById('customerFilterBar');
    if (!bar) return;
    if (!m || !m.customerGroups || (m.customerGroups.length <= 1 && (!m.customerGroups[0] || !m.customerGroups[0].hasCustomer))) {
      bar.style.display = 'none';
      bar.innerHTML = '';
      return;
    }
    bar.style.display = 'flex';
    const pills = [];
    const isAll = (activeRecordCustomerFilter === 'ALL');
    pills.push(
      '<button type="button" class="cust-filter-pill' + (isAll ? ' active' : '') + '" onclick="window.AppActions.filterCustomer(\'ALL\')">' +
        'Tất cả (' + m.totalScans + ')' +
      '</button>'
    );
    for (let i = 0; i < m.customerGroups.length; i++) {
      const cg = m.customerGroups[i];
      if (cg.hasCustomer) {
        const isActive = (activeRecordCustomerFilter === cg.customer);
        pills.push(
          '<button type="button" class="cust-filter-pill' + (isActive ? ' active' : '') + '" onclick="window.AppActions.filterCustomer(\'' + escapeHtml(cg.customer).replace(/'/g, "\\'") + '\')">' +
            '👤 ' + escapeHtml(cg.customer) + ' (' + cg.count + ')' +
          '</button>'
        );
      } else {
        const isActive = (activeRecordCustomerFilter === '__EMPTY__');
        pills.push(
          '<button type="button" class="cust-filter-pill' + (isActive ? ' active' : '') + '" onclick="window.AppActions.filterCustomer(\'__EMPTY__\')">' +
            '👤 Chưa gán (' + cg.count + ')' +
          '</button>'
        );
      }
    }
    bar.innerHTML = pills.join('');
  }

  function renderScanLists() {
    const m = computeMetrics();
    renderCustomerFilterBarUI(m);

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
      const r = item.rec;
      const custClean = cleanCustomerBarcode(r.customerBarcode);
      if (activeRecordCustomerFilter !== 'ALL') {
        if (activeRecordCustomerFilter === '__EMPTY__') {
          if (custClean !== '') return false;
        } else {
          if (custClean !== activeRecordCustomerFilter) return false;
        }
      }
      if (!query) return true;
      return (
        String(r.customerBarcode || '').toLowerCase().indexOf(query) !== -1 ||
        String(r.productCode || '').toLowerCase().indexOf(query) !== -1 ||
        String(r.productName || '').toLowerCase().indexOf(query) !== -1 ||
        String(r.nsx || '').toLowerCase().indexOf(query) !== -1 ||
        String(r.hsd || '').toLowerCase().indexOf(query) !== -1 ||
        String(r.rawBarcode || '').toLowerCase().indexOf(query) !== -1 ||
        String(r.note || '').toLowerCase().indexOf(query) !== -1
      );
    });

    if (filtered.length === 0) {
      fullContainer.innerHTML = '<div style="text-align:center;color:#64748b;padding:18px;font-size:13.5px;">Không tìm thấy dòng quét nào phù hợp' + (activeRecordCustomerFilter !== 'ALL' ? ' cho khách hàng này.' : '.') + '</div>';
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
    const custVal = cleanCustomerBarcode(r.customerBarcode);
    const custBadge = custVal
      ? ('<span class="scan-cust-badge">👤 KH: ' + escapeHtml(custVal) + '</span>')
      : ('<span class="scan-cust-badge is-empty">👤 KH: —</span>');
    const dupInfoRow = getDuplicateCodeWeightInfo(r);
    const dupRowBadge = dupInfoRow.isDup
      ? ('<span class="scan-dup-badge">⚠️ TRÙNG MÃ+KÝ (x' + dupInfoRow.count + ')</span>')
      : '';
    const lotLine = '<div>' + custBadge + dupRowBadge + '</div>';
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
    const thead = document.getElementById('summaryTableHead');
    const tbody = document.getElementById('summaryTableBody');
    document.querySelectorAll('.summary-dim-btn').forEach(function (b) {
      b.classList.toggle('active', b.dataset.dim === currentSummaryDim);
    });

    if (currentSummaryDim === 'sku_date') {
      if (thead) {
        thead.innerHTML = (
          '<tr>' +
            '<th>Mã SKU</th>' +
            '<th>Tên SP &amp; Hạn dùng</th>' +
            '<th>NSX → HSD (Date)</th>' +
            '<th class="num">Số tem</th>' +
            '<th class="num">Số ký (Kg)</th>' +
          '</tr>'
        );
      }
      if (!m.skuDateGroups || m.skuDateGroups.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#64748b;padding:18px;">Chưa có dữ liệu tổng hợp theo SKU × Date.</td></tr>';
        return;
      }
      let html = '';
      for (let i = 0; i < m.skuDateGroups.length; i++) {
        const sd = m.skuDateGroups[i];
        const dispName = sd.name ? escapeHtml(sd.name) : '<span style="color:#b45309;">— (Chưa đặt tên)</span>';
        const st = evaluateShelfLifeApp(sd.hsd);
        const stPill = '<div class="shelf-pill ' + st.cls + '">' + escapeHtml(st.text) + '</div>';
        const dateDisp = (sd.nsx !== '—' || sd.hsd !== '—')
          ? ('<div style="font-size:12px;font-weight:800;color:#0f2942;">HSD: ' + escapeHtml(sd.hsd) + '</div>' +
             '<div style="font-size:11px;color:#475569;">NSX: ' + escapeHtml(sd.nsx) + '</div>')
          : '<span style="color:#64748b;font-weight:700;">—</span>';
        html += (
          '<tr>' +
            '<td><span class="code-chip">' + escapeHtml(sd.code) + '</span></td>' +
            '<td style="font-weight:700;">' + dispName + stPill + '</td>' +
            '<td>' + dateDisp + '</td>' +
            '<td class="num">' + formatInt(sd.count) + '</td>' +
            '<td class="num" style="color:#15803d;">' + formatKg(sd.grams) + '</td>' +
          '</tr>'
        );
      }
      html += (
        '<tr style="background:#f0fdf4;font-weight:900;">' +
          '<td colspan="3">TỔNG CỘNG (' + formatInt(m.skuDateGroups.length) + ' dòng SKU × Date)</td>' +
          '<td class="num">' + formatInt(m.totalScans) + '</td>' +
          '<td class="num" style="color:#15803d;">' + formatKg(m.totalGrams) + '</td>' +
        '</tr>'
      );
      tbody.innerHTML = html;
      return;
    }

    if (currentSummaryDim === 'date') {
      if (thead) {
        thead.innerHTML = (
          '<tr>' +
            '<th>HSD (Date) &amp; NSX</th>' +
            '<th>Tình trạng &amp; Các SKU thuộc Date</th>' +
            '<th class="num">Số tem</th>' +
            '<th class="num">Số ký (Kg)</th>' +
          '</tr>'
        );
      }
      if (!m.dateGroups || m.dateGroups.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#64748b;padding:18px;">Chưa có dữ liệu tổng hợp theo Date.</td></tr>';
        return;
      }
      let html = '';
      for (let i = 0; i < m.dateGroups.length; i++) {
        const dg = m.dateGroups[i];
        const st = dg.hasDate
          ? evaluateShelfLifeApp(dg.hsd)
          : { text: '— (Chưa ghi nhận NSX/HSD)', cls: 'unknown' };
        const sList = Object.keys(dg.skuMap).map(function (k) { return dg.skuMap[k]; });
        sList.sort(function (a, b) { return b.grams - a.grams; });
        const skuLines = sList.map(function (s) {
          return escapeHtml(s.code + ' - ' + (s.name || '—') + ' (' + s.count + ' tem • ' + formatKg(s.grams) + ' Kg)');
        }).join('<br>');
        const dateCell = dg.hasDate
          ? ('<div style="font-weight:900;color:#0f2942;">HSD: ' + escapeHtml(dg.hsd) + '</div>' +
             '<div style="font-size:11.5px;color:#475569;">NSX: ' + escapeHtml(dg.nsx) + '</div>')
          : '<span style="font-weight:800;color:#64748b;">— (Chưa rõ Date)</span>';
        html += (
          '<tr>' +
            '<td>' + dateCell + '</td>' +
            '<td><span class="shelf-pill ' + st.cls + '">' + escapeHtml(st.text) + '</span>' +
              '<div style="font-size:11.5px;color:#334155;font-weight:600;margin-top:4px;line-height:1.4;">' + skuLines + '</div></td>' +
            '<td class="num">' + formatInt(dg.count) + '</td>' +
            '<td class="num" style="color:#15803d;">' + formatKg(dg.grams) + '</td>' +
          '</tr>'
        );
      }
      html += (
        '<tr style="background:#f0fdf4;font-weight:900;">' +
          '<td colspan="2">TỔNG CỘNG (' + formatInt(m.dateGroups.length) + ' nhóm Date)</td>' +
          '<td class="num">' + formatInt(m.totalScans) + '</td>' +
          '<td class="num" style="color:#15803d;">' + formatKg(m.totalGrams) + '</td>' +
        '</tr>'
      );
      tbody.innerHTML = html;
      return;
    }

    if (currentSummaryDim === 'customer') {
      if (thead) {
        thead.innerHTML = (
          '<tr>' +
            '<th>Barcode khách hàng</th>' +
            '<th>Các SKU thuộc Khách hàng</th>' +
            '<th class="num">Số tem</th>' +
            '<th class="num">Số ký (Kg)</th>' +
          '</tr>'
        );
      }
      if (!m.customerGroups || m.customerGroups.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#64748b;padding:18px;">Chưa có dữ liệu tổng hợp theo Khách hàng.</td></tr>';
        return;
      }
      let html = '';
      for (let i = 0; i < m.customerGroups.length; i++) {
        const cg = m.customerGroups[i];
        const sList = Object.keys(cg.skuMap).map(function (k) { return cg.skuMap[k]; });
        sList.sort(function (a, b) { return b.grams - a.grams; });
        const skuLines = sList.map(function (s) {
          const lotsArr = Object.keys(s.dateLots || {});
          const lotStr = lotsArr.length > 0
            ? (' <span style="color:#0284c7;font-weight:700;">[Lô Date: ' + escapeHtml(lotsArr.join(', ')) + ']</span>')
            : '';
          return '• ' + escapeHtml(s.code + ' - ' + (s.name || '—') + ': ' + s.count + ' tem • ' + formatKg(s.grams) + ' Kg') + lotStr;
        }).join('<br>');
        const custCell = cg.hasCustomer
          ? ('<span class="scan-cust-badge">👤 ' + escapeHtml(cg.customer) + '</span>')
          : '<span style="font-weight:800;color:#64748b;">— (Không gán KH)</span>';
        html += (
          '<tr>' +
            '<td>' + custCell + '</td>' +
            '<td><div style="font-size:11.5px;color:#334155;font-weight:600;line-height:1.45;">' + skuLines + '</div></td>' +
            '<td class="num">' + formatInt(cg.count) + '</td>' +
            '<td class="num" style="color:#15803d;">' + formatKg(cg.grams) + '</td>' +
          '</tr>'
        );
      }
      html += (
        '<tr style="background:#f0fdf4;font-weight:900;">' +
          '<td colspan="2">TỔNG CỘNG (' + formatInt(m.customerGroups.length) + ' nhóm KH)</td>' +
          '<td class="num">' + formatInt(m.totalScans) + '</td>' +
          '<td class="num" style="color:#15803d;">' + formatKg(m.totalGrams) + '</td>' +
        '</tr>'
      );
      tbody.innerHTML = html;
      return;
    }

    // Chế độ gộp theo SKU ('sku')
    if (thead) {
      thead.innerHTML = (
        '<tr>' +
          '<th>Mã SKU</th>' +
          '<th>Tên sản phẩm &amp; Chi tiết Date</th>' +
          '<th class="num">Số tem</th>' +
          '<th class="num">Số ký (Kg)</th>' +
        '</tr>'
      );
    }
    if (m.productGroups.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#64748b;padding:18px;">Chưa có dữ liệu tổng hợp.</td></tr>';
      return;
    }
    let html = '';
    for (let i = 0; i < m.productGroups.length; i++) {
      const g = m.productGroups[i];
      const dispName = g.name ? escapeHtml(g.name) : '<span style="color:#b45309;">— (Chưa đặt tên)</span>';
      const dItems = Object.keys(g.dateMap || {}).map(function (k) { return g.dateMap[k]; });
      dItems.sort(function (a, b) {
        if (a.hasDate !== b.hasDate) return a.hasDate ? -1 : 1;
        return a.hsdUtc - b.hsdUtc;
      });
      const lotParts = dItems.map(function (di) {
        return di.hasDate
          ? ('HSD ' + di.hsd + ' (NSX ' + di.nsx + '): ' + di.count + ' tem • ' + formatKg(di.grams) + ' Kg')
          : ('Chưa rõ date (—): ' + di.count + ' tem • ' + formatKg(di.grams) + ' Kg');
      });
      const lotSub = lotParts.length > 0
        ? ('<div style="font-size:11.5px;color:#0369a1;font-weight:600;margin-top:3px;line-height:1.4;">📅 ' + lotParts.map(escapeHtml).join('<br>📅 ') + '</div>')
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
        '<td colspan="2">TỔNG CỘNG (' + formatInt(m.totalProducts) + ' mã SKU)</td>' +
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
      const custInp = document.getElementById('editCustomerInput');
      if (custInp) custInp.value = activeCustomerBarcode || '';
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
      const custInp = document.getElementById('editCustomerInput');
      if (custInp) custInp.value = cleanCustomerBarcode(rec.customerBarcode);
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
    const custInp = document.getElementById('editCustomerInput');
    const cleanCust = custInp ? cleanCustomerBarcode(custInp.value) : '';
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
        customerBarcode: cleanCust,
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
      records[idx].customerBarcode = cleanCust;
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
  // BẢN v18: MÁY ẢNH CHỤP TĨNH 4:3 MỘT CHẠM (NỔI HÌNH LÊN LÀ ĐÃ GHI NHẬN • BỎ QUA NÚT OK)
  // =========================================================================
  async function refreshRearLensList() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const vids = all.filter(function (d) { return d && d.kind === 'videoinput'; });
      const rears = vids.filter(function (d) {
        const lbl = String(d.label || '').toLowerCase();
        return lbl.indexOf('back') !== -1 || lbl.indexOf('rear') !== -1 || lbl.indexOf('environment') !== -1 || lbl.indexOf('sau') !== -1;
      });
      rearVideoDevices = rears.length >= 2 ? rears : (vids.length >= 3 ? vids.slice(1) : []);
      const btnLens = document.getElementById('btnSwitchLens');
      if (btnLens) {
        if (rearVideoDevices.length >= 2) {
          btnLens.style.display = 'inline-flex';
          const curIdx = selectedRearDeviceIdx >= 0 ? (selectedRearDeviceIdx % rearVideoDevices.length) : 0;
          btnLens.textContent = '🔄 Ống kính (' + (curIdx + 1) + '/' + rearVideoDevices.length + ')';
        } else {
          btnLens.style.display = 'none';
        }
      }
    } catch (e) {}
  }

  async function cycleRearCameraLens() {
    await refreshRearLensList();
    if (rearVideoDevices.length < 2) {
      showBanner('warn', 'Điện thoại này chỉ mở 1 ống kính — Hãy chọn mức "1.5x Nét" và giữ cách tem khoảng 20–25cm để lấy nét rõ nhất!');
      return;
    }
    selectedRearDeviceIdx = (selectedRearDeviceIdx + 1) % rearVideoDevices.length;
    const chosen = rearVideoDevices[selectedRearDeviceIdx];
    showBanner('ok', '🔄 Đang chuyển sang ống kính ' + (selectedRearDeviceIdx + 1) + '/' + rearVideoDevices.length + (chosen.label ? (' (' + chosen.label + ')') : '') + '...');
    await startCamera1DScanner();
  }

  async function requestUniversalCameraStream() {
    if (selectedRearDeviceIdx >= 0 && rearVideoDevices.length >= 2) {
      const targetDev = rearVideoDevices[selectedRearDeviceIdx % rearVideoDevices.length];
      if (targetDev && targetDev.deviceId) {
        try {
          return await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
              deviceId: { exact: targetDev.deviceId },
              width: { ideal: 3264 },
              height: { ideal: 2448 }
            }
          });
        } catch (e) {
          try {
            return await navigator.mediaDevices.getUserMedia({
              audio: false,
              video: { deviceId: { exact: targetDev.deviceId } }
            });
          } catch (e2) {}
        }
      }
    }

    // Ưu tiên chuẩn cảm biến CHỤP ẢNH TĨNH 4:3 (3264x2448 / 2560x1920 / 1920x1440) giống hệt Máy ảnh gốc điện thoại:
    // Kích hoạt lấy nét cảm biến cứng toàn khung thay vì bị cắt xén như chế độ quay phim 16:9!
    const constraintsList = [
      {
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 3264 },
          height: { ideal: 2448 }
        }
      },
      {
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 2560 },
          height: { ideal: 1920 }
        }
      },
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
    throw lastErr || new Error('Thiết bị không có Máy ảnh khả dụng');
  }

  async function triggerCameraRefocus(ev) {
    if (!mediaStream) return;
    const viewportBox = document.getElementById('cameraViewportBox');
    const ringEl = document.getElementById('tapFocusRing');
    let normX = 0.5;
    let normY = 0.5;
    if (ev && viewportBox && typeof ev.clientX === 'number') {
      const rect = viewportBox.getBoundingClientRect();
      const relX = Math.max(24, Math.min(rect.width - 24, ev.clientX - rect.left));
      const relY = Math.max(24, Math.min(rect.height - 24, ev.clientY - rect.top));
      normX = Math.max(0.05, Math.min(0.95, relX / Math.max(1, rect.width)));
      normY = Math.max(0.05, Math.min(0.95, relY / Math.max(1, rect.height)));
      if (ringEl) {
        ringEl.style.left = relX + 'px';
        ringEl.style.top = relY + 'px';
        ringEl.classList.remove('active');
        void ringEl.offsetWidth;
        ringEl.classList.add('active');
        setTimeout(function () {
          ringEl.classList.remove('active');
        }, 700);
      }
    }

    const track = mediaStream.getVideoTracks()[0];
    if (!track || !track.getCapabilities || !track.applyConstraints) return;
    try {
      const caps = track.getCapabilities();
      const focusConstraint = {};
      if (caps.pointsOfInterest) {
        focusConstraint.pointsOfInterest = [{ x: normX, y: normY }];
      }
      if (caps.focusMode) {
        if (caps.focusMode.indexOf('single-shot') !== -1) {
          focusConstraint.focusMode = 'single-shot';
          await track.applyConstraints({ advanced: [focusConstraint] });
          setTimeout(function () {
            if (caps.focusMode.indexOf('continuous') !== -1) {
              track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(function () {});
            }
          }, 420);
          return;
        }
        if (caps.focusMode.indexOf('continuous') !== -1) {
          focusConstraint.focusMode = 'continuous';
        }
      }
      if (Object.keys(focusConstraint).length > 0) {
        await track.applyConstraints({ advanced: [focusConstraint] });
      }
    } catch (e) {}
  }

  async function startCamera1DScanner() {
    stopCamera1DScanner();
    const statusEl = document.getElementById('cameraStatusBadge');
    const httpsPrompt = document.getElementById('httpsUpgradePrompt');
    const viewportBox = document.getElementById('cameraViewportBox');

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      if (httpsPrompt) httpsPrompt.style.display = 'block';
      if (viewportBox) viewportBox.style.display = 'flex';
      const httpsUrl = (location.port === '8088')
        ? ('https://' + location.hostname + ':8443/' + location.search)
        : ('https://longdoanthanh-bot.github.io/scan-ton-kho/' + location.search);
      const jumpBtn = document.getElementById('btnJumpHttps');
      if (jumpBtn) jumpBtn.href = httpsUrl;
      if (statusEl) statusEl.textContent = '🔒 Hãy bấm nút xanh phía trên để mở qua kết nối bảo mật HTTPS!';
      return;
    }

    if (httpsPrompt) httpsPrompt.style.display = 'none';
    if (viewportBox) viewportBox.style.display = 'flex';

    await warmUpWasmEngine();
    await ensureNativeBarcodeDetector();
    setTimeout(function () { warmUpOcrWorker(); }, 30);

    try {
      if (statusEl) statusEl.textContent = 'Đang mở Máy ảnh chụp 1 chạm độ nét cao...';
      mediaStream = await requestUniversalCameraStream();

      const video = document.getElementById('cameraVideo');
      video.setAttribute('playsinline', 'true');
      video.setAttribute('webkit-playsinline', 'true');
      video.muted = true;
      video.srcObject = mediaStream;
      await video.play();

      const track = mediaStream.getVideoTracks()[0];
      hardwareZoomSupported = false;
      imageCaptureDevice = null;
      if (track && typeof window.ImageCapture === 'function') {
        try {
          imageCaptureDevice = new window.ImageCapture(track);
        } catch (icErr) {
          imageCaptureDevice = null;
        }
      }

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
            currentZoom = caps.zoom.max >= 1.5 ? 1.5 : 1;
            adv.zoom = Math.min(currentZoom, caps.zoom.max);
          } else {
            currentZoom = 1;
          }
          if (Object.keys(adv).length > 0) {
            await track.applyConstraints({ advanced: [adv] });
          }
        } catch (e) {}
      }
      applyZoomLevel(currentZoom);

      cameraActive = true;
      singleScanActive = false;
      refreshRearLensList();
      setShutterUIState('ready');
      startAutoLiveScanLoop();
    } catch (err) {
      if (statusEl) {
        statusEl.textContent = 'Chưa mở được Máy ảnh (' + (err.message || err) + ') — Bấm "📚 Tải ảnh có sẵn" bên dưới!';
      }
    }
  }

  function setShutterUIState(mode, customText) {
    const viewportBox = document.getElementById('cameraViewportBox');
    const statusEl = document.getElementById('cameraStatusBadge');
    const iconEl = document.getElementById('shutterIcon');
    const textEl = document.getElementById('shutterText');
    if (!viewportBox || !statusEl || !iconEl || !textEl) return;

    viewportBox.classList.remove('is-scanning', 'is-captured');
    if (mode === 'captured') {
      viewportBox.classList.add('is-captured');
      iconEl.textContent = '📸';
      textEl.textContent = 'CHỤP';
      statusEl.textContent = customText || '✅ Đã nổi hình & tự động ghi nhận! Chụp tiếp tem sau được ngay';
    } else {
      iconEl.textContent = customerScanArmed ? '👤' : '📸';
      textEl.textContent = customerScanArmed ? 'MÃ KH' : 'CHỤP';
      statusEl.textContent = customText || (
        customerScanArmed
          ? '🎯 Đưa Barcode khách hàng vào khung → Bấm nút tròn (Hoặc bấm "⏭️ Bỏ qua" nếu không cần)!'
          : (rescueTargetRecordId
              ? '🎯 Đưa rõ góc chữ NSX / HSD vào khung → Bấm nút tròn CHỤP để bù ngày ngay!'
              : (activeCustomerBarcode
                  ? ('👤 Đang gán KH: ' + activeCustomerBarcode + ' → Bấm nút tròn CHỤP tem sản phẩm ngay!')
                  : '👆 Chạm vào tem để lấy nét → Bấm nút tròn là nổi hình & ghi nhận ngay (Bỏ qua nút OK)!'))
      );
    }
  }

  function applyZoomLevel(z) {
    currentZoom = Number(z) || 1;
    document.querySelectorAll('.zoom-btn').forEach(function (btn) {
      const isSelected = Number(btn.dataset.zoom) === currentZoom;
      btn.className = isSelected ? 'btn btn-primary zoom-btn' : 'btn btn-outline zoom-btn';
    });

    const video = document.getElementById('cameraVideo');
    if (!mediaStream || !video) return;
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

  function triggerShutterFlashEffect() {
    const fl = document.getElementById('shutterFlashOverlay');
    if (!fl) return;
    fl.classList.add('flash');
    setTimeout(function () {
      fl.classList.remove('flash');
    }, 85);
  }

  function createThumbnailDataUrl(srcCanvas, maxThumbW) {
    try {
      const tw = Math.min(maxThumbW || 200, Math.max(80, srcCanvas.width));
      const th = Math.max(60, Math.round(srcCanvas.height * (tw / Math.max(1, srcCanvas.width))));
      const tc = document.createElement('canvas');
      tc.width = tw;
      tc.height = th;
      const tctx = tc.getContext('2d');
      tctx.drawImage(srcCanvas, 0, 0, tw, th);
      return tc.toDataURL('image/jpeg', 0.78);
    } catch (e) {
      return '';
    }
  }

  function updateSnapPopCardUI(opts) {
    const card = document.getElementById('snapPopCard');
    const thumb = document.getElementById('snapPopThumb');
    const badge = document.getElementById('snapPopBadge');
    const title = document.getElementById('snapPopTitle');
    const dates = document.getElementById('snapPopDates');
    const btnRescue = document.getElementById('btnSnapPopRescueDates');
    const btnEdit = document.getElementById('btnSnapPopEdit');
    const btnUndo = document.getElementById('btnSnapPopUndo');
    if (!card || !badge || !title || !dates) return;

    card.style.display = 'flex';
    card.className = 'snap-pop-card' + (opts.stateClass ? (' ' + opts.stateClass) : '');

    if (opts.thumbSrc && thumb) {
      thumb.src = opts.thumbSrc;
    }
    badge.textContent = opts.badge || '';
    title.textContent = opts.title || '—';
    dates.textContent = opts.dates || '';

    const recId = opts.recordId || null;
    if (btnRescue) {
      if (recId && opts.showRescue) {
        btnRescue.style.display = 'inline-block';
        btnRescue.onclick = function () {
          rescueDatesForRecord(recId);
        };
      } else {
        btnRescue.style.display = 'none';
      }
    }
    if (btnEdit) {
      if (recId) {
        btnEdit.style.display = 'inline-block';
        btnEdit.onclick = function () {
          openEditModal(recId);
        };
      } else {
        btnEdit.style.display = 'none';
      }
    }
    if (btnUndo) {
      if (recId) {
        btnUndo.style.display = 'inline-block';
        btnUndo.onclick = function () {
          undoSnapRecordImmediate(recId);
        };
      } else {
        btnUndo.style.display = 'none';
      }
    }
  }

  function undoSnapRecordImmediate(recordId) {
    const rec = records.find(function (r) { return r.id === recordId; });
    if (!rec) return;
    const label = (rec.productName || ('Mã ' + rec.productCode)) + ' (' + formatKg(rec.grams) + ' Kg)';
    delete readingDateRecordIds[recordId];
    records = records.filter(function (r) { return r.id !== recordId; });
    persistRecords();
    enqueueOp({ type: 'delete', id: recordId });
    renderAll(false);
    flushSyncQueue(false);
    const card = document.getElementById('snapPopCard');
    if (card) card.style.display = 'none';
    showBanner('warn', '🗑️ Đã hủy tấm vừa chụp: "' + label + '"!');
  }

  function takeHardwareStillPhotoWithTimeout(icDev, timeoutMs) {
    if (!icDev || typeof icDev.takePhoto !== 'function') {
      return Promise.resolve(null);
    }
    return new Promise(function (resolve) {
      let settled = false;
      const t = setTimeout(function () {
        if (!settled) { settled = true; resolve(null); }
      }, timeoutMs || 1200);

      Promise.resolve().then(async function () {
        let photoOpts = undefined;
        if (typeof icDev.getPhotoCapabilities === 'function') {
          try {
            const pc = await icDev.getPhotoCapabilities();
            if (pc && pc.imageWidth && pc.imageWidth.max) {
              photoOpts = { imageWidth: Math.min(3264, pc.imageWidth.max) };
            }
          } catch (e) {}
        }
        return photoOpts ? icDev.takePhoto(photoOpts) : icDev.takePhoto();
      }).then(function (blob) {
        if (!settled) {
          settled = true;
          clearTimeout(t);
          resolve((blob && blob.size > 800) ? blob : null);
        }
      }).catch(function () {
        if (!settled) {
          settled = true;
          clearTimeout(t);
          resolve(null);
        }
      });
    });
  }

  function onShutterScanClick() {
    if (Date.now() < shutterLockUntil) return;

    if (!cameraActive || !mediaStream) {
      const gal = document.getElementById('batchGalleryInput');
      if (gal) gal.click();
      return;
    }

    const video = document.getElementById('cameraVideo');
    if (!video || video.readyState < 2 || video.videoWidth <= 0) {
      return;
    }

    shutterLockUntil = Date.now() + 180;
    triggerShutterFlashEffect();

    // 1. NỔI HÌNH LÊN NGAY TỨC KHẮC Ở GIÂY THỨ 0 (KHÔNG QUA MÀN HÌNH OK XÁC NHẬN!)
    const instantStillCanvas = captureVideoToCanvas(video, null, 2400);
    const instantThumb = createThumbnailDataUrl(instantStillCanvas, 200);
    const shotRescueRecId = rescueTargetRecordId;
    rescueTargetRecordId = null;
    const shotIsCustomerMode = Boolean(customerScanArmed && !shotRescueRecId);

    pendingSnapJobsCount += 1;
    const queueNote = pendingSnapJobsCount > 1 ? (' (Hàng chờ: ' + pendingSnapJobsCount + ' tấm)') : '';
    updateSnapPopCardUI({
      stateClass: '',
      thumbSrc: instantThumb,
      badge: shotIsCustomerMode
        ? ('👤 ĐÃ CHỤP • ĐANG ĐỌC BARCODE KHÁCH HÀNG' + queueNote)
        : ('⚡ ĐÃ CHỤP • ĐANG TỰ ĐỘNG GHI NHẬN' + queueNote),
      title: shotIsCustomerMode
        ? 'Đang nhận diện mã vạch sọc khách hàng...'
        : (shotRescueRecId ? 'Đang đọc bù NSX / HSD từ ảnh vừa chụp...' : 'Đang lấy Mã SP • Số ký • NSX • HSD...'),
      dates: shotIsCustomerMode
        ? 'Quét xong sẽ tự chuyển ngay sang chế độ chụp sản phẩm!'
        : 'Không cần bấm OK — có thể hướng sang tem kế tiếp ngay!',
      recordId: null
    });
    setShutterUIState('captured');

    // 2. Lấy ảnh chụp tĩnh phần cứng độ nét gốc (ImageCapture.takePhoto trên Android) song song với khung dự phòng 2400px
    const hwBlobPromise = takeHardwareStillPhotoWithTimeout(imageCaptureDevice, 1200);

    // 3. Đưa vào hàng đợi xử lý tuần tự & TỰ ĐỘNG GHI NHẬN LÊN GOOGLE SHEET SCAN TỒN
    photoSnapQueue = photoSnapQueue.then(async function () {
      let workCanvas = instantStillCanvas;
      let finalThumb = instantThumb;
      try {
        await warmUpWasmEngine();
        await ensureNativeBarcodeDetector();
        if (!shotIsCustomerMode) {
          await warmUpOcrWorker();
        }

        const hwBlob = await hwBlobPromise;
        if (hwBlob) {
          try {
            const hwPack = await loadCleanCanvasFromFile(hwBlob, 2400);
            if (hwPack && hwPack.canvas && hwPack.canvas.width > 100) {
              if (workCanvas && workCanvas !== hwPack.canvas) {
                workCanvas.width = 0;
                workCanvas.height = 0;
              }
              workCanvas = hwPack.canvas;
              finalThumb = createThumbnailDataUrl(workCanvas, 200) || instantThumb;
            }
          } catch (e) {}
        }

        // Trường hợp 0: Đang ở chế độ quét Barcode khách hàng trước khi quét sản phẩm (có thể bấm Bỏ qua bất cứ lúc nào)
        if (shotIsCustomerMode) {
          const custHit = await decodeCustomer1DBarcode(hwBlob, workCanvas);
          const cleanCust = custHit ? cleanCustomerBarcode(custHit.code) : '';
          if (cleanCust) {
            setActiveCustomerBarcode(cleanCust, true);
            playBeep('ok');
            vibrateDevice([35]);
            updateSnapPopCardUI({
              stateClass: 'state-ok',
              thumbSrc: finalThumb,
              badge: '✅ ĐÃ GÁN BARCODE KHÁCH HÀNG — CHỤP SP NGAY!',
              title: '👤 Khách hàng: ' + cleanCust,
              dates: 'Các tem sản phẩm chụp tiếp theo sẽ tự gắn mã KH này (Bấm "✕ Bỏ qua" nếu muốn xóa)',
              recordId: null
            });
            showBanner('ok', '✅ Đã gán Barcode khách hàng: "' + cleanCust + '" — Giờ hãy chụp các tem sản phẩm!');
          } else {
            playBeep('error');
            updateSnapPopCardUI({
              stateClass: 'state-err',
              thumbSrc: finalThumb,
              badge: '❌ CHƯA RÕ BARCODE KHÁCH HÀNG — CHỤP LẠI HOẶC BỎ QUA',
              title: 'Chưa thấy rõ dải mã vạch sọc khách hàng',
              dates: 'Đưa rõ mã vạch KH vào khung chụp lại, hoặc bấm "⏭️ Bỏ qua" ở thanh trên để quét SP luôn!',
              recordId: null
            });
            showBanner('warn', '⚠️ Chưa đọc rõ Barcode khách hàng — Chụp lại hoặc bấm "⏭️ Bỏ qua" nếu không cần!');
          }
          return;
        }

        // Trường hợp A: Chụp bù ngày NSX/HSD cho dòng cụ thể
        if (shotRescueRecId) {
          const recTarget = records.find(function (r) { return r.id === shotRescueRecId; });
          const posRescue = await detectBarcodePositionOnCanvas(workCanvas);
          const rescueDates = await extractNsxHsdWithTimeout(
            workCanvas,
            posRescue,
            4500,
            true,
            posRescue ? null : cropCenterAimFromCanvas(workCanvas)
          );
          if (recTarget && (rescueDates.nsx || rescueDates.hsd)) {
            if (rescueDates.nsx) recTarget.nsx = rescueDates.nsx;
            if (rescueDates.hsd) recTarget.hsd = rescueDates.hsd;
            persistRecords();
            enqueueOp({ type: 'update', record: toSyncRecord(recTarget) });
            renderAll(true);
            flushSyncQueue(false);
            playBeep('ok');
            updateSnapPopCardUI({
              stateClass: 'state-ok',
              thumbSrc: finalThumb,
              badge: '✅ ĐÃ BÙ NSX / HSD & LƯU TỰ ĐỘNG!',
              title: (recTarget.productName || ('Mã ' + recTarget.productCode)) + ' — ' + formatKg(recTarget.grams) + ' Kg',
              dates: 'NSX: ' + formatLotDateDisplay(recTarget.nsx) + ' • HSD: ' + formatLotDateDisplay(recTarget.hsd),
              recordId: recTarget.id,
              showRescue: !(recTarget.nsx && recTarget.hsd)
            });
          } else {
            playBeep('error');
            updateSnapPopCardUI({
              stateClass: 'state-err',
              thumbSrc: finalThumb,
              badge: '❌ CHƯA RÕ DÒNG NSX / HSD — CHỤP LẠI!',
              title: 'Chưa đọc rõ ngày trên tấm vừa chụp',
              dates: 'Đưa rõ góc chữ NSX / HSD vào khung rồi bấm Chụp lại',
              recordId: shotRescueRecId,
              showRescue: true
            });
          }
          return;
        }

        // Trường hợp B: Chụp tem bình thường -> Giải mã mã vạch 1D 13 số (khóa cứng QR Code!) + Đọc trọn NSX & HSD rồi GHI NHẬN TỰ ĐỘNG!
        let hit = await decodePhotoInBrowserWasm(hwBlob, workCanvas);
        let parsed = (hit && hit.code) ? parseSingle13DigitScaleBarcode(hit.code) : null;

        // DUAL-AUTO-DETECT: Nếu người dùng chụp dải Barcode hoặc QR Code khách hàng (phiếu xuất/hóa đơn) mà không bấm nút "Quét mã KH" trước
        if (!parsed || !parsed.ok) {
          const autoCustHit = await decodeCustomer1DBarcode(hwBlob, workCanvas);
          const autoCustCode = autoCustHit ? cleanCustomerBarcode(autoCustHit.code) : '';
          if (autoCustCode) {
            setActiveCustomerBarcode(autoCustCode, true);
            playBeep('ok');
            vibrateDevice([40, 60, 40]);
            updateSnapPopCardUI({
              stateClass: 'state-ok',
              thumbSrc: finalThumb,
              badge: '✅ ĐÃ TỰ ĐỘNG NHẬN DIỆN MÃ KHÁCH HÀNG!',
              title: '👤 Khách hàng: ' + autoCustCode,
              dates: '👉 BƯỚC 2: BÂY GIỜ HÃY CHỤP CÁC SẢN PHẨM CỦA KHÁCH NÀY!',
              recordId: null
            });
            showBanner('ok', '✅ Tự động nhận diện Khách hàng: "' + autoCustCode + '" — Giờ hãy chụp các sản phẩm cho khách này!');
            return;
          }
        }

        if (hit && hit.code) {
          if (!parsed.ok) {
            playBeep('error');
            updateSnapPopCardUI({
              stateClass: 'state-err',
              thumbSrc: finalThumb,
              badge: '❌ MÃ VẠCH KHÔNG HỢP LỆ — KHÔNG GHI NHẬN',
              title: parsed.error,
              dates: 'Chỉ nhận mã vạch sọc 13 số của tem cân hàng!',
              recordId: null
            });
            showBanner('error', parsed.error);
            return;
          }

          // Chế độ Siêu Tốc v25: Bỏ hoàn toàn OCR đọc NSX/HSD — ghi nhận ngay Mã hàng, Tên hàng, Số ký, Tên khách trong <50ms!
          const dates = { nsx: '', hsd: '' };

          // Nếu người dùng tự bật hỏi trùng trong Cài Đặt (mặc định TẮT để bỏ qua mọi nút xác nhận)
          if (
            settings.duplicateAskSec > 0 &&
            parsed.rawBarcode === lastScannedCode &&
            (Date.now() - lastScannedEpoch) < settings.duplicateAskSec * 1000
          ) {
            playBeep('warn');
            pendingDuplicateCode = parsed.rawBarcode;
            pendingDuplicateDates = dates;
            pendingDuplicateDateCtx = null;
            document.getElementById('dupModalBarcode').textContent = parsed.rawBarcode;
            document.getElementById('dupModalInfo').textContent =
              (parsed.productName || 'Chưa có tên') + ' (' + parsed.productCode + ') — ' + formatKg(parsed.grams) + ' Kg';
            openModal('duplicateModal');
            return;
          }

          const committed = commitBatchPhotoScan(parsed, dates, '');
          if (committed.ok && committed.record) {
            const r = committed.record;
            // Ghi nhận xong -> tự động trả Ô 1 (Tên khách) về khoảng trắng!
            if (activeCustomerBarcode) {
              setActiveCustomerBarcode('', true);
            }
            renderAll(true);
            flushSyncQueue(false);
            playBeep('ok');
            if (pendingSnapJobsCount <= 1) {
              vibrateDevice([35]);
            }
            const custLabel = r.customerBarcode ? ('👤 Khách: ' + r.customerBarcode) : '👤 Khách: —';
            updateSnapPopCardUI({
              stateClass: 'state-ok',
              thumbSrc: finalThumb,
              badge: '✅ ĐÃ GHI NHẬN',
              title: (r.productName || ('Mã ' + r.productCode)) + ' (' + r.productCode + ') — ' + formatKg(r.grams) + ' Kg',
              dates: custLabel,
              recordId: r.id,
              showRescue: false
            });
            showBanner(
              'ok',
              '✅ ' + (r.customerBarcode ? ('[' + r.customerBarcode + '] ') : '') +
              (r.productName || ('Mã ' + r.productCode)) + ' (' + r.productCode + ') — ' +
              formatKg(r.grams) + ' Kg'
            );
          } else {
            playBeep('error');
            updateSnapPopCardUI({
              stateClass: 'state-err',
              thumbSrc: finalThumb,
              badge: '❌ LỖI KCS NỘI BỘ',
              title: committed.error || 'Không thể lưu dòng này',
              dates: 'Vui lòng chụp lại!',
              recordId: null
            });
          }
          return;
        }

        // Trường hợp D: Ảnh mờ / ngoài mặt tem -> Báo đỏ rõ ràng theo chuẩn Fail-Closed (tuyệt đối không tự đoán số liệu!)
        playBeep('error');
        updateSnapPopCardUI({
          stateClass: 'state-err',
          thumbSrc: finalThumb,
          badge: '❌ CHƯA RÕ MÃ VẠCH 13 SỐ — CHƯA GHI NHẬN',
          title: 'Ảnh vừa chụp chưa thấy rõ dải mã vạch 13 số',
          dates: 'Chạm vào mặt tem cho nét rồi bấm nút tròn Chụp lại!',
          recordId: null
        });
      } catch (err) {
        playBeep('error');
        updateSnapPopCardUI({
          stateClass: 'state-err',
          thumbSrc: finalThumb,
          badge: '❌ KHÔNG ĐỌC ĐƯỢC ẢNH VỪA CHỤP',
          title: 'Vui lòng bấm nút tròn chụp lại!',
          dates: '',
          recordId: null
        });
      } finally {
        if (workCanvas) {
          workCanvas.width = 0;
          workCanvas.height = 0;
        }
        pendingSnapJobsCount = Math.max(0, pendingSnapJobsCount - 1);
        if (pendingSnapJobsCount === 0) {
          setShutterUIState('ready');
          setTimeout(checkPendingSwReload, 150);
        }
      }
    });
  }

  function captureVideoToCanvas(video, targetCanvas, maxDimLimit) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const maxDim = maxDimLimit || 2400;
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

  // ==================== TỰ ĐỘNG QUÉT LIÊN TỤC KÊU BÍP (KHÔNG CẦN BẤM CHỤP) ====================
  let autoLiveScanTimer = null;
  let autoLiveScanBusy = false;
  let autoScanCooldownUntil = 0;
  let lastAutoBarcode = '';
  let lastAutoBarcodeAt = 0;
  let autoScanCanvas = null;

  function unlockAudioForAutoBeep() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!audioCtx) audioCtx = new Ctx();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) {}
  }

  function stopAutoLiveScanLoop() {
    if (autoLiveScanTimer) {
      clearInterval(autoLiveScanTimer);
      autoLiveScanTimer = null;
    }
    autoLiveScanBusy = false;
  }

  function startAutoLiveScanLoop() {
    stopAutoLiveScanLoop();
    autoLiveScanTimer = setInterval(async function () {
      if (!cameraActive || autoLiveScanBusy || pendingSnapJobsCount > 0) return;
      const now = Date.now();
      if (now < autoScanCooldownUntil) return;

      const video = document.getElementById('cameraVideo');
      if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;

      autoLiveScanBusy = true;
      try {
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        const scale = Math.min(1, 960 / Math.max(vw, vh));
        const cw = Math.max(160, Math.round(vw * scale));
        const ch = Math.max(120, Math.round(vh * scale));
        if (!autoScanCanvas) autoScanCanvas = document.createElement('canvas');
        if (autoScanCanvas.width !== cw || autoScanCanvas.height !== ch) {
          autoScanCanvas.width = cw;
          autoScanCanvas.height = ch;
        }
        const ctx = autoScanCanvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(video, 0, 0, cw, ch);

        if (customerScanArmed) {
          // Bước 1: Tự động quét mã Tên khách -> kêu Bíp -> ghi vào Ô 1 -> tự nhảy sang Ô 2!
          const custHit = await decodeCustomer1DBarcode(null, autoScanCanvas);
          const custCode = custHit ? cleanCustomerBarcode(custHit.code) : '';
          if (custCode && !(custCode === lastAutoBarcode && (Date.now() - lastAutoBarcodeAt) < 2200)) {
            lastAutoBarcode = custCode;
            lastAutoBarcodeAt = Date.now();
            autoScanCooldownUntil = Date.now() + 1100;
            triggerShutterFlashEffect();
            setActiveCustomerBarcode(custCode, true);
            playBeep('ok');
            vibrateDevice([40]);
            const thumb = createThumbnailDataUrl(autoScanCanvas, 160);
            updateSnapPopCardUI({
              stateClass: 'state-ok',
              thumbSrc: thumb,
              badge: '✅ ĐÃ QUÉT TÊN KHÁCH',
              title: custCode,
              dates: 'Đã nhảy sang Ô 2 — Đưa tem sản phẩm vào quét!',
              recordId: null,
              showRescue: false
            });
          }
        } else {
          // Bước 2: Tự động quét mã tem Sản phẩm -> kêu Bíp -> ghi Mã, Tên, Số ký -> trả Ô 1 về khoảng trắng!
          const hit = await decodePhotoInBrowserWasm(null, autoScanCanvas);
          const parsed = (hit && hit.code) ? parseSingle13DigitScaleBarcode(hit.code) : null;
          if (parsed && parsed.ok) {
            if (parsed.rawBarcode === lastAutoBarcode && (Date.now() - lastAutoBarcodeAt) < 2200) {
              return;
            }
            lastAutoBarcode = parsed.rawBarcode;
            lastAutoBarcodeAt = Date.now();
            autoScanCooldownUntil = Date.now() + 1200;

            triggerShutterFlashEffect();
            const committed = commitBatchPhotoScan(parsed, { nsx: '', hsd: '' }, '');
            if (committed.ok && committed.record) {
              const r = committed.record;
              const dupCheck = getDuplicateCodeWeightInfo(r);
              if (dupCheck.isDup && (!r.note || r.note.indexOf('TRÙNG') === -1)) {
                r.note = dupCheck.isSameCustDup
                  ? ('⚠️ TRÙNG KHÁCH + MÃ + SỐ KÝ (x' + dupCheck.count + ')')
                  : ('⚠️ TRÙNG MÃ + SỐ KÝ (x' + dupCheck.count + ')');
                persistRecords();
                enqueueOp({ type: 'update', record: toSyncRecord(r) });
              }
              // Ghi nhận xong -> giữ tích xanh 650ms cho dễ nhìn rồi tự động trả Ô 1 (Tên khách) về khoảng trắng!
              if (activeCustomerBarcode) {
                setTimeout(function () { setActiveCustomerBarcode('', true); }, 650);
              }
              renderAll(true);
              flushSyncQueue(false);
              if (dupCheck.isDup) {
                playBeep('warn');
                setTimeout(function () { playBeep('warn'); }, 220);
                vibrateDevice([120, 60, 120]);
              } else {
                playBeep('ok');
                vibrateDevice([40]);
              }
              const thumb = createThumbnailDataUrl(autoScanCanvas, 160);
              const custLabel = r.customerBarcode ? ('Khách: ' + r.customerBarcode) : 'Khách: —';
              updateSnapPopCardUI({
                stateClass: dupCheck.isDup ? 'state-err' : 'state-ok',
                thumbSrc: thumb,
                badge: dupCheck.isDup ? ('⚠️ CẢNH BÁO TRÙNG MÃ + SỐ KÝ (x' + dupCheck.count + ')') : '✅ ĐÃ GHI NHẬN',
                title: (r.productName || ('Mã ' + r.productCode)) + ' (' + r.productCode + ') — ' + formatKg(r.grams) + ' Kg',
                dates: custLabel,
                recordId: r.id,
                showRescue: false
              });
            }
          }
        }
      } catch (e) {
      } finally {
        autoLiveScanBusy = false;
      }
    }, 150);
  }

  function stopCamera1DScanner() {
    stopAutoLiveScanLoop();
    cameraActive = false;
    singleScanActive = false;
    imageCaptureDevice = null;
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

  function commitBatchPhotoScan(parsed, datesObj, fileName) {
    const now = new Date();
    const pdaLot = getActivePdaLotDates();
    const nsxClean = normalizeDateVN((datesObj && datesObj.nsx) ? datesObj.nsx : pdaLot.nsx);
    const hsdClean = normalizeDateVN((datesObj && datesObj.hsd) ? datesObj.hsd : pdaLot.hsd);

    const record = {
      id: 'scan_' + now.getTime() + '_' + Math.random().toString(36).slice(2, 7),
      scannedAt: formatDateTimeVN(now),
      customerBarcode: cleanCustomerBarcode(activeCustomerBarcode),
      productCode: parsed.productCode,
      productName: parsed.productName,
      grams: parsed.grams,
      nsx: nsxClean,
      hsd: hsdClean,
      rawBarcode: parsed.rawBarcode,
      note: '',
      edited: false
    };

    records.push(record);
    lastScannedCode = parsed.rawBarcode;
    lastScannedEpoch = Date.now();

    const kcs = verifyKcsIntegrity();
    if (!kcs.ok) {
      records.pop();
      return { ok: false, error: kcs.error };
    }

    persistRecords();
    enqueueOp({ type: 'add', record: toSyncRecord(record) });
    return { ok: true, record: record };
  }

  async function processBatchImageFiles(rawFiles) {
    if (!rawFiles || rawFiles.length === 0) return;
    if (batchProcessingActive) {
      showBanner('warn', '⏳ Đang xử lý dở lô ảnh hiện tại — Vui lòng đợi chạy xong rồi chọn tiếp!');
      return;
    }

    // Lọc bỏ trường hợp bấm nhầm chọn trùng 2 lần cùng 1 tệp ảnh trong cùng 1 lần tải lên
    const uniqueFiles = [];
    const seenFileSig = {};
    for (let i = 0; i < rawFiles.length; i++) {
      const f = rawFiles[i];
      if (!f) continue;
      const sig = String(f.name || '') + '|' + String(f.size || 0) + '|' + String(f.lastModified || 0);
      if (rawFiles.length > 1 && seenFileSig[sig]) continue;
      seenFileSig[sig] = true;
      uniqueFiles.push(f);
    }
    if (uniqueFiles.length === 0) return;

    batchProcessingActive = true;
    batchCancelRequested = false;

    const progBox = document.getElementById('batchProgressBox');
    const progTxt = document.getElementById('batchProgressText');
    const progFill = document.getElementById('batchProgressBarFill');
    const btnCancel = document.getElementById('btnCancelBatch');
    const elTotal = document.getElementById('batchStatTotal');
    const elFullOk = document.getElementById('batchStatFullOk');
    const elCodeOnly = document.getElementById('batchStatCodeOnly');
    const elFail = document.getElementById('batchStatFail');
    const listEl = document.getElementById('batchResultList');

    if (progBox) progBox.style.display = 'block';
    if (btnCancel) btnCancel.style.display = uniqueFiles.length > 1 ? 'inline-flex' : 'none';
    if (listEl) listEl.innerHTML = '';

    const total = uniqueFiles.length;
    let fullOkCount = 0;
    let codeOnlyCount = 0;
    let failCount = 0;
    let customerAssignedCount = 0;

    const updateScoreboard = function (doneCount, statusLine) {
      if (elTotal) elTotal.textContent = String(total);
      if (elFullOk) elFullOk.textContent = String(fullOkCount);
      if (elCodeOnly) elCodeOnly.textContent = String(codeOnlyCount);
      if (elFail) elFail.textContent = String(failCount);
      const pct = Math.min(100, Math.round((doneCount / Math.max(1, total)) * 100));
      if (progFill) progFill.style.width = pct + '%';
      if (progTxt && statusLine) progTxt.textContent = statusLine;
    };

    const appendRowReport = function (cls, titleHtml, subHtml, editRecordId) {
      if (!listEl) return;
      const item = document.createElement('div');
      item.className = 'batch-result-item ' + cls;
      item.innerHTML = (
        '<div style="min-width:0;flex:1;">' +
          '<div style="font-weight:800;color:#0f172a;word-break:break-word;">' + titleHtml + '</div>' +
          '<div style="font-size:11.5px;color:#475569;margin-top:2px;">' + subHtml + '</div>' +
        '</div>' +
        (editRecordId
          ? ('<button type="button" class="icon-btn" style="flex-shrink:0;font-weight:800;" onclick="window.AppActions.edit(\'' + escapeHtml(editRecordId) + '\')">✏️ Sửa</button>')
          : '')
      );
      listEl.appendChild(item);
    };

    updateScoreboard(0, '⚡ Đang khởi động bộ đọc siêu nét cho ' + total + ' ảnh...');

    try {
      await warmUpWasmEngine();
      await ensureNativeBarcodeDetector();
      await warmUpOcrWorker();

      for (let i = 0; i < total; i++) {
        if (batchCancelRequested) break;
        const file = uniqueFiles[i];
        const shortName = String(file.name || ('Ảnh #' + (i + 1)));
        updateScoreboard(i, '⚡ Đang đọc tấm ' + (i + 1) + ' / ' + total + ': ' + shortName);
        await new Promise(function (r) { setTimeout(r, 15); });

        let cleanCanvas = null;
        try {
          const cleanPack = await loadCleanCanvasFromFile(file, 2400);
          cleanCanvas = cleanPack.canvas;

          if (customerScanArmed && i === 0) {
            let custHit = await decodeCustomer1DBarcode(file, cleanCanvas);
            if (!custHit && navigator.onLine && location.protocol.startsWith('http') && (location.port === '8088' || location.port === '8443')) {
              const srvCust = await decodePhotoViaLocalCppServer(file);
              if (srvCust) custHit = { code: srvCust };
            }
            const cleanCust = custHit ? cleanCustomerBarcode(custHit.code) : '';
            if (cleanCust) {
              setActiveCustomerBarcode(cleanCust, true);
              customerAssignedCount += 1;
              appendRowReport(
                'ok',
                '✅ Đã gán Barcode khách hàng: ' + escapeHtml(cleanCust),
                'Tất cả tem sản phẩm tiếp theo sẽ tự động gắn mã KH "' + escapeHtml(cleanCust) + '"',
                null
              );
              updateSnapPopCardUI({
                stateClass: 'state-ok',
                thumbSrc: createThumbnailDataUrl(cleanCanvas, 200),
                badge: '✅ ĐÃ GÁN BARCODE KHÁCH HÀNG — CHỤP SP NGAY!',
                title: '👤 Khách hàng: ' + cleanCust,
                dates: 'Các tem sản phẩm chụp tiếp theo sẽ tự gắn mã KH này',
                recordId: null
              });
              continue;
            } else {
              failCount += 1;
              appendRowReport(
                'err',
                '❌ #' + (i + 1) + ' (' + escapeHtml(shortName) + ') — Chưa đọc rõ Barcode khách hàng',
                'Hãy chụp rõ mã vạch khách hàng hoặc bấm "⏭️ Bỏ qua" để quét sản phẩm luôn!',
                null
              );
              continue;
            }
          }

          let hit = await decodePhotoInBrowserWasm(file, cleanCanvas);
          if (!hit && navigator.onLine && location.protocol.startsWith('http') && (location.port === '8088' || location.port === '8443')) {
            const srvCode = await decodePhotoViaLocalCppServer(file);
            if (srvCode) hit = { code: srvCode, position: null };
          }

          if (hit && hit.code) {
            const parsed = parseSingle13DigitScaleBarcode(hit.code);
            if (!parsed.ok) {
              failCount += 1;
              appendRowReport(
                'err',
                '❌ #' + (i + 1) + ' (' + escapeHtml(shortName) + ')',
                escapeHtml(parsed.error),
                null
              );
            } else {
              // Ảnh chụp từ Máy ảnh gốc ĐT rất sắc nét -> đảm bảo luôn có tọa độ mã vạch chính xác để đọc trọn cả NSX & HSD trước khi ghi dòng!
              let posUse = hit.position || null;
              if (!posUse) {
                const det = await detectBarcodeCodeAndPosOnCanvas(cleanCanvas);
                if (det && det.pos) posUse = det.pos;
              }
              const dates = await extractNsxHsdWithTimeout(
                cleanCanvas,
                posUse,
                5200,
                true,
                posUse ? null : cropCenterAimFromCanvas(cleanCanvas)
              );
              const committed = commitBatchPhotoScan(parsed, dates, shortName);
              if (committed.ok && committed.record) {
                const r = committed.record;
                const hasBothDates = Boolean(r.nsx && r.hsd);
                if (hasBothDates) {
                  fullOkCount += 1;
                } else {
                  codeOnlyCount += 1;
                }
                appendRowReport(
                  hasBothDates ? 'ok' : 'warn',
                  (hasBothDates ? '✅ ' : '⚠️ ') + '#' + (i + 1) + ': ' +
                    escapeHtml(r.productName || ('Mã ' + r.productCode)) + ' (' + escapeHtml(r.productCode) + ') — ' +
                    '<span style="color:#15803d;">' + formatKg(r.grams) + ' Kg</span>',
                  'NSX: <strong>' + escapeHtml(formatLotDateDisplay(r.nsx)) + '</strong> • HSD: <strong>' +
                    escapeHtml(formatLotDateDisplay(r.hsd)) + '</strong> · Tệp: ' + escapeHtml(shortName),
                  r.id
                );
                updateSnapPopCardUI({
                  stateClass: hasBothDates ? 'state-ok' : 'state-warn',
                  thumbSrc: createThumbnailDataUrl(cleanCanvas, 200),
                  badge: hasBothDates ? ('✅ ĐÃ GHI NHẬN TỰ ĐỘNG (' + (i + 1) + '/' + total + ')!') : ('⚠️ ĐÃ GHI NHẬN MÃ & KÝ (' + (i + 1) + '/' + total + ')'),
                  title: (r.productName || ('Mã ' + r.productCode)) + ' (' + r.productCode + ') — ' + formatKg(r.grams) + ' Kg',
                  dates: 'NSX: ' + formatLotDateDisplay(r.nsx) + ' • HSD: ' + formatLotDateDisplay(r.hsd),
                  recordId: r.id,
                  showRescue: !hasBothDates
                });
                renderAll(true);
                if ((fullOkCount + codeOnlyCount) % 6 === 0) {
                  flushSyncQueue(false);
                }
              } else {
                failCount += 1;
                appendRowReport('err', '❌ #' + (i + 1) + ' (' + escapeHtml(shortName) + ')', 'Lỗi KCS đối soát nội bộ', null);
              }
            }
          } else if (total === 1 && records.length > 0) {
            // Nếu chỉ tải lẻ 1 ảnh cận cảnh chụp riêng dòng NSX/HSD -> tự cập nhật vào tem vừa quét gần nhất
            const onlyDates = await extractNsxHsdWithTimeout(cleanCanvas, null, 3000, true, cropCenterAimFromCanvas(cleanCanvas));
            if (onlyDates.nsx || onlyDates.hsd) {
              const latest = records[records.length - 1];
              if (onlyDates.nsx) latest.nsx = onlyDates.nsx;
              if (onlyDates.hsd) latest.hsd = onlyDates.hsd;
              persistRecords();
              enqueueOp({ type: 'update', record: toSyncRecord(latest) });
              renderAll(true);
              fullOkCount += 1;
              appendRowReport(
                'ok',
                '✅ Đã bổ sung NSX/HSD vào tem vừa quét: ' + escapeHtml(latest.productName || latest.productCode),
                'NSX: <strong>' + escapeHtml(formatLotDateDisplay(latest.nsx)) + '</strong> • HSD: <strong>' + escapeHtml(formatLotDateDisplay(latest.hsd)) + '</strong>',
                latest.id
              );
            } else {
              failCount += 1;
              appendRowReport(
                'err',
                '❌ #' + (i + 1) + ' (' + escapeHtml(shortName) + ')',
                'Không thấy rõ dải mã vạch 13 số trong ảnh (Không tự đoán số liệu)',
                null
              );
            }
          } else {
            // Chế độ Lô nhiều ảnh: Nguyên tắc Fail-Closed nghiêm ngặt — ảnh nào không đọc được mã 13 số thì báo rõ ảnh đó, tuyệt đối KHÔNG tự ghép ngày sang túi khác!
            failCount += 1;
            appendRowReport(
              'err',
              '❌ #' + (i + 1) + ' (' + escapeHtml(shortName) + ') — Chưa đọc được mã vạch 13 số',
              'Hãy chụp rõ dải sọc 13 số của túi này hoặc bấm "➕ Nhập điều chỉnh"',
              null
            );
          }
        } catch (imgErr) {
          failCount += 1;
          appendRowReport(
            'err',
            '❌ #' + (i + 1) + ' (' + escapeHtml(shortName) + ')',
            'Không mở được tệp hình ảnh này',
            null
          );
        } finally {
          if (cleanCanvas) {
            cleanCanvas.width = 0;
            cleanCanvas.height = 0;
          }
        }
      }
    } finally {
      batchProcessingActive = false;
      if (btnCancel) btnCancel.style.display = 'none';
      const doneTotal = fullOkCount + codeOnlyCount + failCount + customerAssignedCount;
      const summaryLine = (batchCancelRequested ? '⏹️ Đã dừng theo yêu cầu: ' : '✅ Đã xử lý xong ' + doneTotal + '/' + total + ' ảnh: ') +
        (customerAssignedCount > 0 && (fullOkCount + codeOnlyCount) === 0
          ? ('Đã gán Barcode khách hàng "' + activeCustomerBarcode + '" — Giờ hãy chụp các tem sản phẩm!')
          : ('Ghi nhận ' + (fullOkCount + codeOnlyCount) + ' tem (' + fullOkCount + ' đủ Mã+Ngày' +
             (codeOnlyCount > 0 ? ', ' + codeOnlyCount + ' thiếu Ngày' : '') +
             (customerAssignedCount > 0 ? ', 1 ảnh mã KH' : '') +
             (failCount > 0 ? ', ' + failCount + ' ảnh chưa rõ mã' : '') + ')!'));
      updateScoreboard(total, summaryLine);

      renderAll(true);
      flushSyncQueue(false);
      setTimeout(checkPendingSwReload, 200);

      if ((fullOkCount + codeOnlyCount + customerAssignedCount) > 0) {
        playBeep('ok');
        vibrateDevice([45, 35, 65]);
        showBanner('ok', summaryLine);
      } else {
        playBeep('error');
        showBanner('error', summaryLine);
      }
      batchCancelRequested = false;
    }
  }

  function handleSelectedImageFiles(fileList) {
    if (!fileList || fileList.length === 0) return;
    const arr = Array.prototype.slice.call(fileList);
    processBatchImageFiles(arr);
  }

  function rescueDatesForRecord(recordId) {
    const rec = recordId
      ? records.find(function (r) { return r.id === recordId; })
      : (records.length > 0 ? records[records.length - 1] : null);
    if (!rec) return;

    if (cameraActive && mediaStream) {
      rescueTargetRecordId = rec.id;
      setShutterUIState('ready');
      const camCard = document.getElementById('cameraBoxCard');
      if (camCard && camCard.scrollIntoView) {
        camCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      showBanner('warn', '🎯 Đưa rõ góc chữ NSX / HSD của "' + (rec.productName || rec.productCode) + '" vào khung rồi bấm nút tròn 📸 CHỤP!');
      return;
    }

    dateOnlyTarget = 'record';
    dateOnlyTargetRecordId = rec.id;
    document.getElementById('hiddenDateOnlyImageInput').click();
  }

  async function decodeDateOnlyImageFile(file) {
    if (!file) return;
    showBanner('warn', '⚡ Đang đọc tự động NSX & HSD từ ảnh tem...');
    try {
      await ensureNativeBarcodeDetector();
      const cleanPack = await loadCleanCanvasFromFile(file, 2400);
      const hitPos = await detectBarcodePositionOnCanvas(cleanPack.canvas);
      const dates = await extractNsxHsdWithTimeout(
        cleanPack.canvas,
        hitPos,
        4500,
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
      } else if (records.length > 0) {
        const targetRec = (dateOnlyTarget === 'record' && dateOnlyTargetRecordId)
          ? (records.find(function (r) { return r.id === dateOnlyTargetRecordId; }) || records[records.length - 1])
          : records[records.length - 1];
        if (dates.nsx) targetRec.nsx = dates.nsx;
        if (dates.hsd) targetRec.hsd = dates.hsd;
        persistRecords();
        enqueueOp({ type: 'update', record: toSyncRecord(targetRec) });
        renderAll(true);
        flushSyncQueue(false);
        updateSnapPopCardUI({
          stateClass: (targetRec.nsx && targetRec.hsd) ? 'state-ok' : 'state-warn',
          thumbSrc: createThumbnailDataUrl(cleanPack.canvas, 200),
          badge: '✅ ĐÃ CẬP NHẬT NSX / HSD & LƯU TỰ ĐỘNG!',
          title: (targetRec.productName || ('Mã ' + targetRec.productCode)) + ' — ' + formatKg(targetRec.grams) + ' Kg',
          dates: 'NSX: ' + formatLotDateDisplay(targetRec.nsx) + ' • HSD: ' + formatLotDateDisplay(targetRec.hsd),
          recordId: targetRec.id,
          showRescue: !(targetRec.nsx && targetRec.hsd)
        });
        showBanner('ok', '✅ Đã cập nhật NSX ' + formatLotDateDisplay(targetRec.nsx) + ' • HSD ' + formatLotDateDisplay(targetRec.hsd) + ' & đẩy lên Sheet!');
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
      const bmp = file ? await loadImageSourceForCanvas(file) : preloadedCleanCanvas;
      if (!bmp) return null;
      const drawSource = bmp._el || bmp;
      const bw = bmp.width;
      const bh = bmp.height;
      const outW = preloadedCleanCanvas ? preloadedCleanCanvas.width : bw;
      const outH = preloadedCleanCanvas ? preloadedCleanCanvas.height : bh;

      const workCanvas = document.createElement('canvas');
      const workCtx = workCanvas.getContext('2d', { willReadFrequently: true });

      // 15 lượt quét độ phân giải gốc 2050px cho ảnh chụp điện thoại 12MP/48MP (ưu tiên mặt phẳng + nghiêng ±14° toàn khung ngay lượt đầu để chốt mã dưới 0.20s!)
      const passes = [
        { cw: 1.0, ch: 1.0, ox: 0, oy: 0, deg: 0, maxDim: 2050, pad: 22, sharp: false, nat: true },
        { cw: 1.0, ch: 1.0, ox: 0, oy: 0, deg: 0, maxDim: 2050, pad: 26, sharp: true, nat: false },
        { cw: 0.54, ch: 0.54, ox: 0, oy: 0, deg: 0, maxDim: 1950, pad: 24, sharp: true, nat: true },
        { cw: 0.96, ch: 0.96, ox: 0, oy: 0, deg: -14, maxDim: 1850, pad: 24, sharp: true, nat: false },
        { cw: 0.96, ch: 0.96, ox: 0, oy: 0, deg: 14, maxDim: 1850, pad: 24, sharp: true, nat: false },
        { cw: 0.56, ch: 0.56, ox: 0, oy: 0, deg: -11, maxDim: 1850, pad: 24, sharp: true, nat: false },
        { cw: 0.56, ch: 0.56, ox: 0, oy: 0, deg: 11, maxDim: 1850, pad: 24, sharp: true, nat: false },
        { cw: 0.34, ch: 0.34, ox: 0, oy: 0, deg: 0, maxDim: 1800, pad: 24, sharp: true, nat: false },
        { cw: 0.74, ch: 0.52, ox: 0, oy: -0.16, deg: 0, maxDim: 1850, pad: 24, sharp: true, nat: false },
        { cw: 0.74, ch: 0.52, ox: 0, oy: 0.16, deg: 0, maxDim: 1850, pad: 24, sharp: true, nat: false },
        { cw: 0.96, ch: 0.96, ox: 0, oy: 0, deg: -24, maxDim: 1850, pad: 24, sharp: true, nat: false },
        { cw: 0.96, ch: 0.96, ox: 0, oy: 0, deg: 24, maxDim: 1850, pad: 24, sharp: true, nat: false },
        { cw: 0.96, ch: 0.96, ox: 0, oy: 0, deg: -35, maxDim: 1850, pad: 24, sharp: true, nat: false },
        { cw: 0.96, ch: 0.96, ox: 0, oy: 0, deg: 35, maxDim: 1850, pad: 24, sharp: true, nat: false },
        { cw: 0.98, ch: 0.98, ox: 0, oy: 0, deg: 90, maxDim: 1850, pad: 24, sharp: true, nat: false }
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

    if (file && window.ZXingWASM && window.ZXingWASM.readBarcodes) {
      try {
        const direct = await window.ZXingWASM.readBarcodes(file, WASM_1D_LOCAL_OPTIONS);
        if (direct && direct.length > 0 && direct[0].text) {
          return { code: direct[0].text, position: null };
        }
      } catch (e) {}
    }

    return null;
  }

  // Giải mã mọi chuẩn mã vạch sọc 1D cho trường tùy chọn Barcode khách hàng (Code128, Code39, Code93, Codabar, EAN-13, EAN-8, ITF, UPC-A — khóa cứng 100% mã vuông 2D)
  async function decodeCustomer1DBarcode(file, preloadedCleanCanvas) {
    try {
      const bmp = file ? await loadImageSourceForCanvas(file) : preloadedCleanCanvas;
      if (!bmp) return null;
      const drawSource = bmp._el || bmp;
      const bw = bmp.width;
      const bh = bmp.height;

      const workCanvas = document.createElement('canvas');
      const workCtx = workCanvas.getContext('2d', { willReadFrequently: true });
      const custPasses = [
        { cw: 1.0, ch: 1.0, deg: 0, maxDim: 2050, pad: 24, sharp: false, nat: true },
        { cw: 1.0, ch: 1.0, deg: 0, maxDim: 2050, pad: 26, sharp: true, nat: false },
        { cw: 0.65, ch: 0.55, deg: 0, maxDim: 1900, pad: 24, sharp: true, nat: true },
        { cw: 0.96, ch: 0.96, deg: -14, maxDim: 1850, pad: 24, sharp: true, nat: false },
        { cw: 0.96, ch: 0.96, deg: 14, maxDim: 1850, pad: 24, sharp: true, nat: false },
        { cw: 0.96, ch: 0.96, deg: -28, maxDim: 1850, pad: 24, sharp: true, nat: false },
        { cw: 0.96, ch: 0.96, deg: 28, maxDim: 1850, pad: 24, sharp: true, nat: false },
        { cw: 0.98, ch: 0.98, deg: 90, maxDim: 1850, pad: 24, sharp: true, nat: false }
      ];

      for (let i = 0; i < custPasses.length; i++) {
        const p = custPasses[i];
        const sw = Math.max(120, Math.round(bw * p.cw));
        const sh = Math.max(90, Math.round(bh * p.ch));
        const sx = Math.max(0, Math.round((bw - sw) / 2));
        const sy = Math.max(0, Math.round((bh - sh) / 2));

        const maxSide = Math.max(1, Math.max(sw, sh));
        const minSide = Math.max(1, Math.min(sw, sh));
        const ratio = (p.sharp && minSide < 820)
          ? Math.min(2.0, 1080 / minSide)
          : Math.min(1, p.maxDim / maxSide);
        const dw = Math.max(180, Math.round(sw * ratio));
        const dh = Math.max(110, Math.round(sh * ratio));
        const pad = p.pad || 24;
        const tw = dw + pad * 2;
        const th = dh + pad * 2;

        workCanvas.width = tw;
        workCanvas.height = th;
        workCtx.fillStyle = '#ffffff';
        workCtx.fillRect(0, 0, tw, th);
        workCtx.save();
        workCtx.translate(tw / 2, th / 2);
        if (p.deg !== 0) workCtx.rotate((p.deg * Math.PI) / 180);
        if (p.deStreak) {
          workCtx.filter = 'blur(1.25px) contrast(2.3)';
        }
        workCtx.drawImage(drawSource, sx, sy, sw, sh, -dw / 2, -dh / 2, dw, dh);
        workCtx.restore();
        workCtx.filter = 'none';

        if (p.nat && p.deg === 0) {
          const natDet = await ensureNativeCustomerDetector();
          if (natDet) {
            try {
              const natHits = await natDet.detect(workCanvas);
              if (natHits && natHits.length > 0) {
                for (let k = 0; k < natHits.length; k++) {
                  const rawV = cleanCustomerBarcode(natHits[k].rawValue);
                  if (rawV) {
                    if (bmp.close) bmp.close();
                    return { code: rawV };
                  }
                }
              }
            } catch (e) {}
          }
        }

        const imgData = workCtx.getImageData(0, 0, tw, th);
        if (p.sharp) {
          sharpen1DBarsInPlace(imgData);
        }

        if (window.ZXingWASM && window.ZXingWASM.readBarcodesFromImageData) {
          let wasmHits = null;
          try {
            wasmHits = await window.ZXingWASM.readBarcodesFromImageData(imgData, WASM_CUSTOMER_1D_OPTIONS);
          } catch (eOpts) {
            try {
              wasmHits = await window.ZXingWASM.readBarcodesFromImageData(imgData, WASM_1D_LOCAL_OPTIONS);
            } catch (e2) {}
          }
          if (wasmHits && wasmHits.length > 0) {
            for (let k = 0; k < wasmHits.length; k++) {
              const txt = cleanCustomerBarcode(wasmHits[k].text);
              if (txt) {
                if (bmp.close) bmp.close();
                return { code: txt };
              }
            }
          }
        }

        const jsEanHit = decodeEan13PureJsFromImageData(imgData);
        if (jsEanHit && jsEanHit.code) {
          if (bmp.close) bmp.close();
          return { code: jsEanHit.code };
        }
      }

      // Lượt dự phòng chuyên trị QR tem in nhiệt bị xước sọc trắng ngang (nối liền vết xước bằng blur + tăng tương phản)
      if (window.ZXingWASM && window.ZXingWASM.readBarcodesFromImageData) {
        const deStreakCrops = [
          { sx: 0, sy: 0, sw: bw, sh: bh },
          { sx: 0, sy: Math.round(bh * 0.08), sw: Math.round(bw * 0.52), sh: Math.round(bh * 0.84) }
        ];
        for (let ds = 0; ds < deStreakCrops.length; ds++) {
          const dc = deStreakCrops[ds];
          const dRatio = Math.min(1.4, 720 / Math.max(1, Math.max(dc.sw, dc.sh)));
          const ddw = Math.max(180, Math.round(dc.sw * dRatio));
          const ddh = Math.max(140, Math.round(dc.sh * dRatio));
          const dpad = 24;
          workCanvas.width = ddw + dpad * 2;
          workCanvas.height = ddh + dpad * 2;
          workCtx.filter = 'none';
          workCtx.fillStyle = '#ffffff';
          workCtx.fillRect(0, 0, workCanvas.width, workCanvas.height);
          workCtx.save();
          workCtx.filter = 'blur(1.25px) contrast(2.3)';
          workCtx.drawImage(drawSource, dc.sx, dc.sy, dc.sw, dc.sh, dpad, dpad, ddw, ddh);
          workCtx.restore();
          workCtx.filter = 'none';
          const dsImg = workCtx.getImageData(0, 0, workCanvas.width, workCanvas.height);
          try {
            const dsHits = await window.ZXingWASM.readBarcodesFromImageData(dsImg, WASM_CUSTOMER_1D_OPTIONS);
            if (dsHits && dsHits.length > 0) {
              for (let k = 0; k < dsHits.length; k++) {
                const txt = cleanCustomerBarcode(dsHits[k].text);
                if (txt) {
                  if (bmp.close) bmp.close();
                  return { code: txt };
                }
              }
            }
          } catch (eDs) {}
        }
      }
      if (bmp.close) bmp.close();
    } catch (e) {}

    if (file && window.ZXingWASM && window.ZXingWASM.readBarcodes) {
      try {
        const direct = await window.ZXingWASM.readBarcodes(file, WASM_CUSTOMER_1D_OPTIONS);
        if (direct && direct.length > 0 && cleanCustomerBarcode(direct[0].text)) {
          return { code: cleanCustomerBarcode(direct[0].text) };
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
      customerBarcode: cleanCustomerBarcode(r.customerBarcode),
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
        cleanCustomerBarcode(r.customerBarcode),
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
      'Barcode khách hàng',
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
      const custClean = cleanCustomerBarcode(r.customerBarcode);
      lines.push([
        r.scannedAt,
        custClean ? '="' + custClean.replace(/"/g, '""') + '"' : '—',
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

    const m = computeMetrics();
    lines.push('');
    lines.push(['I. TỔNG HỢP TỒN THEO MÃ SKU × THEO DATE (NSX / HSD)'].map(csvEscape).join(','));
    lines.push(['STT', 'Mã SKU', 'Tên sản phẩm', 'NSX', 'HSD (Date)', 'Tình trạng hạn dùng', 'Số tem', 'Tổng số ký (Kg)'].map(csvEscape).join(','));
    for (let i = 0; i < m.skuDateGroups.length; i++) {
      const sd = m.skuDateGroups[i];
      lines.push([
        String(i + 1),
        '="' + sd.code + '"',
        sd.name || '—',
        sd.nsx,
        sd.hsd,
        evaluateShelfLifeApp(sd.hsd).text,
        String(sd.count),
        (sd.grams / 1000).toFixed(3)
      ].map(csvEscape).join(','));
    }

    lines.push('');
    lines.push(['II. TỔNG HỢP TỒN GỘP THEO MÃ SKU'].map(csvEscape).join(','));
    lines.push(['STT', 'Mã SKU', 'Tên sản phẩm', 'Số tem', 'Tổng số ký (Kg)'].map(csvEscape).join(','));
    for (let i = 0; i < m.productGroups.length; i++) {
      const pg = m.productGroups[i];
      lines.push([
        String(i + 1),
        '="' + pg.code + '"',
        pg.name || '—',
        String(pg.count),
        (pg.grams / 1000).toFixed(3)
      ].map(csvEscape).join(','));
    }

    lines.push('');
    lines.push(['III. TỔNG HỢP TỒN GỘP THEO DATE (HSD / NSX)'].map(csvEscape).join(','));
    lines.push(['STT', 'HSD (Date)', 'NSX', 'Tình trạng hạn dùng', 'Số tem', 'Tổng số ký (Kg)'].map(csvEscape).join(','));
    for (let i = 0; i < m.dateGroups.length; i++) {
      const dg = m.dateGroups[i];
      lines.push([
        String(i + 1),
        dg.hsd,
        dg.nsx,
        dg.hasDate ? evaluateShelfLifeApp(dg.hsd).text : '—',
        String(dg.count),
        (dg.grams / 1000).toFixed(3)
      ].map(csvEscape).join(','));
    }

    lines.push('');
    lines.push(['IV. TỔNG HỢP TỒN GỘP THEO BARCODE KHÁCH HÀNG'].map(csvEscape).join(','));
    lines.push(['STT', 'Barcode khách hàng', 'Phân loại', 'Số tem', 'Tổng số ký (Kg)'].map(csvEscape).join(','));
    for (let i = 0; i < m.customerGroups.length; i++) {
      const cg = m.customerGroups[i];
      lines.push([
        String(i + 1),
        cg.hasCustomer ? ('="' + cg.customer.replace(/"/g, '""') + '"') : '—',
        cg.hasCustomer ? 'Đã gán mã KH' : '— (Bỏ qua mã KH)',
        String(cg.count),
        (cg.grams / 1000).toFixed(3)
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
  // UI EVENTS (DUY NHẤT CHẾ ĐỘ MÁY ẢNH CHỤP 1 CHẠM — KHÔNG NÚT OK XÁC NHẬN)
  // =========================================================================
  function bindEvents() {
    document.querySelectorAll('.zoom-btn').forEach(function (zBtn) {
      zBtn.addEventListener('click', function () {
        applyZoomLevel(Number(zBtn.dataset.zoom));
      });
    });

    window.addEventListener('keydown', function (e) {
      if (e.code === 'F9' || e.code === 'F10') {
        e.preventDefault();
        onShutterScanClick();
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

    const custInpEl = document.getElementById('customerBarcodeInput');
    if (custInpEl) {
      let lastCustLen = 0;
      let pdaPasteJumpTimer = null;
      custInpEl.addEventListener('input', function (e) {
        const val = String(e.target.value || '');
        const delta = val.length - lastCustLen;
        lastCustLen = val.length;
        setActiveCustomerBarcode(val, false);
        // Nếu máy PDA bắn/dán nguyên chuỗi chữ (kể cả tiếng Việt có dấu như 'DIỆU BÌNH') mà không kèm Enter -> tự nhận & nhảy sang Ô 2!
        if (pdaPasteJumpTimer) clearTimeout(pdaPasteJumpTimer);
        if (delta >= 3 && cleanCustomerBarcode(val)) {
          pdaPasteJumpTimer = setTimeout(function () {
            const clean = cleanCustomerBarcode(custInpEl.value);
            if (clean) {
              setActiveCustomerBarcode(clean, true);
              playBeep('ok');
              const pdaProdInp = document.getElementById('pdaProductInput');
              if (pdaProdInp) pdaProdInp.focus();
            }
          }, 260);
        }
      });
      custInpEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          const clean = cleanCustomerBarcode(custInpEl.value);
          setActiveCustomerBarcode(clean, true);
          playBeep('ok');
          const pdaProdInp = document.getElementById('pdaProductInput');
          if (pdaProdInp) {
            pdaProdInp.focus();
          } else {
            custInpEl.blur();
          }
        }
      });
    }

    // ==================== HỖ TRỢ QUÉT TIA HỒNG NGOẠI MÁY PDA SONG SONG VỚI CAMERA ====================
    function handlePdaBarcodeSubmission(rawCode) {
      const code = String(rawCode || '').replace(/[\r\n\t]+/g, '').trim();
      if (!code) return;
      unlockAudioForAutoBeep();

      const parsed = parseSingle13DigitScaleBarcode(code);
      if (parsed && parsed.ok) {
        const committed = commitBatchPhotoScan(parsed, { nsx: '', hsd: '' }, '');
        if (committed.ok && committed.record) {
          const r = committed.record;
          const dupCheck = getDuplicateCodeWeightInfo(r);
          if (dupCheck.isDup && (!r.note || r.note.indexOf('TRÙNG') === -1)) {
            r.note = dupCheck.isSameCustDup
              ? ('⚠️ TRÙNG KHÁCH + MÃ + SỐ KÝ (x' + dupCheck.count + ')')
              : ('⚠️ TRÙNG MÃ + SỐ KÝ (x' + dupCheck.count + ')');
            persistRecords();
            enqueueOp({ type: 'update', record: toSyncRecord(r) });
          }
          renderAll(true);
          flushSyncQueue(false);
          if (dupCheck.isDup) {
            playBeep('warn');
            setTimeout(function () { playBeep('warn'); }, 220);
            vibrateDevice([120, 60, 120]);
            showBanner('error', '⚠️ CẢNH BÁO TRÙNG MÃ + SỐ KÝ (x' + dupCheck.count + '): ' + (r.productName || ('Mã ' + r.productCode)) + ' — ' + formatKg(r.grams) + ' Kg!');
          } else {
            playBeep('ok');
            vibrateDevice([40]);
            showBanner('ok', '✅ PDA: ' + (r.customerBarcode ? ('[' + r.customerBarcode + '] ') : '') + (r.productName || ('Mã ' + r.productCode)) + ' — ' + formatKg(r.grams) + ' Kg');
          }
          if (activeCustomerBarcode) {
            setTimeout(function () { setActiveCustomerBarcode('', true); }, 650);
          }
        }
      } else {
        // Nếu tia PDA bắn mã không phải tem cân 13 số -> tự nhận là Tên / Mã khách hàng -> điền Ô 1 (xanh ✅) & nhảy sang Ô 2!
        const custClean = cleanCustomerBarcode(code);
        if (custClean) {
          setActiveCustomerBarcode(custClean, true);
          playBeep('ok');
          vibrateDevice([35]);
          const pdaProd = document.getElementById('pdaProductInput');
          if (pdaProd) pdaProd.focus();
        } else {
          playBeep('error');
        }
      }
    }

    const pdaProdInput = document.getElementById('pdaProductInput');
    if (pdaProdInput) {
      pdaProdInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          const val = String(pdaProdInput.value || '').trim();
          pdaProdInput.value = '';
          if (val) handlePdaBarcodeSubmission(val);
        }
      });
    }

    // Bắt tia hồng ngoại PDA toàn màn hình ngay cả khi chưa chạm vào ô nào!
    let globalPdaBuf = '';
    let globalPdaLastTs = 0;
    document.addEventListener('keydown', function (e) {
      const tabScanEl = document.getElementById('tabScan');
      if (!tabScanEl || !tabScanEl.classList.contains('active')) return;
      const ae = document.activeElement;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
      const now = Date.now();
      if (now - globalPdaLastTs > 140) globalPdaBuf = '';
      globalPdaLastTs = now;
      if (e.key === 'Enter') {
        if (globalPdaBuf.length >= 3) {
          e.preventDefault();
          const scanned = globalPdaBuf;
          globalPdaBuf = '';
          handlePdaBarcodeSubmission(scanned);
        } else {
          globalPdaBuf = '';
        }
      } else if (e.key && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        globalPdaBuf += e.key;
      }
    });

    // Nút Lưu / Ghi nhận khi người dùng gõ tay khách hàng (Cách 2)
    const btnSaveCust = document.getElementById('btnSaveCustomerInput');
    if (btnSaveCust) {
      btnSaveCust.addEventListener('click', function () {
        const inpVal = (document.getElementById('customerBarcodeInput') || {}).value || '';
        const clean = cleanCustomerBarcode(inpVal);
        if (clean) {
          setActiveCustomerBarcode(clean, true);
          showBanner('ok', '✅ Đã ghi nhận Khách hàng: "' + clean + '" (Tự nhập tay) — Giờ hãy chụp các tem sản phẩm!');
        } else {
          showBanner('warn', '⚠️ Hãy gõ tên hoặc mã khách vào ô, hoặc bấm "📷 Quét mã KH" / "⏭️ Bỏ qua"!');
        }
      });
    }

    function openCameraDrawer(forCustomer) {
      unlockAudioForAutoBeep();
      const camCard = document.getElementById('cameraBoxCard');
      customerScanArmed = Boolean(forCustomer);
      syncCustomerScanBarUI();
      if (camCard) {
        camCard.style.display = 'block';
      }
      if (!cameraActive) {
        startCamera1DScanner();
      } else {
        startAutoLiveScanLoop();
      }
    }

    function closeCameraDrawer() {
      const camCard = document.getElementById('cameraBoxCard');
      customerScanArmed = false;
      syncCustomerScanBarUI();
      if (camCard) {
        camCard.style.display = 'none';
      }
      stopCamera1DScanner();
    }

    const btnCloseCam = document.getElementById('btnCloseCameraDrawer');
    if (btnCloseCam) {
      btnCloseCam.addEventListener('click', closeCameraDrawer);
    }

    // Nút biểu tượng 📷 ở Ô 1 (Tên khách): Bấm vào -> mở Camera quét Tên khách -> xong tự nhảy sang Ô 2!
    const btnScanCust = document.getElementById('btnScanCustomerBarcode');
    if (btnScanCust) {
      btnScanCust.addEventListener('click', function () {
        const camCard = document.getElementById('cameraBoxCard');
        const camIsOpen = Boolean(camCard && camCard.style.display !== 'none');
        if (camIsOpen && customerScanArmed) {
          const shutter = document.getElementById('btnShutterScan');
          if (shutter) shutter.click();
        } else {
          openCameraDrawer(true);
        }
      });
    }

    // Nút Bỏ qua / Xóa khách hàng (Cách 3)
    const btnSkipCust = document.getElementById('btnClearCustomerBarcode');
    if (btnSkipCust) {
      btnSkipCust.addEventListener('click', function () {
        const hadCust = Boolean(activeCustomerBarcode);
        setActiveCustomerBarcode('', true);
        if (hadCust) {
          showBanner('ok', '✕ Đã xóa Khách hàng (về "—") — Tiếp tục chụp sản phẩm!');
        } else {
          showBanner('ok', '⏭️ Đã chọn BỎ QUA Khách hàng (hiển thị "—") — Chụp thẳng sản phẩm ngay!');
        }
      });
    }

    // Bấm vào chip gợi ý khách đã có để chọn nhanh 1 chạm
    const qpEl = document.getElementById('customerQuickPills');
    if (qpEl) {
      qpEl.addEventListener('click', function (e) {
        const chipBtn = e.target.closest('.cust-pill-chip');
        if (!chipBtn) return;
        const custVal = chipBtn.getAttribute('data-cust');
        if (custVal) {
          setActiveCustomerBarcode(custVal, true);
          showBanner('ok', '✅ Đã chọn Khách hàng: "' + custVal + '" — Giờ hãy chụp các tem sản phẩm!');
        }
      });
    }

    const btnNextCust = document.getElementById('btnNextCustomer');
    if (btnNextCust) {
      btnNextCust.addEventListener('click', function () {
        setActiveCustomerBarcode('', false);
        customerScanArmed = true;
        syncCustomerScanBarUI();
        showBanner('warn', '🎯 BƯỚC 1: Đưa Barcode khách hàng mới vào khung rồi bấm nút tròn CHỤP!');
      });
    }

    const btnToggleCustList = document.getElementById('btnToggleCustProdList');
    if (btnToggleCustList) {
      btnToggleCustList.addEventListener('click', function () {
        customerProdListExpanded = !customerProdListExpanded;
        const content = document.getElementById('custProdListContent');
        if (content) {
          content.classList.toggle('is-open', customerProdListExpanded);
        }
        btnToggleCustList.textContent = customerProdListExpanded ? 'Thu gọn ▲' : 'Xem chi tiết ▼';
      });
    }

    const camVideoEl = document.getElementById('cameraVideo');
    if (camVideoEl) {
      camVideoEl.addEventListener('click', function (ev) {
        if (cameraActive) {
          triggerCameraRefocus(ev);
        }
      });
    }
    const btnSwitchLens = document.getElementById('btnSwitchLens');
    if (btnSwitchLens) {
      btnSwitchLens.addEventListener('click', cycleRearCameraLens);
    }
    const btnPickBatch = document.getElementById('btnPickBatchPhotos');
    if (btnPickBatch) {
      btnPickBatch.addEventListener('click', function () {
        document.getElementById('batchGalleryInput').click();
      });
    }
    const btnCancelBatch = document.getElementById('btnCancelBatch');
    if (btnCancelBatch) {
      btnCancelBatch.addEventListener('click', function () {
        batchCancelRequested = true;
      });
    }

    const batchInp = document.getElementById('batchGalleryInput');
    if (batchInp) {
      batchInp.addEventListener('change', function (e) {
        if (e.target.files && e.target.files.length > 0) {
          handleSelectedImageFiles(e.target.files);
        }
        e.target.value = '';
      });
    }

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
          kpiSec.style.display = (target === 'tabHistory' || target === 'tabSummary') ? 'flex' : 'none';
        }
        if (target !== 'tabScan') {
          closeCameraDrawer();
        }
      });
    });

    const btnQuickScanProd = document.getElementById('btnQuickScanProduct');
    if (btnQuickScanProd) {
      btnQuickScanProd.addEventListener('click', function () {
        const camCard = document.getElementById('cameraBoxCard');
        const camIsOpen = Boolean(camCard && camCard.style.display !== 'none');
        if (camIsOpen && !customerScanArmed) {
          const shutter = document.getElementById('btnShutterScan');
          if (shutter) shutter.click();
        } else {
          openCameraDrawer(false);
        }
      });
    }

    document.getElementById('searchHistoryInput').addEventListener('input', renderScanLists);
    document.getElementById('searchCatalogInput').addEventListener('input', renderCatalogTab);

    document.querySelectorAll('.summary-dim-btn').forEach(function (dimBtn) {
      dimBtn.addEventListener('click', function () {
        currentSummaryDim = dimBtn.dataset.dim || 'sku_date';
        renderSummaryTab(computeMetrics());
      });
    });

    document.getElementById('editCodeInput').addEventListener('input', function (e) {
      const code = String(e.target.value || '').trim();
      const found = getProductNameOrNull(code);
      if (found) {
        document.getElementById('editNameInput').value = found;
      }
    });

    document.getElementById('btnSaveEdit').addEventListener('click', saveEditedRecord);
    const btnOpenAdd2 = document.getElementById('btnOpenManualAdd2');
    if (btnOpenAdd2) {
      btnOpenAdd2.addEventListener('click', function () {
        openEditModal(null);
      });
    }

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
        showBanner('ok', 'Đã sao chép Mã Kết Nối Google Sheet (có Barcode KH + NSX & HSD)!');
        document.getElementById('btnCopyAppsScript').textContent = '✅ Đã sao chép mã!';
        setTimeout(function () {
          document.getElementById('btnCopyAppsScript').textContent = '📋 Sao chép Mã Kết Nối Google Sheet (Có Barcode KH + NSX & HSD)';
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
        const teamLink = baseClean + '?sheet=' + encodeURIComponent(rawUrl);
        navigator.clipboard.writeText(teamLink).then(function () {
          showBanner('ok', '✅ Đã sao chép Link dùng chung! Gửi qua Zalo cho điện thoại nào cũng chụp & tự đồng bộ được!');
          copyTeamBtn.textContent = '✅ Đã sao chép Link dùng chung!';
          setTimeout(function () {
            copyTeamBtn.textContent = '🔗 Sao chép Link dùng chung cho mọi ĐT';
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
          'Để tự động ghi dữ liệu vào bảng tính, bạn cần dán đường link có đuôi "/exec" (bắt đầu bằng https://script.google.com/macros/s/.../exec)!'
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
      setActiveCustomerBarcode('', true);
      persistRecords();
      enqueueOp({ type: 'clear_all' });
      renderAll(false);
      const pop = document.getElementById('snapPopCard');
      if (pop) pop.style.display = 'none';
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
    rescueDates: function (id) { rescueDatesForRecord(id); },
    filterCustomer: function (custKey) {
      activeRecordCustomerFilter = custKey;
      renderScanLists();
    },
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
