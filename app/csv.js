// CSV-Export für den Kleingewerbe-Helfer (E17): Semikolon, UTF-8 mit BOM, Anführungszeichen nach RFC 4180, Zeilenende CRLF
// wie in dessen eigenem Export. Zuerst die 20 Spalten von KH vorlagen/erstimport.csv, dann die Zusatzspalten. Reine Logik ohne DOM.

import { nachNummer, tagText } from "./daten.js";

const BOM = "\uFEFF";
const TRENNER = ";";
const ZEILENENDE = "\r\n";

// Kopfzeile von hoewimi/kleingewerbe-helfer vorlagen/erstimport.csv, Reihenfolge und Schreibweise unverändert
export const KH_SPALTEN = [
  "Bezeichnung", "Hersteller", "Modell", "Seriennummer", "Herkunft", "Kaufdatum", "Kaufdatum geschätzt", "Kaufpreis",
  "Nebenkosten", "Umsatzsteuer ausgewiesen", "Verkäufer", "Einlagedatum", "Teilwert", "Selbstständig nutzbar", "Zustand",
  "Zubehör", "Betriebliche Verwendung", "Privatanteil %", "Privatanteil Begründung", "Notiz",
];
export const ZUSATZ_SPALTEN = ["Inventarnummer", "Leistung", "Spannung", "Baujahr", "Artikelnummer", "Standort"];
export const SPALTEN = [...KH_SPALTEN, ...ZUSATZ_SPALTEN];

// "Bohrer; groß" → "\"Bohrer; groß\""
function feld(w) {
  const t = String(w ?? "");
  return /[";\r\n]/.test(t) || t !== t.trim() ? '"' + t.replace(/"/g, '""') + '"' : t;
}

// Notiz beginnt mit der Inventarnummer, damit die Verbindung im KH erhalten bleibt: „INV-0001 · …“
const notizMitNummer = (g) => (g.notiz.trim() ? `${g.inventarnummer} · ${g.notiz}` : g.inventarnummer);

// Der KH-Import trennt Zubehör an „|“ und Zeilenumbruch; darum im Teil „|“ → „/“ und Umbruch → Leerzeichen
const zubehoerTeil = (t) => t.replace(/\|/g, "/").replace(/\s*[\r\n]+\s*/g, " ").trim();

function zeile(g) {
  return {
    "Bezeichnung": g.bezeichnung, "Hersteller": g.hersteller, "Modell": g.modell, "Seriennummer": g.seriennummer,
    "Zustand": g.zustand, "Zubehör": g.zubehoer.map(zubehoerTeil).filter(Boolean).join(" | "), "Notiz": notizMitNummer(g),
    "Inventarnummer": g.inventarnummer, "Leistung": g.leistung, "Spannung": g.spannung, "Baujahr": g.baujahr,
    "Artikelnummer": g.artikelnummer, "Standort": g.standort,
  };
}

// Geräte → CSV-Text, nach Inventarnummer sortiert
export function exportCsv(geraete) {
  const zeilen = [SPALTEN, ...nachNummer(geraete).map((g) => { const z = zeile(g); return SPALTEN.map((s) => z[s]); })];
  return BOM + zeilen.map((z) => z.map(feld).join(TRENNER)).join(ZEILENENDE) + ZEILENENDE;
}

export const csvName = (jetzt = new Date()) => `werkzeug-inventar-${tagText(jetzt)}.csv`;

// Als File für navigator.share (E25)
export const csvDatei = (geraete, jetzt = new Date()) =>
  new File([exportCsv(geraete)], csvName(jetzt), { type: "text/csv;charset=utf-8" });
