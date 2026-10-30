// Datenmodell der Geräte (E6, E9, E18), beschrieben in DATENMODELL.md. Reine Logik ohne DOM.

// Textfelder nach E6 in der Reihenfolge der Oberfläche; zubehoer ist eine Liste von Texten
export const FELDER = [
  "inventarnummer", "bezeichnung", "hersteller", "modell", "seriennummer", "zustand", "zubehoer", "notiz",
  "leistung", "spannung", "baujahr", "artikelnummer", "standort",
];

export const FELD_NAMEN = {
  inventarnummer: "Inventarnummer", bezeichnung: "Bezeichnung", hersteller: "Hersteller", modell: "Modell",
  seriennummer: "Seriennummer", zustand: "Zustand", zubehoer: "Zubehör", notiz: "Notiz", leistung: "Leistung",
  spannung: "Spannung", baujahr: "Baujahr", artikelnummer: "Artikelnummer", standort: "Standort",
};

// Wie im Kleingewerbe-Helfer (src/csv.js, ZUSTAND_NAMEN), damit der CSV-Import sie erkennt
export const ZUSTAENDE = ["neu", "sehr gut", "gut", "mit Gebrauchsspuren", "reparaturbedürftig"];

export const FOTO_ARTEN = ["maschine", "typenschild"];
export const AUSLESEN_STATUS = ["offen", "laeuft", "fertig", "fehler"];

/* ---------- Inventarnummer (E9, E16) ---------- */
const NUMMER = /^INV-(?!0000)\d{4}$/;

// Genau das Format von Etikett und QR-Code: „INV-“ plus vier Ziffern, ab INV-0001
export const istNummer = (text) => typeof text === "string" && NUMMER.test(text);

// Eingabe von Hand → „INV-0012“: „inv 12“, „INV12“, „12“, „ INV-0012 “; sonst (auch bei 0) null
export function normalisiereNummer(text) {
  const m = /^\s*(?:INV[\s-]*)?(\d{1,4})\s*$/i.exec(String(text ?? ""));
  return m && Number(m[1]) > 0 ? "INV-" + m[1].padStart(4, "0") : null;
}

// Kleinste Nummer ab INV-0001, die noch kein Gerät trägt
export function naechsteNummer(geraete) {
  const belegt = new Set(geraete.map((g) => g.inventarnummer));
  for (let n = 1; n <= 9999; n++) {
    const nr = "INV-" + String(n).padStart(4, "0");
    if (!belegt.has(nr)) return nr;
  }
  throw new Error("Alle Nummern von INV-0001 bis INV-9999 sind vergeben");
}

/* ---------- Gerät ---------- */
// Schlüssel eines Fotos in der Ablage und Dateiname in der Sicherung (fotos/<schlüssel>.jpg)
export const fotoSchluessel = (id, art) => `${id}-${art}`;

export function neuesGeraet(inventarnummer, jetzt = new Date(), id = crypto.randomUUID()) {
  if (!istNummer(inventarnummer)) throw new Error(`„${inventarnummer}“ ist keine Inventarnummer (Format INV-0001)`);
  const zeit = jetzt.toISOString();
  const g = { id };
  for (const f of FELDER) g[f] = f === "zubehoer" ? [] : "";
  g.inventarnummer = inventarnummer;
  g.fotos = { maschine: null, typenschild: null };
  g.auslesen = { status: "offen", fehler: "", zeit: null, vorschlag: null, aufrufe: [], kostenCent: 0 };
  g.erstellt = zeit;
  g.geaendert = zeit;
  return g;
}

// Neues Gerät-Objekt mit den Änderungen und neuem Zeitstempel; das alte bleibt unverändert
export function aendere(g, aenderungen, jetzt = new Date()) {
  return { ...structuredClone(g), ...structuredClone(aenderungen), geaendert: jetzt.toISOString() };
}

/* ---------- Typenschild auslesen (E11, E18) ---------- */
// Steht das Auslesen noch aus? Nur mit Typenschild-Foto; „laeuft“ zählt nicht, „fehler“ kommt erneut dran.
export const auslesenOffen = (g) => g.fotos.typenschild !== null && (g.auslesen.status === "offen" || g.auslesen.status === "fehler");

export const auslesenStart = (g, jetzt = new Date()) =>
  aendere(g, { auslesen: { ...g.auslesen, status: "laeuft", fehler: "" } }, jetzt);

// Bezahlter Aufruf (mit usage) kommt in die Liste und in die Summe; ohne usage (kein Netz, HTTP-Fehler) bleibt alles gleich
function mitAufruf(auslesen, { usage = null, kostenCent = 0 } = {}, zeit) {
  if (!usage) return { aufrufe: auslesen.aufrufe, kostenCent: auslesen.kostenCent };
  return { aufrufe: [...auslesen.aufrufe, { zeit, usage, kostenCent }], kostenCent: auslesen.kostenCent + kostenCent };
}

// ergebnis von typenschild.js: { felder, usage, kostenCent }. Die Felder bleiben Vorschlag, bis der Nutzer sie übernimmt.
export function auslesenFertig(g, ergebnis, jetzt = new Date()) {
  const zeit = jetzt.toISOString();
  return aendere(g, {
    auslesen: { status: "fertig", fehler: "", zeit, vorschlag: ergebnis.felder ?? {}, ...mitAufruf(g.auslesen, ergebnis, zeit) },
  }, jetzt);
}

// fehler: Text oder Fehler von typenschild.js (TypenschildFehler mit message, usage, kostenCent). Hat die API trotz Fehler
// geantwortet (kaputtes JSON, refusal, max_tokens), ist der Aufruf bezahlt und wird wie beim Erfolg gezählt (E18).
export function auslesenFehler(g, fehler, jetzt = new Date()) {
  const zeit = jetzt.toISOString();
  const text = typeof fehler === "string" ? fehler : String(fehler?.message ?? fehler);
  const bezahlt = typeof fehler === "object" && fehler ? fehler : {};
  return aendere(g, {
    auslesen: { ...g.auslesen, status: "fehler", fehler: text, zeit, ...mitAufruf(g.auslesen, bezahlt, zeit) },
  }, jetzt);
}

/* ---------- Suche ---------- */
const klein = (t) => String(t).toLocaleLowerCase("de");

// Alle Wörter der Suche müssen irgendwo in den Textfeldern vorkommen (Groß-/Kleinschreibung egal)
export function suche(geraete, text) {
  const woerter = klein(text).split(/\s+/).filter(Boolean);
  if (!woerter.length) return geraete.slice();
  return geraete.filter((g) => {
    const alles = klein(FELDER.map((f) => (f === "zubehoer" ? g.zubehoer.join(" ") : g[f])).join("\n"));
    return woerter.every((w) => alles.includes(w));
  });
}

// Ortsdatum JJJJ-MM-TT für Dateinamen
export const tagText = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export const nachNummer = (geraete) => geraete.slice().sort((a, b) => a.inventarnummer.localeCompare(b.inventarnummer));

/* ---------- Sicherung ---------- */
const AUSLESEN_FELDER = ["status", "fehler", "zeit", "vorschlag", "aufrufe", "kostenCent"];
const nur = (o, namen) => Object.fromEntries(namen.filter((n) => n in o).map((n) => [n, structuredClone(o[n])]));

// Kopie nur mit den Feldern des Datenmodells; was sonst am Objekt hängt (z. B. ein versehentlich gesetzter Schlüssel), fällt weg (E15)
export function nurDatenmodell(g) {
  const kopie = nur(g, ["id", ...FELDER, "erstellt", "geaendert"]);
  kopie.fotos = Object.fromEntries(FOTO_ARTEN.map((a) => [a, g.fotos?.[a] ?? null]));
  kopie.auslesen = nur(g.auslesen ?? {}, AUSLESEN_FELDER);
  return kopie;
}

/* ---------- Prüfen (Wiederherstellen) ---------- */
const istZeit = (t) => typeof t === "string" && !Number.isNaN(Date.parse(t));

// Liste von Fehlertexten; leer, wenn das Gerät dem Datenmodell entspricht
export function pruefeGeraet(g) {
  if (!g || typeof g !== "object" || Array.isArray(g)) return ["kein Gerät"];
  const fehler = [];
  const wer = istNummer(g.inventarnummer) ? g.inventarnummer : `Gerät ${g.id ?? "ohne id"}`;
  if (typeof g.id !== "string" || !/^[A-Za-z0-9-]+$/.test(g.id)) fehler.push(`${wer}: id fehlt oder enthält unerlaubte Zeichen`);
  if (!istNummer(g.inventarnummer)) fehler.push(`${wer}: Inventarnummer „${g.inventarnummer}“ hat nicht das Format INV-0001`);
  for (const f of FELDER) {
    if (f === "zubehoer") {
      if (!Array.isArray(g.zubehoer) || g.zubehoer.some((z) => typeof z !== "string")) fehler.push(`${wer}: Zubehör ist keine Liste von Texten`);
    } else if (typeof g[f] !== "string") fehler.push(`${wer}: ${FELD_NAMEN[f]} ist kein Text`);
  }
  if (!g.fotos || FOTO_ARTEN.some((a) => g.fotos[a] !== null && g.fotos[a] !== fotoSchluessel(g.id, a))) {
    fehler.push(`${wer}: Fotoverweise passen nicht zur id`);
  }
  const a = g.auslesen;
  if (!a || !AUSLESEN_STATUS.includes(a.status) || !Array.isArray(a.aufrufe) || typeof a.kostenCent !== "number") {
    fehler.push(`${wer}: Angaben zum Auslesen fehlen oder sind ungültig`);
  }
  if (!istZeit(g.erstellt) || !istZeit(g.geaendert)) fehler.push(`${wer}: Zeitstempel erstellt/geaendert fehlen`);
  return fehler;
}
