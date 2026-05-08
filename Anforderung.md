Baue eine PWA (Progressive Web App) für einen Tierarzt 
zum Diktieren und Strukturieren von Anamnesen.

## Design
- Modern, hell, clean
- Große Buttons (Bedienung mit einer Hand im Auto)
- Klare Statusanzeigen
- Deutsch als Sprache

## Screens

### 1. Hauptscreen
- Großer zentraler Aufnahme-Button (Start/Pause/Weiter/Stop)
- Zeigt Aufnahmedauer
- Liste aller Diktate mit Status:
  - "Aufnahme läuft"
  - "Wartet auf Verbindung"
  - "Wird verarbeitet..."
  - "Fertig"
  - "Fehler"
- Jedes fertige Diktat hat einen "Text kopieren" Button
- Fertige Texte bleiben gespeichert bis manuell gelöscht

### 2. Einstellungen (⚙️ Button oben rechts)
- OpenAI API Key Eingabefeld
- Anthropic API Key Eingabefeld
- Editierbares Textfeld für den Claude-Prompt
- Standard-Prompt vorausgefüllt:

"Strukturiere den folgenden tierärztlichen Befund 
in dieses Format:
- Tiername:
- Tierart / Rasse:
- Alter:
- Gewicht / Vitalzeichen:
- Symptome:
- Diagnose:
- Therapie / Medikamente:
- Nächster Termin:

Befund: [TRANSKRIPT]

Gib nur den strukturierten Text zurück, 
keine Erklärungen oder Kommentare."

- "Speichern" Button → in localStorage gespeichert
- "Zurücksetzen" Button → Standard-Prompt wiederherstellen
- Alle Keys und Einstellungen in localStorage gespeichert

## Technische Funktionen

### Aufnahme
- Audio wird lokal gespeichert (IndexedDB)
- Pause/Weiter funktioniert auch wenn App im Hintergrund ist
- Mehrere Diktate möglich (Warteschlange)
- Maximale Aufnahmedauer: 15 Minuten pro Diktat

### Verarbeitung (Offline-First)
- App erkennt Netzwerkstatus automatisch
- Kein Netz → Audio bleibt in Warteschlange
- Netz verfügbar → automatische Verarbeitung startet
- Schritt 1: Audio → Whisper API (OpenAI) → Transkript
  - language: "de"
  - model: "whisper-1"
- Schritt 2: Transkript → Claude API (Anthropic) → strukturierter Text
  - model: "claude-haiku-4-5-20251001"
  - max_tokens: 1024
- Fehlerbehandlung mit automatischem Retry (3 Versuche)
- Bei Fehler → Status "Fehler" mit Retry-Button

### Offline / PWA
- manifest.json für "Zum Homescreen hinzufügen"
- Service Worker für Offline-Fähigkeit
- HTTPS-kompatibel (läuft auf GitHub Pages)
- App funktioniert auch wenn Laptop per Browser 
  im selben Hotspot-Netz zugreift

## API Keys Sicherheit
- Keys werden NICHT im Code hardcoded
- Einmalige Eingabe in Einstellungen → localStorage
- Keys nur im Browser des Geräts gespeichert

## Tech Stack
- Vanilla HTML/CSS/JavaScript (kein Framework)
- Keine externen Abhängigkeiten außer den APIs
- Dateien: index.html, manifest.json, service-worker.js
- Saubere Kommentare auf Deutsch im Code

## GitHub Pages
- Alle Pfade relativ (kein absoluter Pfad)
- Funktioniert direkt aus dem Repository Root
