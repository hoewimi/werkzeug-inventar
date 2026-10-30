// Ablage in IndexedDB (E15, E24), nach dem Muster der iPhone-Probe (src/probe/probe.js, oeffneDb/dbAktion).
// Drei getrennte Speicher: geraete (Schlüssel id), fotos (Blob unter <id>-<art>), einstellungen (z. B. API-Schlüssel,
// letzte Sicherung). Sicherung und CSV lesen nur geraete und fotos, nie einstellungen. Läuft nur im Browser.

export const DB_NAME = "werkzeug-inventar";
const VERSION = 1;

let verbindung = null;

function oeffne() {
  verbindung ??= new Promise((ok, nein) => {
    const r = indexedDB.open(DB_NAME, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore("geraete", { keyPath: "id" });
      db.createObjectStore("fotos");
      db.createObjectStore("einstellungen");
    };
    r.onsuccess = () => {
      const db = r.result;
      db.onversionchange = () => { db.close(); verbindung = null; };
      db.onclose = () => { verbindung = null; }; // iOS trennt die Verbindung im Hintergrund
      ok(db);
    };
    r.onerror = () => { verbindung = null; nein(r.error); };
    r.onblocked = () => { verbindung = null; nein(new Error("Datenbank blockiert: die App ist noch in einem anderen Fenster offen")); };
  });
  return verbindung;
}

// Transaktion auf der zwischengespeicherten Verbindung; ist sie verloren (iOS: „Connection to Indexed Database server
// lost“), einmal neu öffnen.
async function transaktion(namen, modus) {
  try {
    return (await oeffne()).transaction(namen, modus);
  } catch {
    verbindung = null;
    return (await oeffne()).transaction(namen, modus);
  }
}

// fn(stores) bekommt die Speicher als Objekt und gibt optional eine Anfrage zurück, deren Ergebnis zurückkommt.
// Wirft fn, wird die Transaktion abgebrochen (alles oder nichts).
async function aktion(namen, modus, fn) {
  const tx = await transaktion(namen, modus);
  return new Promise((ok, nein) => {
    let ergebnis;
    tx.oncomplete = () => ok(ergebnis);
    tx.onerror = () => nein(tx.error);
    tx.onabort = () => nein(tx.error || new Error("Transaktion abgebrochen"));
    try {
      const stores = Object.fromEntries(namen.map((n) => [n, tx.objectStore(n)]));
      const r = fn(stores);
      if (r) r.onsuccess = () => (ergebnis = r.result);
    } catch (e) {
      nein(e);
      try { tx.abort(); } catch { /* schon beendet */ }
    }
  });
}

/* ---------- Speicherstatus (E24) ---------- */
// Bei jedem Start aufrufen: fragt persist() erneut an und liest danach persisted().
// Ergebnis: { persistiert: true | false | null (unbekannt), belegt, quota (Bytes oder null) }
export async function pruefeSpeicher() {
  const s = globalThis.navigator?.storage;
  if (!s) return { persistiert: null, belegt: null, quota: null };
  try { if (s.persist) await s.persist(); } catch { /* Status kommt aus persisted() */ }
  let persistiert = null;
  try { if (s.persisted) persistiert = await s.persisted(); } catch { /* bleibt unbekannt */ }
  let belegt = null, quota = null;
  try { if (s.estimate) ({ usage: belegt = null, quota = null } = await s.estimate()); } catch { /* bleibt unbekannt */ }
  return { persistiert, belegt, quota };
}

/* ---------- Geräte ---------- */
export const alleGeraete = () => aktion(["geraete"], "readonly", (s) => s.geraete.getAll());
export const holeGeraet = (id) => aktion(["geraete"], "readonly", (s) => s.geraete.get(id));
export const speichereGeraet = (g) => aktion(["geraete"], "readwrite", (s) => { s.geraete.put(g); });

// Löscht das Gerät mit seinen Fotos in einer Transaktion
export const loescheGeraet = (g) => aktion(["geraete", "fotos"], "readwrite", (s) => {
  s.geraete.delete(g.id);
  for (const schluessel of Object.values(g.fotos)) if (schluessel !== null) s.fotos.delete(schluessel);
});

/* ---------- Fotos ---------- */
export const holeFoto = (schluessel) => aktion(["fotos"], "readonly", (s) => s.fotos.get(schluessel)).then((b) => b ?? null);
export const speichereFoto = (schluessel, blob) => aktion(["fotos"], "readwrite", (s) => { s.fotos.put(blob, schluessel); });
export const loescheFoto = (schluessel) => aktion(["fotos"], "readwrite", (s) => { s.fotos.delete(schluessel); });

// Gerät und Foto zusammen speichern (neues Foto aufgenommen)
export const speichereGeraetMitFoto = (g, schluessel, blob) => aktion(["geraete", "fotos"], "readwrite", (s) => {
  s.fotos.put(blob, schluessel);
  s.geraete.put(g);
});

/* ---------- Einstellungen ---------- */
export const holeEinstellung = (name) => aktion(["einstellungen"], "readonly", (s) => s.einstellungen.get(name));
export const setzeEinstellung = (name, wert) => aktion(["einstellungen"], "readwrite", (s) => { s.einstellungen.put(wert, name); });
export const loescheEinstellung = (name) => aktion(["einstellungen"], "readwrite", (s) => { s.einstellungen.delete(name); });

/* ---------- Wiederherstellen ---------- */
// Ersetzt alle Geräte und Fotos in einer Transaktion (alles oder nichts); Einstellungen bleiben.
// geraete und fotos (Map schlüssel → Blob) kommen aus sicherung.liesSicherung ohne Fehler.
export const ersetzeAlles = (geraete, fotos) => aktion(["geraete", "fotos"], "readwrite", (s) => {
  s.geraete.clear();
  s.fotos.clear();
  for (const g of geraete) s.geraete.put(g);
  for (const [schluessel, blob] of fotos) s.fotos.put(blob, schluessel);
});
