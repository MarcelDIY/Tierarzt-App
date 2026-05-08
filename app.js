// Tierarzt-Diktat-PWA — Hauptlogik

document.addEventListener("DOMContentLoaded", () => {

  // ── Konstanten ──────────────────────────────────────────────────────────────

  const DB_NAME              = "tierarzt-diktate";
  const DB_VERSION           = 1;
  const STORE_NAME           = "diktate";
  const MAX_AUFNAHME_SEKUNDEN = 15 * 60; // 15 Minuten
  const MAX_RETRY            = 3;
  const RETRY_BASIS_MS       = 2000; // Backoff-Basis: 2s, 4s, 8s

  const STANDARD_PROMPT = `Strukturiere den folgenden tierärztlichen Befund in dieses Format:
- Tiername:
- Tierart / Rasse:
- Alter:
- Gewicht / Vitalzeichen:
- Symptome:
- Diagnose:
- Therapie / Medikamente:
- Nächster Termin:

Befund: [TRANSKRIPT]

Gib nur den strukturierten Text zurück, keine Erklärungen oder Kommentare.`;

  // ── Zustand ─────────────────────────────────────────────────────────────────

  let db                 = null;
  let mediaRecorder      = null;
  let audioChunks        = [];
  let mediaStream        = null;
  // Zustände: idle | recording | paused | stopped
  let aufnahmeZustand    = "idle";
  let timerIntervall     = null;
  let aufnahmeSekunden   = 0;
  let verarbeitungLaeuft = false;
  // Cache für Object-URLs der Audio-Blobs (zur sauberen Freigabe)
  const audioUrlCache    = new Map();

  // ── DOM-Referenzen ──────────────────────────────────────────────────────────

  const btnRecord         = document.getElementById("btn-record");
  const btnRecordLabel    = btnRecord.querySelector(".btn-record__label");
  const btnStop           = document.getElementById("btn-stop");
  const recordingTimer    = document.getElementById("recording-timer");
  const dictationList     = document.getElementById("dictation-list");
  const statusBar         = document.getElementById("status-bar");
  const verbindungsStatus = document.getElementById("verbindungs-status");
  const aufnahmeHinweis   = document.getElementById("aufnahme-hinweis-text");
  const btnSettings       = document.getElementById("btn-settings");
  const settingsModal     = document.getElementById("settings-modal");
  const btnCloseSettings  = document.getElementById("btn-close-settings");
  const inputOpenaiKey    = document.getElementById("input-openai-key");
  const inputAnthropicKey = document.getElementById("input-anthropic-key");
  const inputPrompt       = document.getElementById("input-prompt");
  const btnSaveSettings   = document.getElementById("btn-save-settings");
  const btnResetPrompt    = document.getElementById("btn-reset-prompt");

  // ══════════════════════════════════════════════════════════════════════════════
  // IndexedDB
  // ══════════════════════════════════════════════════════════════════════════════

  function oeffneDB() {
    return new Promise((resolve, reject) => {
      const anfrage = indexedDB.open(DB_NAME, DB_VERSION);

      anfrage.onupgradeneeded = (event) => {
        const datenbank = event.target.result;
        if (!datenbank.objectStoreNames.contains(STORE_NAME)) {
          datenbank.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
        }
      };

      anfrage.onsuccess = (event) => resolve(event.target.result);
      anfrage.onerror   = (event) => reject(event.target.error);
    });
  }

  function saveDiktat(diktat) {
    return new Promise((resolve, reject) => {
      const tx      = db.transaction(STORE_NAME, "readwrite");
      const store   = tx.objectStore(STORE_NAME);
      const anfrage = store.add(diktat);
      anfrage.onsuccess = () => resolve(anfrage.result); // gibt neue ID zurück
      anfrage.onerror   = () => reject(anfrage.error);
    });
  }

  function updateDiktat(diktat) {
    return new Promise((resolve, reject) => {
      const tx      = db.transaction(STORE_NAME, "readwrite");
      const store   = tx.objectStore(STORE_NAME);
      const anfrage = store.put(diktat);
      anfrage.onsuccess = () => resolve();
      anfrage.onerror   = () => reject(anfrage.error);
    });
  }

  function getAllDiktate() {
    return new Promise((resolve, reject) => {
      const tx      = db.transaction(STORE_NAME, "readonly");
      const store   = tx.objectStore(STORE_NAME);
      const anfrage = store.getAll();
      anfrage.onsuccess = () => resolve(anfrage.result);
      anfrage.onerror   = () => reject(anfrage.error);
    });
  }

  function deleteDiktat(id) {
    return new Promise((resolve, reject) => {
      const tx      = db.transaction(STORE_NAME, "readwrite");
      const store   = tx.objectStore(STORE_NAME);
      const anfrage = store.delete(id);
      anfrage.onsuccess = () => resolve();
      anfrage.onerror   = () => reject(anfrage.error);
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Timer
  // ══════════════════════════════════════════════════════════════════════════════

  function formatiereZeit(sekunden) {
    const m = String(Math.floor(sekunden / 60)).padStart(2, "0");
    const s = String(sekunden % 60).padStart(2, "0");
    return `${m}:${s}`;
  }

  function starteTimer() {
    timerIntervall = setInterval(() => {
      aufnahmeSekunden++;
      recordingTimer.textContent = formatiereZeit(aufnahmeSekunden);

      if (aufnahmeSekunden >= MAX_AUFNAHME_SEKUNDEN) {
        // Maximale Aufnahmedauer erreicht → automatisch beenden
        stoppeAufnahme();
      }
    }, 1000);
  }

  function pausierTimer() {
    clearInterval(timerIntervall);
    timerIntervall = null;
  }

  function resetTimer() {
    pausierTimer();
    aufnahmeSekunden = 0;
    recordingTimer.textContent = "00:00";
    recordingTimer.classList.remove("aktiv");
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Aufnahme-Button — Zustandsmaschine
  // idle/stopped → recording  (Button: "Pause")
  // recording    → paused     (Button: "Weiter", Stop-Button erscheint)
  // paused       → recording  (Resume)
  // paused       → stopped    (per Stop-Button)
  // ══════════════════════════════════════════════════════════════════════════════

  function setzeZustandUndButton(neuerZustand) {
    aufnahmeZustand = neuerZustand;
    btnRecord.classList.remove("aufnahme-aktiv");
    btnStop.classList.add("versteckt");

    switch (neuerZustand) {
      case "idle":
      case "stopped":
        btnRecordLabel.textContent = "Starten";
        btnRecord.setAttribute("aria-label", "Aufnahme starten");
        aufnahmeHinweis.textContent = "Drücke den Button, um ein Diktat zu starten";
        recordingTimer.classList.remove("aktiv");
        break;
      case "recording":
        btnRecordLabel.textContent = "Pause";
        btnRecord.setAttribute("aria-label", "Aufnahme pausieren");
        btnRecord.classList.add("aufnahme-aktiv");
        aufnahmeHinweis.textContent = "Aufnahme läuft – Tippen zum Pausieren";
        recordingTimer.classList.add("aktiv");
        break;
      case "paused":
        btnRecordLabel.textContent = "Weiter";
        btnRecord.setAttribute("aria-label", "Aufnahme fortsetzen");
        btnStop.classList.remove("versteckt");
        aufnahmeHinweis.textContent = "Pausiert – Weiter aufnehmen oder beenden";
        recordingTimer.classList.remove("aktiv");
        break;
    }
  }

  btnRecord.addEventListener("click", () => {
    switch (aufnahmeZustand) {
      case "idle":
      case "stopped":
        starteAufnahme();
        break;
      case "recording":
        pausiereAufnahme();
        break;
      case "paused":
        resumeAufnahme();
        break;
    }
  });

  btnStop.addEventListener("click", () => {
    if (aufnahmeZustand === "paused" || aufnahmeZustand === "recording") {
      stoppeAufnahme();
    }
  });

  // ── Aufnahme-Funktionen ─────────────────────────────────────────────────────

  async function starteAufnahme() {
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      alert("Mikrofon-Zugriff verweigert. Bitte erlaube den Zugriff auf das Mikrofon in den Browser-Einstellungen.");
      return;
    }

    audioChunks = [];

    // audio/webm bevorzugen, Fallback auf audio/ogg
    const mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "audio/ogg";
    mediaRecorder = new MediaRecorder(mediaStream, { mimeType });

    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        audioChunks.push(event.data);
      }
    };

    mediaRecorder.onstop = () => {
      // Mikrofon-Stream freigeben (damit Mikrofon-Icon im Browser erlischt)
      if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
        mediaStream = null;
      }
      verarbeiteAufnahme();
    };

    mediaRecorder.start(1000); // Chunks alle 1s sichern (besser für lange Aufnahmen)
    setzeZustandUndButton("recording");
    starteTimer();
  }

  function pausiereAufnahme() {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      mediaRecorder.pause();
    }
    setzeZustandUndButton("paused");
    pausierTimer();
  }

  function resumeAufnahme() {
    if (mediaRecorder && mediaRecorder.state === "paused") {
      mediaRecorder.resume();
    }
    setzeZustandUndButton("recording");
    starteTimer();
  }

  function stoppeAufnahme() {
    if (mediaRecorder && (mediaRecorder.state === "recording" || mediaRecorder.state === "paused")) {
      mediaRecorder.stop(); // löst onstop aus → verarbeiteAufnahme()
    }
    setzeZustandUndButton("stopped");
    resetTimer();
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Aufnahme nach Stop verarbeiten
  // ══════════════════════════════════════════════════════════════════════════════

  async function verarbeiteAufnahme() {
    if (audioChunks.length === 0) return;

    const mimeType  = (mediaRecorder && mediaRecorder.mimeType) ? mediaRecorder.mimeType : "audio/webm";
    const audioBlob = new Blob(audioChunks, { type: mimeType });

    const neuesDiktat = {
      status:           "waiting",
      audioBlob,
      transkript:       null,
      strukturierterText: null,
      erstellt:         new Date(),
      fehler:           null,
      retryCount:       0,
    };

    const neueId      = await saveDiktat(neuesDiktat);
    neuesDiktat.id    = neueId;
    audioChunks       = [];

    setzeZustandUndButton("idle");
    await renderDiktate();
    processQueue();
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Verarbeitungs-Queue
  // ══════════════════════════════════════════════════════════════════════════════

  function warte(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function processQueue() {
    if (verarbeitungLaeuft) return;
    if (!navigator.onLine) return;

    const openaiKey    = localStorage.getItem("openai-key") || "";
    const anthropicKey = localStorage.getItem("anthropic-key") || "";

    if (!openaiKey || !anthropicKey) {
      zeigeStatusHinweis("API-Keys fehlen – bitte in den Einstellungen eintragen.", "hinweis");
      return;
    }

    verarbeitungLaeuft = true;

    try {
      const alleDiktate   = await getAllDiktate();
      const zuVerarbeiten = alleDiktate.filter(
        d => d.status === "waiting" || (d.status === "error" && d.retryCount < MAX_RETRY)
      );

      for (const diktat of zuVerarbeiten) {
        // Exponentielles Backoff bei Wiederholungen: 2s, 4s, 8s
        if (diktat.retryCount > 0) {
          const wartezeit = RETRY_BASIS_MS * Math.pow(2, diktat.retryCount - 1);
          await warte(wartezeit);
        }
        await verarbeiteDiktat(diktat, openaiKey, anthropicKey);
      }
    } finally {
      verarbeitungLaeuft = false;
    }
  }

  async function verarbeiteDiktat(diktat, openaiKey, anthropicKey) {
    diktat.status = "processing";
    await updateDiktat(diktat);
    await renderDiktate();

    try {
      // Schritt 1: Whisper-Transkription
      diktat.transkript = await transkribiere(diktat.audioBlob, openaiKey);

      // Schritt 2: Claude-Strukturierung
      diktat.strukturierterText = await strukturiere(diktat.transkript, anthropicKey);
      diktat.status             = "done";
      diktat.fehler             = null;
    } catch (err) {
      diktat.retryCount = (diktat.retryCount || 0) + 1;
      diktat.fehler     = err.message || "Unbekannter Fehler";

      // Nach MAX_RETRY Versuchen endgültig auf error setzen
      diktat.status = (diktat.retryCount >= MAX_RETRY) ? "error" : "waiting";
    }

    await updateDiktat(diktat);
    await renderDiktate();
  }

  // ── Whisper API ─────────────────────────────────────────────────────────────

  async function transkribiere(audioBlob, openaiKey) {
    const dateiname = (audioBlob.type || "").includes("ogg") ? "audio.ogg" : "audio.webm";
    const formData  = new FormData();
    formData.append("file", audioBlob, dateiname);
    formData.append("model", "whisper-1");
    formData.append("language", "de");

    const antwort = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method:  "POST",
      headers: { "Authorization": `Bearer ${openaiKey}` },
      body:    formData,
    });

    if (!antwort.ok) {
      const text = await antwort.text();
      throw new Error(`Whisper ${antwort.status}: ${text}`);
    }

    const daten = await antwort.json();
    return daten.text;
  }

  // ── Claude API ──────────────────────────────────────────────────────────────

  async function strukturiere(transkript, anthropicKey) {
    const vorlage = localStorage.getItem("claude-prompt") || STANDARD_PROMPT;
    const prompt  = vorlage.replace("[TRANSKRIPT]", transkript);

    const antwort = await fetch("https://api.anthropic.com/v1/messages", {
      method:  "POST",
      headers: {
        "x-api-key":                              anthropicKey,
        "anthropic-version":                      "2023-06-01",
        "content-type":                           "application/json",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model:      "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        messages:   [{ role: "user", content: prompt }],
      }),
    });

    if (!antwort.ok) {
      const text = await antwort.text();
      throw new Error(`Claude ${antwort.status}: ${text}`);
    }

    const daten = await antwort.json();
    return daten.content[0].text;
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // UI-Rendering
  // ══════════════════════════════════════════════════════════════════════════════

  // Object-URL für ein Audio-Blob holen (mit Cache, damit beim Re-Render nicht
  // ständig neue URLs erzeugt werden – würde sonst die Wiedergabe unterbrechen).
  function getAudioUrl(diktat) {
    if (!diktat.audioBlob) return null;
    if (audioUrlCache.has(diktat.id)) return audioUrlCache.get(diktat.id);
    const url = URL.createObjectURL(diktat.audioBlob);
    audioUrlCache.set(diktat.id, url);
    return url;
  }

  function loescheAudioUrl(id) {
    if (audioUrlCache.has(id)) {
      URL.revokeObjectURL(audioUrlCache.get(id));
      audioUrlCache.delete(id);
    }
  }

  async function renderDiktate() {
    const alleDiktate = await getAllDiktate();
    dictationList.innerHTML = "";

    // Veraltete Object-URLs aufräumen (Diktate, die gelöscht wurden)
    const aktuelleIds = new Set(alleDiktate.map(d => d.id));
    for (const id of audioUrlCache.keys()) {
      if (!aktuelleIds.has(id)) loescheAudioUrl(id);
    }

    // Neueste zuerst
    const sortiert = [...alleDiktate].sort((a, b) => new Date(b.erstellt) - new Date(a.erstellt));

    sortiert.forEach((diktat, index) => {
      // Laufende Nummer: ältestes = #1, neuestes = #N
      const nummer = alleDiktate.length - index;
      dictationList.appendChild(erstelleDiktatElement(diktat, nummer));
    });
  }

  function erstelleDiktatElement(diktat, nummer) {
    const div = document.createElement("div");
    div.className  = "dictation-item";
    div.setAttribute("role", "listitem");
    div.dataset.id = diktat.id;

    // Kopfzeile
    const kopf = document.createElement("div");
    kopf.className = "dictation-item__header";

    const titel = document.createElement("span");
    titel.className   = "dictation-title";
    const datum       = new Date(diktat.erstellt).toLocaleString("de-DE", {
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit"
    });
    titel.textContent = `Diktat #${nummer} · ${datum}`;

    const badge = document.createElement("span");
    badge.className   = `dictation-status ${statusKlasse(diktat.status)}`;
    badge.textContent = statusText(diktat.status);

    kopf.appendChild(titel);
    kopf.appendChild(badge);
    div.appendChild(kopf);

    // Audio-Wiedergabe der Original-Aufnahme (wenn Blob vorhanden)
    const audioUrl = getAudioUrl(diktat);
    if (audioUrl) {
      const audio = document.createElement("audio");
      audio.className = "dictation-audio";
      audio.controls  = true;
      audio.preload   = "none";
      audio.src       = audioUrl;
      div.appendChild(audio);
    }

    // Strukturierten Text nur bei "done" anzeigen
    if (diktat.status === "done" && diktat.strukturierterText) {
      const pre = document.createElement("div");
      pre.className   = "dictation-result";
      pre.textContent = diktat.strukturierterText;
      div.appendChild(pre);
    }

    // Fehlermeldung bei "error"
    if (diktat.status === "error" && diktat.fehler) {
      const fehlerP = document.createElement("p");
      fehlerP.className   = "dictation-fehler";
      fehlerP.textContent = `Fehler: ${diktat.fehler}`;
      div.appendChild(fehlerP);
    }

    // Aktionsbereich
    const aktionen = document.createElement("div");
    aktionen.className = "dictation-item__aktionen";

    if (diktat.status === "done") {
      const btnKopieren = document.createElement("button");
      btnKopieren.textContent = "Text kopieren";
      btnKopieren.className   = "btn-copy";
      btnKopieren.addEventListener("click", () => {
        navigator.clipboard.writeText(diktat.strukturierterText).then(() => {
          btnKopieren.textContent = "Kopiert!";
          setTimeout(() => { btnKopieren.textContent = "Text kopieren"; }, 2000);
        });
      });
      aktionen.appendChild(btnKopieren);
    }

    if (diktat.status === "error") {
      const btnRetry = document.createElement("button");
      btnRetry.textContent = "Erneut versuchen";
      btnRetry.className   = "btn-retry";
      btnRetry.addEventListener("click", async () => {
        diktat.retryCount = 0;
        diktat.status     = "waiting";
        diktat.fehler     = null;
        await updateDiktat(diktat);
        await renderDiktate();
        processQueue();
      });
      aktionen.appendChild(btnRetry);
    }

    // Löschen-Button immer anzeigen
    const btnLoeschen = document.createElement("button");
    btnLoeschen.textContent = "Löschen";
    btnLoeschen.className   = "btn-delete";
    btnLoeschen.addEventListener("click", async () => {
      if (!confirm(`Diktat #${nummer} wirklich löschen?`)) return;
      loescheAudioUrl(diktat.id);
      await deleteDiktat(diktat.id);
      await renderDiktate();
    });
    aktionen.appendChild(btnLoeschen);

    div.appendChild(aktionen);
    return div;
  }

  function statusText(status) {
    const texte = {
      waiting:    "Wartet auf Verbindung",
      processing: "Wird verarbeitet...",
      done:       "Fertig",
      error:      "Fehler",
    };
    return texte[status] || status;
  }

  function statusKlasse(status) {
    const klassen = {
      waiting:    "status-waiting",
      processing: "status-processing",
      done:       "status-done",
      error:      "status-error",
    };
    return klassen[status] || "";
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // Online/Offline
  // ══════════════════════════════════════════════════════════════════════════════

  function aktualisiereOnlineStatus() {
    statusBar.classList.remove("hinweis", "fehler");
    if (navigator.onLine) {
      verbindungsStatus.textContent = "Online";
      verbindungsStatus.classList.remove("offline");
      statusBar.classList.remove("offline");
    } else {
      verbindungsStatus.textContent = "Offline";
      verbindungsStatus.classList.add("offline");
      statusBar.classList.add("offline");
    }
  }

  // Zeigt einen temporären Hinweistext oben (z.B. "API-Keys fehlen").
  // klasse: "hinweis" (orange) oder "fehler" (rot)
  function zeigeStatusHinweis(text, klasse = "hinweis") {
    verbindungsStatus.textContent = text;
    statusBar.classList.remove("offline", "hinweis", "fehler");
    statusBar.classList.add(klasse);
    // Nach 4 Sekunden wieder normalen Status anzeigen
    setTimeout(aktualisiereOnlineStatus, 4000);
  }

  window.addEventListener("online",  () => { aktualisiereOnlineStatus(); processQueue(); });
  window.addEventListener("offline", aktualisiereOnlineStatus);

  // ══════════════════════════════════════════════════════════════════════════════
  // Einstellungen
  // ══════════════════════════════════════════════════════════════════════════════

  function ladeEinstellungen() {
    inputOpenaiKey.value    = localStorage.getItem("openai-key") || "";
    inputAnthropicKey.value = localStorage.getItem("anthropic-key") || "";
    inputPrompt.value       = localStorage.getItem("claude-prompt") || STANDARD_PROMPT;
  }

  btnSettings.addEventListener("click", () => {
    ladeEinstellungen();
    settingsModal.classList.add("offen");
  });

  btnCloseSettings.addEventListener("click", () => {
    settingsModal.classList.remove("offen");
  });

  // Klick auf Modal-Hintergrund schließt das Modal
  settingsModal.addEventListener("click", (event) => {
    if (event.target === settingsModal) {
      settingsModal.classList.remove("offen");
    }
  });

  btnSaveSettings.addEventListener("click", () => {
    localStorage.setItem("openai-key",    inputOpenaiKey.value.trim());
    localStorage.setItem("anthropic-key", inputAnthropicKey.value.trim());
    localStorage.setItem("claude-prompt", inputPrompt.value);
    settingsModal.classList.remove("offen");
    // Nach Speichern direkt versuchen, wartende Diktate zu verarbeiten
    processQueue();
  });

  btnResetPrompt.addEventListener("click", () => {
    inputPrompt.value = STANDARD_PROMPT;
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // Service Worker
  // ══════════════════════════════════════════════════════════════════════════════

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("service-worker.js").catch((err) => {
      console.warn("Service Worker konnte nicht registriert werden:", err);
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // App-Start
  // ══════════════════════════════════════════════════════════════════════════════

  async function init() {
    db = await oeffneDB();
    aktualisiereOnlineStatus();
    ladeEinstellungen();
    setzeZustandUndButton("idle");
    await renderDiktate();
    processQueue();
  }

  init().catch((err) => {
    console.error("Initialisierungsfehler:", err);
    verbindungsStatus.textContent = "Fehler beim Starten der App.";
    statusBar.classList.add("fehler");
  });

}); // Ende DOMContentLoaded
