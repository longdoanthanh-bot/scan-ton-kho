const CACHE_NAME = 'scan-ton-kho-v28';
const CORE_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './catalog.js',
  './apps_script_embed.js',
  './manifest.json',
  './icon-192.svg',
  './vendor/zxing_wasm_reader.js',
  './vendor/zxing_reader.wasm'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(CORE_ASSETS);
    })
  );
  self.skipWaiting();
});

self.addEventListener('message', function (event) {
  if (event && event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k !== CACHE_NAME; })
            .map(function (k) { return caches.delete(k); })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

function fetchFreshWithTimeout(request, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var done = false;
    var timer = setTimeout(function () {
      if (!done) {
        done = true;
        reject(new Error('network_timeout'));
      }
    }, timeoutMs);

    fetch(request, { cache: 'no-cache' }).then(function (resp) {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(resp);
      }
    }).catch(function (err) {
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') return;

  var url = event.request.url || '';
  if (
    url.indexOf('script.google.com') !== -1 ||
    url.indexOf('googleusercontent.com') !== -1 ||
    url.indexOf('/api/') !== -1
  ) {
    return;
  }

  // Các thư viện giải mã mã vạch 1D & bộ đọc chữ NSX/HSD: ưu tiên lấy tức thì từ bộ nhớ máy (0ms, hoạt động 100% khi mất mạng)
  if (
    url.indexOf('/vendor/') !== -1 ||
    url.indexOf('.wasm') !== -1 ||
    url.indexOf('.traineddata') !== -1
  ) {
    var cleanUrl = url.replace(/([^:]\/)\/+/g, '$1');
    event.respondWith(
      caches.open(CACHE_NAME).then(function (cache) {
        return cache.match(cleanUrl, { ignoreSearch: true }).then(function (cached) {
          if (cached) return cached;
          return fetch(cleanUrl).then(function (netResp) {
            if (netResp && netResp.ok) {
              cache.put(cleanUrl, netResp.clone());
            }
            return netResp;
          });
        });
      })
    );
    return;
  }

  // Các tệp giao diện & mã nguồn chính:
  // Có mạng -> kiểm tra thẳng máy chủ ({ cache: 'no-cache' }) để luôn nhận bản mới nhất tức thì;
  // Mất mạng hoặc sóng yếu -> mở ngay lập tức từ bộ nhớ Offline!
  event.respondWith(
    fetchFreshWithTimeout(event.request, 2800).then(function (netResp) {
      if (netResp && netResp.ok && url.indexOf(self.location.origin) === 0) {
        var clone = netResp.clone();
        caches.open(CACHE_NAME).then(function (cache) {
          cache.put(event.request, clone);
        });
      }
      return netResp;
    }).catch(function () {
      return caches.match(event.request, { ignoreSearch: true }).then(function (cached) {
        if (cached) return cached;
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html', { ignoreSearch: true });
        }
        return new Response('Offline', { status: 503 });
      });
    })
  );
});
