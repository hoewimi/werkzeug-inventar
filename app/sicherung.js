// Sicherung als ZIP und Wiederherstellen (E4, E25), Aufbau in DATENMODELL.md. Ohne DOM; das Teilen (navigator.share) und
// das Schreiben in die Ablage macht die Oberfläche. Der API-Schlüssel liegt in den Einstellungen und kommt nie hinein (E15).

import { bauZip, liesZip } from "./zip.js";
import { FOTO_ARTEN, nurDatenmodell, pruefeGeraet, tagText } from "./daten.js";

export const FORMAT = 1;
const DATEN = "daten.json";
const fotoPfad = (schluessel) => `fotos/${schluessel}.jpg`;

export const sicherungsName = (jetzt = new Date()) => `werkzeug-inventar-${tagText(jetzt)}.zip`;

// geraete: alle Geräte; holeFoto(schluessel) → Blob oder null (aus der Ablage).
// Ergebnis: { datei (File, application/zip), geraete, fotos, fehlendeFotos: [schlüssel] }.
// Ein Foto, das in der Ablage fehlt, wird in der Sicherung als nicht vorhanden (null) eingetragen.
// Nur Felder des Datenmodells kommen hinein (nurDatenmodell).
export async function baueSicherung(geraete, holeFoto, jetzt = new Date()) {
  const kopie = geraete.map(nurDatenmodell);
  const fotos = [];
  const fehlendeFotos = [];
  for (const g of kopie) {
    for (const art of FOTO_ARTEN) {
      const schluessel = g.fotos[art];
      if (schluessel === null) continue;
      const blob = await holeFoto(schluessel);
      if (blob) fotos.push({ name: fotoPfad(schluessel), daten: blob });
      else { fehlendeFotos.push(schluessel); g.fotos[art] = null; }
    }
  }
  const json = JSON.stringify({ format: FORMAT, erstellt: jetzt.toISOString(), geraete: kopie }, null, 1);
  const zip = await bauZip([{ name: DATEN, daten: json }, ...fotos], jetzt);
  const datei = new File([zip], sicherungsName(jetzt), { type: "application/zip" });
  return { datei, geraete: kopie.length, fotos: fotos.length, fehlendeFotos };
}

// datei: File/Blob der gewählten ZIP. Prüft alles, bevor etwas geschrieben wird.
// Ergebnis: { erstellt, geraete, fotos: Map(schlüssel → Blob image/jpeg), fehler: [Text], hinweise: [Text] }.
// Nur wenn fehler leer ist, darf die Oberfläche wiederherstellen.
export async function liesSicherung(datei) {
  const aus = { erstellt: null, geraete: [], fotos: new Map(), fehler: [], hinweise: [] };
  let eintraege;
  try { eintraege = await liesZip(datei); } catch (e) { aus.fehler.push(`Die Datei ist keine lesbare ZIP-Datei (${e.message}).`); return aus; }

  const kaputt = eintraege.filter((e) => !e.ok);
  for (const e of kaputt) aus.fehler.push(`${e.name}: ${e.fehler ?? "Prüfsumme stimmt nicht, die Datei ist beschädigt"}.`);
  const daten = eintraege.find((e) => e.name === DATEN);
  if (!daten) { aus.fehler.push(`In der ZIP fehlt ${DATEN}; das ist keine Sicherung des Werkzeug-Inventars.`); return aus; }
  if (kaputt.length) return aus;

  let inhalt;
  try { inhalt = JSON.parse(await daten.daten.text()); } catch { aus.fehler.push(`${DATEN} ist kein gültiges JSON.`); return aus; }
  if (!inhalt || inhalt.format !== FORMAT) { aus.fehler.push(`Unbekanntes Format ${inhalt?.format} (erwartet ${FORMAT}).`); return aus; }
  if (!Array.isArray(inhalt.geraete)) { aus.fehler.push(`In ${DATEN} fehlt die Liste der Geräte.`); return aus; }

  const ids = new Set();
  const nummern = new Set();
  for (const g of inhalt.geraete) {
    const f = pruefeGeraet(g);
    aus.fehler.push(...f);
    if (f.length) continue;
    if (ids.has(g.id)) aus.fehler.push(`id ${g.id} kommt doppelt vor.`);
    if (nummern.has(g.inventarnummer)) aus.fehler.push(`${g.inventarnummer} kommt doppelt vor.`);
    ids.add(g.id);
    nummern.add(g.inventarnummer);
  }
  if (aus.fehler.length) return aus;

  const dateien = new Map(eintraege.map((e) => [e.name, e]));
  for (const g of inhalt.geraete) {
    for (const art of FOTO_ARTEN) {
      const schluessel = g.fotos[art];
      if (schluessel === null) continue;
      const e = dateien.get(fotoPfad(schluessel));
      if (e) aus.fotos.set(schluessel, e.daten.slice(0, e.daten.size, "image/jpeg"));
      else { aus.hinweise.push(`${g.inventarnummer}: Foto ${art} fehlt in der Sicherung.`); g.fotos[art] = null; }
    }
  }
  const bekannt = new Set([DATEN, ...[...aus.fotos.keys()].map(fotoPfad)]);
  const fremd = eintraege.filter((e) => !bekannt.has(e.name) && !e.name.endsWith("/"));
  if (fremd.length) aus.hinweise.push(`Diese Dateien in der ZIP werden übergangen: ${fremd.map((e) => e.name).join(", ")}.`);

  aus.erstellt = typeof inhalt.erstellt === "string" ? inhalt.erstellt : null;
  aus.geraete = inhalt.geraete.map(nurDatenmodell);
  return aus;
}

// Text für die Rückfrage, wenn auf dem iPhone schon Geräte liegen; null, wenn keine Rückfrage nötig ist.
// Wiederherstellen ersetzt alle Geräte und Fotos (ablage.ersetzeAlles).
export function rueckfrage(vorhandeneAnzahl, gelesen) {
  if (!vorhandeneAnzahl) return null;
  const n = (k) => (k === 1 ? "1 Gerät" : `${k} Geräte`);
  const vom = gelesen.erstellt ? ` vom ${new Date(gelesen.erstellt).toLocaleDateString("de-DE")}` : "";
  return `Auf diesem iPhone sind ${n(vorhandeneAnzahl)} gespeichert. Die Sicherung${vom} enthält ${n(gelesen.geraete.length)}. `
    + "Wiederherstellen ersetzt alle Geräte und Fotos auf diesem iPhone. Fortfahren?";
}

/* ---------- Erinnerung (E4) ---------- */
export const ERINNERUNG_TAGE = 7;
export const ERINNERUNG_NEUE = 10;
const TAG_MS = 24 * 3600 * 1000;

// letzteSicherung: ISO-Zeit der letzten Sicherung oder null (noch nie gesichert; ein ungültiger Text zählt ebenso).
// Fällig nach 10 neuen Geräten seit der letzten Sicherung, oder nach 7 Tagen, wenn seitdem etwas neu oder geändert ist.
// Ohne Sicherung zählen die 7 Tage ab dem ersten Gerät. Ergebnis: { faellig, neue, geaendert, tage }
export function erinnerung(geraete, letzteSicherung, jetzt = new Date()) {
  const zuletzt = letzteSicherung ? Date.parse(letzteSicherung) : NaN;
  const gesichert = !Number.isNaN(zuletzt);
  const seit = gesichert ? zuletzt : Math.min(...geraete.map((g) => Date.parse(g.erstellt)));
  const neue = geraete.filter((g) => !gesichert || Date.parse(g.erstellt) > seit).length;
  const geaendert = geraete.filter((g) => !gesichert || Date.parse(g.geaendert) > seit).length;
  const tage = geraete.length || gesichert ? Math.floor((jetzt.getTime() - seit) / TAG_MS) : 0;
  const faellig = neue >= ERINNERUNG_NEUE || (geaendert > 0 && tage >= ERINNERUNG_TAGE);
  return { faellig, neue, geaendert, tage };
}
