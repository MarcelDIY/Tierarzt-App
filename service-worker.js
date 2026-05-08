// Service Worker für Tierarzt Diktat App
// Strategie: Cache-First für lokale Ressourcen, Network-Only für API-Aufrufe

const CACHE_NAME = 'tierarzt-diktat-v4';

// Dateien, die beim Installieren gecacht werden
const DATEIEN_ZUM_CACHEN = [
  './',
  './index.html',
  './app.js',
  './manifest.json'
];

// API-Domains, die niemals gecacht werden (immer Netzwerk verwenden)
const NETZWERK_ONLY_DOMAINS = [
  'api.openai.com',
  'api.anthropic.com'
];

// --- Install-Event: Ressourcen vorab cachen ---
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Dateien werden gecacht...');
      return cache.addAll(DATEIEN_ZUM_CACHEN);
    }).then(() => {
      console.log('[SW] Installation abgeschlossen, alle Dateien gecacht.');
      // Sofort aktivieren ohne auf vorherige Version zu warten
      return self.skipWaiting();
    })
  );
});

// --- Activate-Event: Alte Caches löschen ---
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNamen) => {
      return Promise.all(
        cacheNamen
          .filter((name) => name !== CACHE_NAME)
          .map((alterCache) => {
            console.log('[SW] Alter Cache wird gelöscht:', alterCache);
            return caches.delete(alterCache);
          })
      );
    }).then(() => {
      console.log('[SW] Aktivierung abgeschlossen, übernehme alle Clients.');
      // Sofort alle offenen Tabs übernehmen
      return self.clients.claim();
    })
  );
});

// --- Fetch-Event: Anfragen abfangen und verarbeiten ---
self.addEventListener('fetch', (event) => {
  const anfrageUrl = new URL(event.request.url);

  // Network-Only für API-Endpunkte (OpenAI, Anthropic)
  if (NETZWERK_ONLY_DOMAINS.some((domain) => anfrageUrl.hostname === domain)) {
    console.log('[SW] Network-Only für API-Anfrage:', anfrageUrl.hostname);
    event.respondWith(fetch(event.request));
    return;
  }

  // Cache-First für alle lokalen Dateien
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        // Treffer im Cache – direkt zurückgeben
        return cachedResponse;
      }

      // Nicht im Cache – vom Netzwerk laden und cachen
      return fetch(event.request).then((networkResponse) => {
        // Nur gültige Antworten cachen (kein Fehler, kein opaker Response von Fremddomain)
        if (
          networkResponse &&
          networkResponse.status === 200 &&
          networkResponse.type === 'basic'
        ) {
          const responseKopie = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseKopie);
          });
        }
        return networkResponse;
      }).catch(() => {
        // Netzwerk nicht erreichbar und kein Cache – ggf. Fallback
        console.warn('[SW] Netzwerk nicht erreichbar, keine Cache-Antwort für:', event.request.url);
      });
    })
  );
});
