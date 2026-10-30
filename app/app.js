// Oberfläche des Werkzeug-Inventars (P8): Liste, Gerät, Scanner, Einstellungen, Sicherung, Export, Warteschlange fürs
// Typenschild. Die Logik liegt in den Modulen (DATENMODELL.md); hier nur DOM, Abläufe und Texte. Abläufe für Kamera,
// Teilen und Service Worker stammen aus der iPhone-Probe (E22–E27).

import * as ablage from "./ablage.js";
import {
  ZUSTAENDE, FELD_NAMEN, normalisiereNummer, naechsteNummer, neuesGeraet, aendere, fotoSchluessel, istNummer,
  auslesenOffen, auslesenStart, auslesenFertig, auslesenFehler, suche, nachNummer,
} from "./daten.js";
import { verkleinere } from "./bild.js";
import { csvDatei } from "./csv.js";
import { baueSicherung, liesSicherung, rueckfrage, erinnerung } from "./sicherung.js";
import { liesTypenschild, TypenschildFehler, FEHLER, FELDER as SCHILD_FELDER } from "./typenschild.js";

// Muss zur Zahl im Cache-Namen von sw.js passen (tests/oberflaeche.test.js)
const VERSION = 1;

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const zustand = {
  geraete: new Map(), // id → Gerät
  entwurf: null, // neues Gerät, noch nicht gespeichert
  offenId: null, // Gerät in der Ansicht „geraet“
  ansicht: null,
  vonListe: false, // zurück per history.back()
  schluessel: false, // API-Schlüssel vorhanden
  letzteSicherung: null,
  speicher: null, // { persistiert, belegt, quota }
  bannerWeg: false,
  vorrang: null, // Gerät, das die Warteschlange zuerst ausliest
};

/* ---------- Texte ---------- */
const zahl = (n) => n.toLocaleString("de-DE");
const anzahl = (n, eins, viele) => `${zahl(n)} ${n === 1 ? eins : viele}`;
const geraeteText = (n) => anzahl(n, "Gerät", "Geräte");
const cent = (c) => `${c.toLocaleString("de-DE", { minimumFractionDigits: 3, maximumFractionDigits: 3 })} US-Cent`;
const zeitText = (iso) => new Date(iso).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const groesse = (b) => (b >= 1e9
  ? `${(b / 1e9).toLocaleString("de-DE", { maximumFractionDigits: 1 })} GB`
  : `${(b / 1e6).toLocaleString("de-DE", { maximumFractionDigits: 1 })} MB`);

let meldungUhr = null;
function meldung(text, art = "") {
  const m = $("#meldung");
  m.textContent = text;
  m.className = `meldung ${art}`;
  m.hidden = false;
  clearTimeout(meldungUhr);
  meldungUhr = setTimeout(() => (m.hidden = true), art === "fehler" ? 6000 : 3500);
}
$("#meldung").addEventListener("click", () => ($("#meldung").hidden = true));

/* ---------- Speichern (eine Kette, damit Formular und Warteschlange sich nicht überschreiben) ---------- */
let kette = Promise.resolve();

// fn(altesGerät) → neues Gerät (oder dasselbe, dann wird nichts gespeichert). foto: { schluessel, blob } dazu.
// Ein Entwurf wird beim ersten Speichern zum Gerät.
function aktualisiere(id, fn, foto = null) {
  const lauf = kette.then(async () => {
    const entwurf = zustand.entwurf?.id === id ? zustand.entwurf : null;
    const alt = entwurf ?? zustand.geraete.get(id);
    if (!alt) throw new Error("Das Gerät gibt es nicht mehr.");
    const neu = fn(alt);
    if (neu === alt && !foto) return alt;
    if (foto) await ablage.speichereGeraetMitFoto(neu, foto.schluessel, foto.blob);
    else await ablage.speichereGeraet(neu);
    zustand.geraete.set(id, neu);
    if (entwurf) {
      zustand.entwurf = null;
      history.replaceState(history.state, "", `#/geraet/${id}`);
    }
    return neu;
  });
  kette = lauf.catch(() => {});
  lauf.then(nachAenderung, (e) => meldung(`Nicht gespeichert: ${e.message}`, "fehler"));
  return lauf;
}

function nachAenderung(g) {
  if (zustand.ansicht === "liste") zeigeListe();
  if (zustand.ansicht === "geraet" && g.id === zustand.offenId) zeigeGeraetTeile(g);
  if (zustand.ansicht === "einstellungen") zeigeEinstellungen();
}

const aktuelles = () => (zustand.entwurf?.id === zustand.offenId ? zustand.entwurf : zustand.geraete.get(zustand.offenId));
const mitNummer = (nr) => [...zustand.geraete.values()].find((g) => g.inventarnummer === nr);

/* ---------- Fotos als Adresse (Vorschau und Gerät) ---------- */
const fotoUrls = new Map(); // schlüssel → object URL

async function fotoUrl(schluessel) {
  if (!fotoUrls.has(schluessel)) {
    const blob = await ablage.holeFoto(schluessel);
    if (!blob) return null;
    fotoUrls.set(schluessel, URL.createObjectURL(blob));
  }
  return fotoUrls.get(schluessel);
}
function vergissFoto(schluessel) {
  const url = fotoUrls.get(schluessel);
  if (url) URL.revokeObjectURL(url);
  fotoUrls.delete(schluessel);
}
function vergissAlleFotos() {
  for (const s of [...fotoUrls.keys()]) vergissFoto(s);
}

/* ---------- Ansichten und Navigation ---------- */
function zeigeAnsicht(name) {
  if (zustand.ansicht === "geraet" && name !== "geraet") speichereOffeneFelder();
  zustand.ansicht = name;
  for (const a of $$(".ansicht")) a.hidden = a.id !== name;
  window.scrollTo(0, 0);
}

function geh(hash) {
  zustand.vonListe = true;
  location.hash = hash;
}
function zurueck() {
  if (zustand.vonListe) history.back();
  else location.replace("#/");
}
for (const b of $$("[data-zurueck]")) b.addEventListener("click", zurueck);

function route() {
  scannerStopp();
  $("#bildansicht").hidden = true;
  const h = location.hash;
  let m;
  if ((m = /^#\/geraet\/([A-Za-z0-9-]+)$/.exec(h))) {
    const g = zustand.geraete.get(m[1]) ?? (zustand.entwurf?.id === m[1] ? zustand.entwurf : null);
    if (!g) return location.replace("#/");
    zeigeAnsicht("geraet");
    oeffneGeraet(g);
  } else if ((m = /^#\/neu\/(INV-\d{4})$/.exec(h)) && istNummer(m[1])) {
    const vorhanden = mitNummer(m[1]);
    if (vorhanden) return location.replace(`#/geraet/${vorhanden.id}`);
    if (zustand.entwurf?.inventarnummer !== m[1]) zustand.entwurf = neuesGeraet(m[1]);
    zeigeAnsicht("geraet");
    oeffneGeraet(zustand.entwurf);
  } else if (h === "#/einstellungen") {
    zeigeAnsicht("einstellungen");
    zeigeEinstellungen();
  } else {
    zustand.vonListe = false;
    zustand.entwurf = null;
    zeigeAnsicht("liste");
    zeigeListe();
  }
}
window.addEventListener("hashchange", route);

function oeffneNummer(nr) {
  const g = mitNummer(nr);
  if (g) geh(`#/geraet/${g.id}`);
  else {
    geh(`#/neu/${nr}`);
    meldung(`${nr} ist neu. Fotos machen und Angaben eintragen.`);
  }
}

/* ---------- Liste ---------- */
const beobachter = "IntersectionObserver" in window
  ? new IntersectionObserver((eintraege) => {
    for (const e of eintraege) if (e.isIntersecting) { beobachter.unobserve(e.target); ladeVorschau(e.target); }
  }, { rootMargin: "400px" })
  : null;

async function ladeVorschau(img) {
  const url = await fotoUrl(img.dataset.foto).catch(() => null);
  if (url) img.src = url;
}

function auslesenMarke(g) {
  if (g.fotos.typenschild === null) return null;
  const a = g.auslesen;
  if (a.status === "laeuft") return ["laeuft", "liest …"];
  if (a.status === "offen") return ["wartet", "wartet"];
  if (a.status === "fehler") return ["fehler", "Fehler"];
  if (a.vorschlag) return ["vorschlag", "Vorschlag"];
  return null;
}

function zeile(g) {
  const li = document.createElement("li");
  const b = document.createElement("button");
  b.dataset.id = g.id;
  const bild = document.createElement("img");
  bild.className = "vorschau";
  bild.alt = "";
  if (g.fotos.maschine) {
    bild.dataset.foto = g.fotos.maschine;
    if (beobachter) beobachter.observe(bild); else ladeVorschau(bild);
  }
  const text = document.createElement("span");
  text.className = "zeile-text";
  const kopf = document.createElement("span");
  kopf.className = "zeile-kopf";
  const nummer = document.createElement("span");
  nummer.className = "zeile-nummer";
  nummer.textContent = g.inventarnummer;
  kopf.append(nummer);
  const marke = auslesenMarke(g);
  if (marke) {
    const m = document.createElement("span");
    m.className = `marke ${marke[0]}`;
    m.textContent = marke[1];
    kopf.append(m);
  }
  const titel = document.createElement("span");
  titel.className = "zeile-titel";
  titel.textContent = g.bezeichnung || "ohne Bezeichnung";
  const unter = document.createElement("span");
  unter.className = "zeile-unter";
  unter.textContent = [[g.hersteller, g.modell].filter(Boolean).join(" "), g.standort].filter(Boolean).join(" · ") || " ";
  text.append(kopf, titel, unter);
  b.append(bild, text);
  li.append(b);
  return li;
}

function zeigeListe() {
  const alle = nachNummer([...zustand.geraete.values()]);
  const treffer = suche(alle, $("#suche").value);
  const offen = alle.filter((g) => auslesenOffen(g) || (g.fotos.typenschild && g.auslesen.status === "laeuft")).length;
  const teile = [$("#suche").value.trim() ? `${zahl(treffer.length)} von ${anzahl(alle.length, "Gerät", "Geräten")}` : geraeteText(alle.length)];
  if (offen) teile.push(`${zahl(offen)} offen beim Auslesen`);
  $("#zaehler").textContent = teile.join(" · ");
  $("#zaehler").hidden = !alle.length;
  $("#leer").hidden = alle.length > 0;
  $("#geraeteliste").replaceChildren(...treffer.map(zeile));
  zeigeBanner();
}

$("#suche").addEventListener("input", zeigeListe);
$("#geraeteliste").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-id]");
  if (b) geh(`#/geraet/${b.dataset.id}`);
});
$("#neues-geraet").addEventListener("click", () => geh(`#/neu/${naechsteNummer([...zustand.geraete.values()])}`));
$("#zu-einstellungen").addEventListener("click", () => geh("#/einstellungen"));

/* ---------- Erinnerung an die Sicherung (E4, E24) ---------- */
function sicherungFaellig() {
  const alle = [...zustand.geraete.values()];
  if (!alle.length) return null;
  const e = erinnerung(alle, zustand.letzteSicherung);
  // Ohne bestätigten dauerhaften Speicher früher erinnern (E24): ab 5 neuen Geräten oder nach einem Tag mit Änderungen
  const unsicher = zustand.speicher?.persistiert === false;
  const faellig = e.faellig || (unsicher && (e.neue >= 5 || (e.geaendert > 0 && e.tage >= 1)));
  return faellig ? { ...e, unsicher } : null;
}

function zeigeBanner() {
  const f = zustand.bannerWeg ? null : sicherungFaellig();
  $("#banner-sicherung").hidden = !f;
  if (!f) return;
  $("#banner-sicherung").classList.toggle("stark", f.unsicher);
  const teile = [];
  if (!zustand.letzteSicherung) teile.push(`Noch keine Sicherung. ${geraeteText(zustand.geraete.size)} liegen nur auf diesem iPhone.`);
  else {
    const seit = [];
    if (f.neue) seit.push(anzahl(f.neue, "neues Gerät", "neue Geräte"));
    if (f.geaendert > f.neue) seit.push(`${zahl(f.geaendert - f.neue)} geändert`);
    teile.push(`Letzte Sicherung vor ${anzahl(f.tage, "Tag", "Tagen")}${seit.length ? `, seitdem ${seit.join(", ")}` : ""}.`);
  }
  if (f.unsicher) teile.push("iOS hat den dauerhaften Speicher nicht bestätigt und darf die Daten bei Platzmangel löschen.");
  $("#banner-text").textContent = teile.join(" ");
}
$("#banner-spaeter").addEventListener("click", () => { zustand.bannerWeg = true; zeigeBanner(); });
$("#banner-sichern").addEventListener("click", () => { geh("#/einstellungen"); sichern(); });

/* ---------- Gerät ---------- */
const form = $("#felder");
const zustandFeld = form.elements.zustand;
zustandFeld.append(new Option("nicht angegeben", ""), ...ZUSTAENDE.map((z) => new Option(z, z)));

let gezeigterVorschlag = null; // auslesen.zeit des gezeigten Vorschlags, damit Häkchen beim Neuzeichnen bleiben

function oeffneGeraet(g) {
  speichereOffeneFelder();
  zustand.offenId = g.id;
  gezeigterVorschlag = null;
  fuelleFelder(g);
  $("#nummer-fehler").hidden = true;
  zeigeGeraetTeile(g);
}

function fuelleFelder(g, nur = null) {
  for (const el of form.elements) {
    if (!el.name || (nur && !nur.includes(el.name))) continue;
    el.value = el.name === "zubehoer" ? g.zubehoer.join("\n") : g[el.name];
  }
}

function zeigeGeraetTeile(g) {
  const entwurf = zustand.entwurf?.id === g.id;
  $("#geraet-titel").textContent = g.inventarnummer;
  $("#entwurf-hinweis").hidden = !entwurf;
  $("#geraet-loeschen").hidden = entwurf;
  for (const art of ["maschine", "typenschild"]) zeigeFoto(g, art);
  zeigeAuslesen(g);
  const a = g.auslesen;
  $("#geraet-kosten").textContent = a.aufrufe.length
    ? `Typenschild bisher ${anzahl(a.aufrufe.length, "Mal", "Mal")} ausgelesen, ${cent(a.kostenCent)}.`
    : "";
}

async function zeigeFoto(g, art) {
  const flaeche = $(`[data-foto-zeigen="${art}"]`);
  const schluessel = g.fotos[art];
  const url = schluessel ? await fotoUrl(schluessel).catch(() => null) : null;
  if (zustand.offenId !== g.id) return;
  flaeche.style.backgroundImage = url ? `url("${url}")` : "";
  flaeche.classList.toggle("mit-bild", !!url);
  flaeche.dataset.url = url ?? "";
}

for (const flaeche of $$("[data-foto-zeigen]")) {
  flaeche.addEventListener("click", () => {
    if (flaeche.dataset.url) {
      $("#bildansicht-bild").src = flaeche.dataset.url;
      $("#bildansicht").hidden = false;
    } else $(`#foto-${flaeche.dataset.fotoZeigen}-kamera`).click();
  });
}
$("#bildansicht").addEventListener("click", () => ($("#bildansicht").hidden = true));

// Fotos (E7, E22): verkleinern, mit dem Gerät speichern. Ein neues Typenschild-Foto wird neu ausgelesen.
const fotoStand = new Map(); // id → Zähler neuer Typenschild-Fotos, damit ein altes Ergebnis kein neues Foto überschreibt

for (const input of $$("input[data-foto]")) {
  input.addEventListener("change", async () => {
    const datei = input.files[0];
    input.value = "";
    if (!datei) return;
    const art = input.dataset.foto;
    const id = zustand.offenId;
    try {
      const { blob } = await verkleinere(datei);
      const schluessel = fotoSchluessel(id, art);
      vergissFoto(schluessel);
      if (art === "typenschild") fotoStand.set(id, (fotoStand.get(id) ?? 0) + 1);
      await aktualisiere(id, (g) => aendere(g, {
        fotos: { ...g.fotos, [art]: schluessel },
        ...(art === "typenschild" ? { auslesen: { ...g.auslesen, status: "offen", fehler: "", vorschlag: null } } : {}),
      }), { schluessel, blob });
      if (art === "typenschild") arbeiteWarteschlange();
    } catch (e) {
      meldung(`Das Foto wurde nicht gespeichert: ${e.message}`, "fehler");
    }
  });
}

// Felder: speichern kurz nach der Eingabe und beim Verlassen des Feldes
const feldUhren = new Map();
form.addEventListener("submit", (e) => e.preventDefault());
form.addEventListener("input", (e) => {
  const el = e.target;
  if (!el.name || el.name === "inventarnummer") return;
  clearTimeout(feldUhren.get(el.name));
  feldUhren.set(el.name, setTimeout(() => speichereFeld(el), 600));
});
form.addEventListener("change", (e) => {
  if (e.target.name === "inventarnummer") aendereNummer(e.target);
  else if (e.target.name) speichereFeld(e.target);
});

function feldWert(el) {
  if (el.name === "zubehoer") return el.value.split("\n").map((z) => z.trim()).filter(Boolean);
  return el.value.trim();
}

function speichereFeld(el) {
  clearTimeout(feldUhren.get(el.name));
  feldUhren.delete(el.name);
  const g = aktuelles();
  if (!g) return;
  const wert = feldWert(el);
  if (JSON.stringify(wert) === JSON.stringify(g[el.name])) return;
  aktualisiere(g.id, (alt) => aendere(alt, { [el.name]: wert }));
}

function speichereOffeneFelder() {
  for (const name of [...feldUhren.keys()]) speichereFeld(form.elements[name]);
}

function aendereNummer(el) {
  const g = aktuelles();
  const fehler = $("#nummer-fehler");
  const nr = normalisiereNummer(el.value);
  const belegt = nr && nr !== g.inventarnummer ? mitNummer(nr) : null;
  if (!nr) fehler.textContent = "Bitte im Format INV-0001 eingeben.";
  else if (belegt) fehler.textContent = `${nr} hat schon ein anderes Gerät${belegt.bezeichnung ? ` (${belegt.bezeichnung})` : ""}.`;
  fehler.hidden = !!nr && !belegt;
  if (!nr || belegt) return;
  el.value = nr;
  if (nr !== g.inventarnummer) aktualisiere(g.id, (alt) => aendere(alt, { inventarnummer: nr }));
}

$("#geraet-loeschen").addEventListener("click", async () => {
  const g = aktuelles();
  if (!g || !confirm(`${g.inventarnummer} löschen? Angaben und Fotos sind danach weg.`)) return;
  for (const name of [...feldUhren.keys()]) clearTimeout(feldUhren.get(name));
  feldUhren.clear();
  await kette;
  try {
    await ablage.loescheGeraet(g);
    zustand.geraete.delete(g.id);
    for (const s of Object.values(g.fotos)) if (s) vergissFoto(s);
    meldung(`${g.inventarnummer} gelöscht.`);
    zurueck();
  } catch (e) {
    meldung(`Nicht gelöscht: ${e.message}`, "fehler");
  }
});

/* ---------- Typenschild auslesen (E11, E18, E27) ---------- */
function zeigeAuslesen(g) {
  const a = g.auslesen;
  const knopf = $("#auslesen-start");
  const hinweis = $("#auslesen-hinweis");
  const status = $("#auslesen-status");
  const mitFoto = g.fotos.typenschild !== null;
  knopf.disabled = !mitFoto || a.status === "laeuft";
  knopf.textContent = a.status === "laeuft" ? "Liest …" : a.status === "fertig" ? "Erneut auslesen" : "Typenschild auslesen";
  status.textContent = "";
  hinweis.textContent = "";
  if (!mitFoto) hinweis.textContent = "Erst das Typenschild fotografieren.";
  else if (a.status === "laeuft") status.textContent = "wird ausgelesen …";
  else if (a.status === "offen") {
    if (!zustand.schluessel) hinweis.textContent = "Kein API-Schlüssel. Bitte in den Einstellungen eingeben.";
    else if (!navigator.onLine) hinweis.textContent = "Offline. Das Typenschild wird ausgelesen, sobald das iPhone online ist.";
    else if (a.fehler) hinweis.textContent = `Wartet: ${a.fehler}`;
    else status.textContent = "wartet";
  } else if (a.status === "fehler") hinweis.textContent = `Fehler: ${a.fehler}`;
  else if (a.status === "fertig" && a.zeit) status.textContent = `ausgelesen ${zeitText(a.zeit)}`;
  zeigeVorschlag(g);
}

function zeigeVorschlag(g) {
  const a = g.auslesen;
  const v = a.status === "fertig" ? a.vorschlag : null;
  $("#vorschlag").hidden = !v;
  if (!v) { gezeigterVorschlag = null; return; }
  if (gezeigterVorschlag === a.zeit) return;
  gezeigterVorschlag = a.zeit;
  const felder = SCHILD_FELDER.filter((f) => v[f] && v[f] !== g[f]);
  const liste = felder.map((f) => {
    const li = document.createElement("li");
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.dataset.feld = f;
    box.checked = !g[f];
    const text = document.createElement("span");
    const name = document.createElement("span");
    name.className = "vorschlag-name";
    name.textContent = FELD_NAMEN[f];
    const wert = document.createElement("span");
    wert.className = "vorschlag-wert";
    wert.textContent = v[f];
    text.append(name, wert);
    if (g[f]) {
      const bisher = document.createElement("span");
      bisher.className = "vorschlag-bisher";
      bisher.textContent = `bisher: ${g[f]}`;
      text.append(bisher);
    }
    label.append(box, text);
    li.append(label);
    return li;
  });
  if (!liste.length) {
    const li = document.createElement("li");
    li.className = "hinweis";
    li.textContent = SCHILD_FELDER.some((f) => v[f])
      ? "Alles Lesbare steht schon in den Feldern."
      : "Auf dem Foto war nichts sicher lesbar. Vielleicht ein schärferes Foto machen.";
    liste.push(li);
  }
  $("#vorschlag-liste").replaceChildren(...liste);
  $("#vorschlag-uebernehmen").hidden = !felder.length;
  const letzter = a.aufrufe.at(-1);
  $("#vorschlag-kosten").textContent = letzter
    ? `Dieser Aufruf: ${zahl(letzter.usage.input_tokens || 0)} + ${zahl(letzter.usage.output_tokens || 0)} Token, ${cent(letzter.kostenCent)}.`
    : "";
}

$("#vorschlag-uebernehmen").addEventListener("click", () => {
  speichereOffeneFelder();
  const g = aktuelles();
  const v = g.auslesen.vorschlag;
  const werte = {};
  for (const box of $$("#vorschlag-liste input:checked")) werte[box.dataset.feld] = v[box.dataset.feld];
  aktualisiere(g.id, (alt) => aendere(alt, { ...werte, auslesen: { ...alt.auslesen, vorschlag: null } }))
    .then((neu) => { if (zustand.offenId === neu.id) fuelleFelder(neu, Object.keys(werte)); })
    .catch(() => {});
});
$("#vorschlag-verwerfen").addEventListener("click", () => {
  const g = aktuelles();
  aktualisiere(g.id, (alt) => aendere(alt, { auslesen: { ...alt.auslesen, vorschlag: null } })).catch(() => {});
});

$("#auslesen-start").addEventListener("click", async () => {
  const g = aktuelles();
  if (!g?.fotos.typenschild) return;
  if (!zustand.schluessel) { meldung("Zuerst den API-Schlüssel in den Einstellungen eingeben."); return; }
  if (g.auslesen.status !== "offen") {
    await aktualisiere(g.id, (alt) => aendere(alt, { auslesen: { ...alt.auslesen, status: "offen", fehler: "", vorschlag: null } })).catch(() => {});
  }
  if (!navigator.onLine) { meldung("Offline. Das Typenschild wird ausgelesen, sobald das iPhone online ist."); return; }
  zustand.vorrang = g.id;
  arbeiteWarteschlange(true);
});

// Warteschlange (E11): liest nacheinander alle Geräte mit Typenschild-Foto im Status „offen“ aus, solange das iPhone
// online ist und ein Schlüssel vorliegt. Fehler, die nicht am Foto liegen (kein Netz, Überlast, Schlüssel, Guthaben),
// lassen das Gerät „offen“ und halten die Schlange an; die übrigen setzen „fehler“, dann kommt das nächste Gerät dran.
let schlangeLaeuft = false;
let schlangeUhr = null;

async function arbeiteWarteschlange(vonHand = false) {
  if (schlangeLaeuft || !navigator.onLine || !zustand.schluessel) return;
  schlangeLaeuft = true;
  clearTimeout(schlangeUhr);
  try {
    const schluessel = await ablage.holeEinstellung("apiSchluessel");
    if (!schluessel) return;
    for (;;) {
      const offen = [...zustand.geraete.values()].filter((g) => g.fotos.typenschild !== null && g.auslesen.status === "offen");
      if (!offen.length) break;
      const g = offen.find((x) => x.id === zustand.vorrang) ?? nachNummer(offen)[0];
      const vorrang = g.id === zustand.vorrang;
      zustand.vorrang = null;
      if (!(await liesAus(g.id, schluessel, vonHand && vorrang))) break;
    }
  } catch (e) {
    meldung(`Auslesen angehalten: ${e.message}`, "fehler");
  } finally {
    schlangeLaeuft = false;
  }
}

// true: weiter mit dem nächsten Gerät
async function liesAus(id, schluessel, vonHand) {
  const stand = fotoStand.get(id) ?? 0;
  const g = await aktualisiere(id, (alt) => auslesenStart(alt));
  const foto = await ablage.holeFoto(g.fotos.typenschild);
  if (!foto) {
    await aktualisiere(id, (alt) => auslesenFehler(alt, "Das Typenschild-Foto fehlt."));
    return true;
  }
  try {
    const ergebnis = await liesTypenschild({ foto, schluessel, fetch: (...a) => fetch(...a) });
    const neu = await aktualisiere(id, (alt) => {
      const n = auslesenFertig(alt, ergebnis);
      // Inzwischen ein neues Foto: Kosten zählen, Ergebnis verwerfen, neu auslesen
      if ((fotoStand.get(id) ?? 0) !== stand) n.auslesen = { ...n.auslesen, status: "offen", vorschlag: null };
      return n;
    });
    if (neu.auslesen.status === "fertig" && zustand.offenId !== id) meldung(`${neu.inventarnummer}: Typenschild ausgelesen.`);
    return true;
  } catch (e) {
    const art = e instanceof TypenschildFehler ? e.art : null;
    const bleibtOffen = e.wiederholbar || art === FEHLER.SCHLUESSEL || art === FEHLER.GUTHABEN;
    await aktualisiere(id, (alt) => {
      const n = auslesenFehler(alt, e);
      return bleibtOffen ? { ...n, auslesen: { ...n.auslesen, status: "offen" } } : n;
    });
    if (art === FEHLER.UEBERLAST) schlangeUhr = setTimeout(arbeiteWarteschlange, Math.max(30, e.wartezeitSek ?? 0) * 1000);
    if (art === FEHLER.SCHLUESSEL || art === FEHLER.GUTHABEN || (vonHand && bleibtOffen)) meldung(e.message, "fehler");
    return !bleibtOffen;
  }
}

/* ---------- QR-Scanner (E10, E16, E23): Kamera nur auf Knopfdruck, danach schließen ---------- */
const scan = { stream: null, laeuft: false, licht: false, hinweisZeit: 0 };
const scanCanvas = document.createElement("canvas");
const scanCtx = scanCanvas.getContext("2d", { willReadFrequently: true });
const SCAN_TEXT = "Etikett mit dem QR-Code in den Rahmen halten";

let jsqrLaden = null;
function ladeJsQR() {
  jsqrLaden ??= new Promise((ok, nein) => {
    if (window.jsQR) return ok();
    const s = document.createElement("script");
    s.src = "vendor/jsQR.js";
    s.onload = ok;
    s.onerror = () => { jsqrLaden = null; nein(new Error("Der Scanner ließ sich nicht laden.")); };
    document.head.append(s);
  });
  return jsqrLaden;
}

async function scannerStart() {
  const ansicht = $("#scanner");
  ansicht.hidden = false;
  $("#scanner-text").textContent = "Kamera wird geöffnet …";
  $("#scanner-licht").hidden = true;
  try {
    await ladeJsQR();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    if (ansicht.hidden) { for (const t of stream.getTracks()) t.stop(); return; } // inzwischen abgebrochen
    scan.stream = stream;
    const video = $("#scanner-video");
    video.srcObject = stream;
    await video.play();
    Object.assign(scan, { laeuft: true, licht: false, hinweisZeit: 0 });
    $("#scanner-text").textContent = SCAN_TEXT;
    $("#scanner-licht").hidden = false;
    requestAnimationFrame(scanSchritt);
  } catch (e) {
    $("#scanner-text").textContent = e?.name === "NotAllowedError"
      ? "Kein Zugriff auf die Kamera. Beim nächsten Versuch „Erlauben“ tippen."
      : `Die Kamera ist nicht verfügbar (${e?.message || e}). Die Nummer lässt sich auch eintippen.`;
  }
}

function scanSchritt() {
  if (!scan.laeuft) return;
  const video = $("#scanner-video");
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (vw && vh && video.readyState >= 2) {
    // Ausschnitt-Modus der Probe: mittleres Quadrat (80 %), höchstens 640 px
    const seite = Math.round(Math.min(vw, vh) * 0.8);
    const ziel = Math.min(640, seite);
    if (scanCanvas.width !== ziel) scanCanvas.width = scanCanvas.height = ziel;
    scanCtx.drawImage(video, Math.round((vw - seite) / 2), Math.round((vh - seite) / 2), seite, seite, 0, 0, ziel, ziel);
    const code = window.jsQR(scanCtx.getImageData(0, 0, ziel, ziel).data, ziel, ziel, { inversionAttempts: "attemptBoth" });
    if (code?.data) {
      if (istNummer(code.data)) return scanTreffer(code.data);
      const jetzt = performance.now();
      if (jetzt - scan.hinweisZeit > 1500) {
        scan.hinweisZeit = jetzt;
        $("#scanner-text").textContent = `Kein Inventar-Etikett: „${code.data.slice(0, 40)}“. Erwartet wird INV- und vier Ziffern.`;
      }
    }
  }
  requestAnimationFrame(scanSchritt);
}

function scanTreffer(nr) {
  $("#scanner-rahmen").classList.add("treffer");
  navigator.vibrate?.(60);
  setTimeout(() => {
    scannerStopp();
    oeffneNummer(nr);
  }, 250);
  scan.laeuft = false;
}

function scannerStopp() {
  scan.laeuft = false;
  if (scan.stream) for (const t of scan.stream.getTracks()) t.stop();
  scan.stream = null;
  $("#scanner-video").srcObject = null;
  $("#scanner-rahmen").classList.remove("treffer");
  $("#scanner").hidden = true;
}

$("#qr-scannen").addEventListener("click", scannerStart);
$("#scanner-abbrechen").addEventListener("click", scannerStopp);
$("#scanner-eintippen").addEventListener("click", () => {
  const eingabe = prompt("Inventarnummer, z. B. INV-0012 oder 12");
  if (eingabe === null) return;
  const nr = normalisiereNummer(eingabe);
  if (!nr) { meldung(`„${eingabe}“ ist keine Inventarnummer.`, "fehler"); return; }
  scannerStopp();
  oeffneNummer(nr);
});
$("#scanner-licht").addEventListener("click", async () => {
  const track = scan.stream?.getVideoTracks()[0];
  if (!track) return;
  try {
    await track.applyConstraints({ advanced: [{ torch: !scan.licht }] });
    scan.licht = !scan.licht;
  } catch {
    $("#scanner-licht").hidden = true;
    meldung("Das Licht lässt sich hier nicht einschalten.");
  }
});

/* ---------- Teilen (E25): Teilen-Menü, Herunterladen nur als Rückfall ---------- */
// Ergebnis: "geteilt", "geladen" (Rückfall), "abgebrochen", "erneut" (Tippen nötig, die Geste ist abgelaufen)
async function teile(datei) {
  let teilbar = false;
  try { teilbar = !!navigator.canShare?.({ files: [datei] }); } catch { /* nicht teilbar */ }
  if (!teilbar) {
    const url = URL.createObjectURL(datei);
    const a = document.createElement("a");
    a.href = url;
    a.download = datei.name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return "geladen";
  }
  try {
    await navigator.share({ files: [datei] });
    return "geteilt";
  } catch (e) {
    if (e.name === "AbortError") return "abgebrochen";
    if (e.name === "NotAllowedError") return "erneut";
    throw e;
  }
}

/* ---------- Sicherung und Wiederherstellen (E4, E25) ---------- */
let bereiteSicherung = null; // { datei, text }

function sicherungMeldung(text, art = "") {
  const p = $("#sicherung-meldung");
  p.textContent = text;
  p.className = `meldetext ${art}`;
}

async function sichern() {
  const knopf = $("#sichern");
  if (!zustand.geraete.size) { sicherungMeldung("Noch keine Geräte zum Sichern."); return; }
  knopf.disabled = true;
  $("#sichern-teilen").hidden = true;
  sicherungMeldung("Sicherung wird erstellt …");
  try {
    speichereOffeneFelder();
    await kette;
    const s = await baueSicherung([...zustand.geraete.values()], ablage.holeFoto);
    let text = `${geraeteText(s.geraete)}, ${anzahl(s.fotos, "Foto", "Fotos")}, ${groesse(s.datei.size)}.`;
    if (s.fehlendeFotos.length) text += ` ${anzahl(s.fehlendeFotos.length, "Foto fehlte", "Fotos fehlten")} in der Ablage.`;
    bereiteSicherung = { datei: s.datei, text };
    await teileSicherung();
  } catch (e) {
    sicherungMeldung(`Die Sicherung ist fehlgeschlagen: ${e.message}`, "fehler");
  } finally {
    knopf.disabled = false;
  }
}

async function teileSicherung() {
  const { datei, text } = bereiteSicherung;
  const ergebnis = await teile(datei);
  if (ergebnis === "erneut") {
    $("#sichern-teilen").hidden = false;
    $("#sichern-teilen").textContent = `Sicherung teilen (${groesse(datei.size)})`;
    sicherungMeldung(`Sicherung bereit: ${text} Jetzt „Sicherung teilen“ tippen.`);
    return;
  }
  $("#sichern-teilen").hidden = true;
  if (ergebnis === "abgebrochen") { sicherungMeldung("Teilen abgebrochen. Die Sicherung ist nicht gespeichert."); return; }
  zustand.letzteSicherung = new Date().toISOString();
  await ablage.setzeEinstellung("letzteSicherung", zustand.letzteSicherung);
  bereiteSicherung = null;
  sicherungMeldung(`Gesichert: ${text}${ergebnis === "geladen" ? " Die Datei wurde heruntergeladen." : ""}`, "ok");
  zeigeEinstellungen();
}

$("#sichern").addEventListener("click", sichern);
$("#sichern-teilen").addEventListener("click", () => {
  if (bereiteSicherung) teileSicherung().catch((e) => sicherungMeldung(`Teilen fehlgeschlagen: ${e.message}`, "fehler"));
});

$("#wiederherstellen").addEventListener("change", async (ev) => {
  const datei = ev.target.files[0];
  ev.target.value = "";
  if (!datei) return;
  sicherungMeldung(`${datei.name} wird geprüft …`);
  try {
    const gelesen = await liesSicherung(datei);
    if (gelesen.fehler.length) {
      const liste = gelesen.fehler.slice(0, 8).join("\n");
      const mehr = gelesen.fehler.length > 8 ? `\n… und ${zahl(gelesen.fehler.length - 8)} weitere` : "";
      sicherungMeldung(`Nicht wiederhergestellt, auf dem iPhone bleibt alles, wie es war:\n${liste}${mehr}`, "fehler");
      return;
    }
    const frage = rueckfrage(zustand.geraete.size, gelesen);
    if (frage && !confirm(frage)) { sicherungMeldung("Wiederherstellen abgebrochen."); return; }
    speichereOffeneFelder();
    await kette;
    await ablage.ersetzeAlles(gelesen.geraete, gelesen.fotos);
    vergissAlleFotos();
    await ladeGeraete();
    if (gelesen.erstellt) {
      zustand.letzteSicherung = gelesen.erstellt;
      await ablage.setzeEinstellung("letzteSicherung", gelesen.erstellt);
    }
    const hinweise = gelesen.hinweise.length ? `\n${gelesen.hinweise.join("\n")}` : "";
    sicherungMeldung(`Wiederhergestellt: ${geraeteText(gelesen.geraete.length)}, ${anzahl(gelesen.fotos.size, "Foto", "Fotos")}.${hinweise}`, "ok");
    zeigeEinstellungen();
    arbeiteWarteschlange();
  } catch (e) {
    sicherungMeldung(`Wiederherstellen fehlgeschlagen: ${e.message}`, "fehler");
  }
});

/* ---------- CSV-Export (E17, E25) ---------- */
$("#csv-teilen").addEventListener("click", async () => {
  if (!zustand.geraete.size) { meldung("Noch keine Geräte zum Exportieren."); return; }
  try {
    const ergebnis = await teile(csvDatei([...zustand.geraete.values()]));
    if (ergebnis === "erneut") meldung("Bitte noch einmal „CSV teilen“ tippen.");
    else if (ergebnis !== "abgebrochen") meldung(`CSV mit ${anzahl(zustand.geraete.size, "Gerät", "Geräten")} ${ergebnis === "geladen" ? "heruntergeladen" : "geteilt"}.`);
  } catch (e) {
    meldung(`Export fehlgeschlagen: ${e.message}`, "fehler");
  }
});

/* ---------- Einstellungen ---------- */
function tabelle(ziel, zeilen) {
  ziel.replaceChildren(...zeilen.map(([name, wert, klasse]) => {
    const tr = document.createElement("tr");
    const a = document.createElement("td");
    const b = document.createElement("td");
    a.textContent = name;
    b.textContent = wert;
    if (klasse) b.className = klasse;
    tr.append(a, b);
    return tr;
  }));
}

async function zeigeEinstellungen() {
  const alle = [...zustand.geraete.values()];
  // Sicherung
  if (zustand.letzteSicherung) {
    const e = erinnerung(alle, zustand.letzteSicherung);
    const seit = e.neue || e.geaendert
      ? ` Seitdem ${[e.neue && anzahl(e.neue, "Gerät neu", "Geräte neu"), e.geaendert > e.neue && `${zahl(e.geaendert - e.neue)} geändert`].filter(Boolean).join(", ")}.`
      : " Seitdem keine Änderung.";
    $("#sicherung-stand").textContent = `Letzte Sicherung: ${zeitText(zustand.letzteSicherung)}.${seit}`;
  } else $("#sicherung-stand").textContent = `Noch keine Sicherung. ${geraeteText(alle.length)} auf diesem iPhone.`;

  // Schlüssel und Kosten
  const schluessel = await ablage.holeEinstellung("apiSchluessel").catch(() => null);
  zustand.schluessel = !!schluessel;
  $("#schluessel-stand").textContent = schluessel
    ? `Schlüssel gespeichert (endet auf …${schluessel.slice(-4)}).`
    : "Kein Schlüssel gespeichert. Ohne Schlüssel liest die App keine Typenschilder aus.";
  $("#schluessel-stand").className = schluessel ? "gut" : "";
  $("#schluessel-loeschen").hidden = !schluessel;
  const aufrufe = alle.reduce((n, g) => n + g.auslesen.aufrufe.length, 0);
  const summe = alle.reduce((n, g) => n + g.auslesen.kostenCent, 0);
  const wartend = alle.filter((g) => g.fotos.typenschild && g.auslesen.status === "offen").length;
  tabelle($("#kosten-tabelle"), [
    ["Aufrufe", zahl(aufrufe)],
    ["Kosten gesamt", cent(summe)],
    ["Je Aufruf im Schnitt", aufrufe ? cent(summe / aufrufe) : "–"],
    ["Ausgelesene Geräte", zahl(alle.filter((g) => g.auslesen.status === "fertig").length)],
    ["Warten aufs Auslesen", zahl(wartend)],
  ]);

  // Speicher (E24)
  const s = zustand.speicher ?? {};
  tabelle($("#speicher-tabelle"), [
    ["Dauerhaft gespeichert", s.persistiert === true ? "ja" : s.persistiert === false ? "nein" : "unbekannt", s.persistiert === true ? "gut" : s.persistiert === false ? "schlecht" : ""],
    ["Belegt", s.belegt != null && s.quota ? `${groesse(s.belegt)} von ${groesse(s.quota)}` : "unbekannt"],
  ]);
  $("#speicher-hinweis").textContent = s.persistiert === true
    ? "iOS löscht die Daten nicht von selbst. Die Sicherung schützt trotzdem, falls das iPhone verloren geht."
    : "iOS hat den dauerhaften Speicher nicht bestätigt und darf die Daten bei Platzmangel löschen. Die App erinnert darum öfter an die Sicherung.";
  $("#version").textContent = `Version ${VERSION} · Daten nur auf diesem iPhone`;
}

$("#schluessel-speichern").addEventListener("click", async () => {
  const feld = $("#schluessel");
  const wert = feld.value.trim();
  if (!wert) { meldung("Bitte den Schlüssel einfügen."); return; }
  if (!wert.startsWith("sk-ant-")) { meldung("Das ist kein Schlüssel von Anthropic. Er beginnt mit sk-ant-.", "fehler"); return; }
  try {
    await ablage.setzeEinstellung("apiSchluessel", wert);
    feld.value = "";
    zustand.schluessel = true;
    meldung("Schlüssel gespeichert.");
    await zeigeEinstellungen();
    arbeiteWarteschlange();
  } catch (e) {
    meldung(`Nicht gespeichert: ${e.message}`, "fehler");
  }
});
$("#schluessel-loeschen").addEventListener("click", async () => {
  if (!confirm("API-Schlüssel von diesem iPhone löschen?")) return;
  await ablage.loescheEinstellung("apiSchluessel");
  zustand.schluessel = false;
  meldung("Schlüssel gelöscht.");
  zeigeEinstellungen();
});

/* ---------- Online, Hintergrund, Service Worker (E26) ---------- */
function zeigeOnline() {
  for (const m of $$("[data-offline]")) m.hidden = navigator.onLine;
  const g = zustand.ansicht === "geraet" ? aktuelles() : null;
  if (g) zeigeAuslesen(g);
}
window.addEventListener("online", () => { zeigeOnline(); arbeiteWarteschlange(); });
window.addEventListener("offline", zeigeOnline);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    speichereOffeneFelder();
    scannerStopp(); // iOS: laufende Kamera beim Wechsel schließen
  } else {
    arbeiteWarteschlange();
    swRegistrierung?.update().catch(() => {});
  }
});
window.addEventListener("pagehide", speichereOffeneFelder);

let swRegistrierung = null;
if ("serviceWorker" in navigator) {
  const vorher = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register("sw.js").then((r) => (swRegistrierung = r), (e) => console.warn("Service Worker:", e));
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (vorher) $("#banner-update").hidden = false; });
}
$("#update-laden").addEventListener("click", () => location.reload());

/* ---------- Start ---------- */
// Lädt alle Geräte; ein „laeuft“ von einem abgebrochenen Start wird wieder „offen“ (DATENMODELL.md)
async function ladeGeraete() {
  zustand.geraete = new Map((await ablage.alleGeraete()).map((g) => [g.id, g]));
  for (const g of zustand.geraete.values()) {
    if (g.auslesen.status === "laeuft") aktualisiere(g.id, (alt) => aendere(alt, { auslesen: { ...alt.auslesen, status: "offen" } }));
  }
  await kette;
}

async function start() {
  try {
    const speicher = ablage.pruefeSpeicher(); // E24: bei jedem Start persist() anfragen
    await ladeGeraete();
    zustand.letzteSicherung = (await ablage.holeEinstellung("letzteSicherung")) ?? null;
    zustand.schluessel = !!(await ablage.holeEinstellung("apiSchluessel"));
    zeigeOnline();
    route();
    zustand.speicher = await speicher;
    if (zustand.ansicht === "liste") zeigeBanner();
    arbeiteWarteschlange();
  } catch (e) {
    document.body.replaceChildren(Object.assign(document.createElement("p"), {
      className: "leer",
      textContent: `Die App konnte ihre Daten nicht öffnen: ${e.message}. Bitte die App schließen und neu öffnen.`,
    }));
  }
}

start();
