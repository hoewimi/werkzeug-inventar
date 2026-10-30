// Typenschild auslesen per Claude-API (E5, E18, E27). Ohne DOM, `fetch` wird übergeben.
// Prompt, Schema, Header und Kostenrechnung stammen aus src/probe/probe.js
// (am iPhone mit echtem Schlüssel geprüft, 30.10.2026).

export const API_URL = "https://api.anthropic.com/v1/messages";
export const MODELL = "claude-haiku-5-5";

// Preise claude-haiku-5-5 in US-Dollar je Million Token (Prompt bis 100.000 Token).
// Quelle: https://platform.claude.com/docs/en/about-claude/pricing, abgerufen Okt. 2026
// (siehe recherche/technik.md), bestätigt durch die Messung in der iPhone-Probe am 30.10.2026.
export const PREIS_EIN = 0.1;
export const PREIS_AUS = 0.5;

export const FELDER = ["bezeichnung", "hersteller", "modell", "seriennummer", "leistung", "spannung", "baujahr", "artikelnummer"];

export const SCHEMA = {
  type: "object",
  properties: Object.fromEntries(FELDER.map((f) => [f, { type: "string" }])),
  required: FELDER,
  additionalProperties: false,
};

export const AUFTRAG = [
  "Lies das Typenschild auf dem Foto aus und fülle die Felder.",
  "Trage nur ein, was auf dem Schild lesbar steht. Was fehlt oder nicht sicher lesbar ist, bleibt ein leerer String. Nichts raten, nichts ergänzen.",
  "bezeichnung: Geräteart, wie sie auf dem Schild steht (z. B. Bohrhammer). hersteller: Firmen- oder Markenname. modell: Typ- oder Modellbezeichnung.",
  "seriennummer: Serien- oder Fabriknummer. leistung: mit Einheit (z. B. 800 W). spannung: mit Einheit (z. B. 230 V ~). baujahr: Jahr, wie angegeben. artikelnummer: Artikel- oder Bestellnummer.",
].join("\n");

// Fehlerarten für die Warteschlange (E11): `wiederholbar` heißt, die App darf es später selbst erneut versuchen.
export const FEHLER = {
  KEIN_NETZ: "kein-netz", // fetch scheitert (offline, Flugmodus): später nachholen
  SCHLUESSEL: "schluessel", // 401/403: Schlüssel falsch oder gesperrt, Nutzer muss handeln
  GUTHABEN: "guthaben", // 402, 400 „credit balance“/„usage limits“, 429 Ausgabelimit: Nutzer muss nachladen
  UEBERLAST: "ueberlast", // 429, 5xx, 529: später nachholen, `wartezeitSek` beachten
  ANFRAGE: "anfrage", // übrige 4xx (z. B. 400, 413): so nicht wiederholen
  ANTWORT: "antwort", // HTTP 200, aber kein verwertbares Ergebnis (kaputtes JSON, refusal, max_tokens)
};

const MELDUNG = {
  [FEHLER.KEIN_NETZ]: "Keine Verbindung. Das Typenschild wird ausgelesen, sobald das iPhone wieder online ist.",
  [FEHLER.SCHLUESSEL]: "Der API-Schlüssel wurde abgelehnt. Bitte in den Einstellungen prüfen.",
  [FEHLER.GUTHABEN]: "Das Guthaben des API-Schlüssels ist aufgebraucht. Bitte in der Claude Console nachladen.",
  [FEHLER.UEBERLAST]: "Der Dienst ist gerade ausgelastet. Die App versucht es später noch einmal.",
  [FEHLER.ANFRAGE]: "Die Anfrage wurde abgelehnt.",
  [FEHLER.ANTWORT]: "Die Antwort war nicht auswertbar.",
};

const WIEDERHOLBAR = new Set([FEHLER.KEIN_NETZ, FEHLER.UEBERLAST]);

export class TypenschildFehler extends Error {
  constructor(art, { status = null, typ = null, detail = "", wartezeitSek = null, requestId = null, usage = null } = {}) {
    super(detail ? `${MELDUNG[art]} (${detail})` : MELDUNG[art]);
    this.name = "TypenschildFehler";
    this.art = art;
    this.wiederholbar = WIEDERHOLBAR.has(art);
    this.status = status;
    this.typ = typ;
    this.wartezeitSek = wartezeitSek;
    this.requestId = requestId;
    // Auch ein unbrauchbares Ergebnis kostet Token; die App speichert sie trotzdem (E18).
    this.usage = usage;
    this.kostenCent = usage ? kostenCent(usage) : 0;
  }
}

export function kostenCent(usage) {
  return ((usage.input_tokens || 0) * PREIS_EIN + (usage.output_tokens || 0) * PREIS_AUS) / 1e6 * 100;
}

// Foto als Blob/File oder als Base64 (auch als data:-URL). Ergebnis: { mediaType, daten }.
export async function bildDaten(foto) {
  if (typeof foto === "string") {
    const treffer = /^data:([^;,]+)[^,]*,/.exec(foto);
    return treffer ? { mediaType: treffer[1], daten: foto.slice(treffer[0].length) } : { mediaType: "image/jpeg", daten: foto };
  }
  const bytes = new Uint8Array(await foto.arrayBuffer());
  let binaer = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binaer += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { mediaType: foto.type || "image/jpeg", daten: btoa(binaer) };
}

export function anfrageKoerper({ mediaType, daten }) {
  return {
    model: MODELL,
    max_tokens: 2048,
    thinking: { type: "disabled" },
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: daten } },
        { type: "text", text: AUFTRAG },
      ],
    }],
  };
}

function fehlerAusHttp(status, json, retryAfter) {
  const f = json?.error || {};
  const typ = f.type || null;
  const text = f.message || "";
  const angaben = { status, typ, detail: `HTTP ${status}${typ ? ` ${typ}` : ""}`, requestId: json?.request_id || null };
  const sek = Number.parseInt(retryAfter ?? "", 10);
  if (status === 401 || status === 403) return new TypenschildFehler(FEHLER.SCHLUESSEL, angaben);
  if (status === 402 || typ === "billing_error") return new TypenschildFehler(FEHLER.GUTHABEN, angaben);
  if (status === 400 && /credit balance|usage limits/i.test(text)) return new TypenschildFehler(FEHLER.GUTHABEN, angaben);
  if (status === 429 && f.details?.error_code === "enforced_spend_limit_reached") return new TypenschildFehler(FEHLER.GUTHABEN, angaben);
  if (status === 429 || status >= 500) {
    return new TypenschildFehler(FEHLER.UEBERLAST, { ...angaben, wartezeitSek: Number.isFinite(sek) ? sek : null });
  }
  return new TypenschildFehler(FEHLER.ANFRAGE, { ...angaben, detail: text ? `${angaben.detail}: ${text}` : angaben.detail });
}

// Wertet eine erfolgreiche API-Antwort aus. Felder ohne Befund sind leer, nie erfunden (E18).
export function werteAntwortAus(json) {
  const usage = { input_tokens: json?.usage?.input_tokens || 0, output_tokens: json?.usage?.output_tokens || 0 };
  const textBlock = (json?.content || []).find((b) => b.type === "text");
  if (json?.stop_reason !== "end_turn" || !textBlock) {
    throw new TypenschildFehler(FEHLER.ANTWORT, { detail: `stop_reason ${json?.stop_reason ?? "fehlt"}`, requestId: json?.id || null, usage });
  }
  let roh;
  try {
    roh = JSON.parse(textBlock.text);
  } catch {
    throw new TypenschildFehler(FEHLER.ANTWORT, { detail: "kein gültiges JSON", requestId: json.id || null, usage });
  }
  if (!roh || typeof roh !== "object" || Array.isArray(roh)) {
    throw new TypenschildFehler(FEHLER.ANTWORT, { detail: "kein JSON-Objekt", requestId: json.id || null, usage });
  }
  const felder = Object.fromEntries(FELDER.map((f) => [f, typeof roh[f] === "string" ? roh[f].trim() : ""]));
  return { felder, usage, kostenCent: kostenCent(usage) };
}

// Liest ein verkleinertes Typenschild-Foto aus.
// Liefert { felder, usage, kostenCent } oder wirft TypenschildFehler (Art in `fehler.art`).
export async function liesTypenschild({ foto, schluessel, fetch }) {
  const koerper = anfrageKoerper(await bildDaten(foto));
  let antwort;
  try {
    antwort = await fetch(API_URL, {
      method: "POST",
      headers: {
        "x-api-key": schluessel,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
        "content-type": "application/json",
      },
      body: JSON.stringify(koerper),
    });
  } catch (e) {
    throw new TypenschildFehler(FEHLER.KEIN_NETZ, { detail: e?.message || String(e) });
  }
  let json = null;
  try {
    json = await antwort.json();
  } catch (e) {
    // Fehlerseiten von Proxys sind oft kein JSON (SyntaxError); bei HTTP 200 ist das ein Antwortfehler.
    // Alles andere heißt, die Verbindung brach beim Lesen ab: später nachholen.
    if (!(e instanceof SyntaxError)) throw new TypenschildFehler(FEHLER.KEIN_NETZ, { status: antwort.status, detail: e?.message || String(e) });
  }
  if (!antwort.ok) throw fehlerAusHttp(antwort.status, json, antwort.headers?.get?.("retry-after"));
  if (json === null) throw new TypenschildFehler(FEHLER.ANTWORT, { status: antwort.status, detail: "Antwort ist kein JSON" });
  return werteAntwortAus(json);
}
