# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Lokaler Entwicklungsserver

```bash
cd /home/admin/Dokumente/Claude/Tierarztapp
python3 -m http.server 8765
```

Die App ist dann unter `http://localhost:8765` erreichbar. Nach Änderungen an `app.js` oder `index.html` den Browser mit **Strg+Shift+R** (Hard Reload) neu laden, da der Service Worker Dateien aggressiv cached. Bei hartnäckigen Cache-Problemen: DevTools → Application → Service Workers → Unregister, dann neu laden.

## Architektur

Drei Dateien, kein Build-Schritt, kein Framework:

- **`index.html`** — HTML-Struktur + vollständiges inline CSS. Enthält alle Element-IDs, die `app.js` per `getElementById` referenziert.
- **`app.js`** — Gesamte Anwendungslogik in einem einzigen `DOMContentLoaded`-Listener (kein Modul-System). Funktionsgruppen in dieser Reihenfolge: IndexedDB → Timer → Aufnahme-Zustand → Aufnahme → Queue/Verarbeitung → Whisper-API → Claude-API → Rendering → Online/Offline → Einstellungen → Init.
- **`service-worker.js`** — Cache-First für lokale Dateien, Network-Only für `api.openai.com` und `api.anthropic.com`. Cache-Name: `tierarzt-diktat-v2` — bei Breaking Changes versionieren, damit der Browser den alten Cache verwirft.
- **`manifest.json`** — PWA-Manifest mit SVG-Icons als inline Data-URLs (keine externen PNG-Dateien).

## Datenfluss

```
Mikrofon → MediaRecorder (audio/webm oder audio/ogg)
         → audioChunks[] → Blob
         → IndexedDB (status: "waiting")
         → processQueue()
             → transkribiere()  POST api.openai.com/v1/audio/transcriptions
             → strukturiere()   POST api.anthropic.com/v1/messages
         → IndexedDB (status: "done", strukturierterText)
         → renderDiktate()
```

`processQueue()` läuft beim App-Start, beim `online`-Event und nach jeder Aufnahme. Ein `verarbeitungLaeuft`-Flag verhindert parallele Durchläufe.

## Wichtige IDs (HTML ↔ JS-Schnittstelle)

Änderungen an diesen IDs müssen in beiden Dateien synchron erfolgen:

| ID | Zweck |
|---|---|
| `btn-record` | Aufnahme-Button (Klasse `aufnahme-aktiv` bei Aufnahme) |
| `recording-timer` | Timer-Anzeige |
| `dictation-list` | Container, wird von `renderDiktate()` neu gerendert |
| `status-bar` | Header; Hintergrundfarbe per JS geändert |
| `verbindungs-status` | Span im Header für "Online"/"Offline"-Text |
| `settings-modal` | Modal (Klasse `offen` zum Einblenden) |

## API-Konfiguration

| Parameter | Wert |
|---|---|
| Whisper-Modell | `whisper-1`, `language: "de"` |
| Claude-Modell | `claude-haiku-4-5-20251001`, `max_tokens: 1024` |
| Claude-Header | `anthropic-dangerous-direct-browser-access: true` (nötig für direkte Browser-Anfragen) |
| Retries | max. 3 (`MAX_RETRY`), danach Status `"error"` |
| Max. Aufnahme | 900 Sekunden (`MAX_AUFNAHME_SEKUNDEN = 15 * 60`) |

API-Keys werden ausschließlich in `localStorage` gespeichert (`"openai-key"`, `"anthropic-key"`, `"claude-prompt"`).
