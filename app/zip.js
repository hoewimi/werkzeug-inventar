// ZIP ohne Kompression (Methode „store“), ohne ZIP64. Aus der iPhone-Probe übernommen (src/probe/zip.js, E25).
// Ohne DOM: läuft im Browser und in Node (Blob, TextEncoder).

const CRC_TABELLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

// CRC-32/ISO-HDLC; mit `vorher` lässt sich über mehrere Stücke weiterrechnen.
export function crc32(bytes, vorher = 0) {
  let c = (vorher ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABELLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const STUECK = 4 * 1024 * 1024;

async function crcVonBlob(blob) {
  let crc = 0;
  for (let pos = 0; pos < blob.size; pos += STUECK) {
    crc = crc32(new Uint8Array(await blob.slice(pos, pos + STUECK).arrayBuffer()), crc);
  }
  return crc;
}

function dosZeit(d) {
  const zeit = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const datum = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { zeit, datum };
}

// eintraege: [{ name, daten: Blob | Uint8Array | string, crc? }]
// Ergebnis: Blob mit type application/zip; die Daten werden nicht kopiert, sondern als Teile übergeben.
export async function bauZip(eintraege, jetzt = new Date()) {
  const enc = new TextEncoder();
  const { zeit, datum } = dosZeit(jetzt);
  const teile = [];
  const zentral = [];
  let offset = 0;

  for (const e of eintraege) {
    const daten = typeof e.daten === "string" ? enc.encode(e.daten) : e.daten;
    const groesse = daten instanceof Uint8Array ? daten.length : daten.size;
    const crc = e.crc ?? (daten instanceof Uint8Array ? crc32(daten) : await crcVonBlob(daten));
    const name = enc.encode(e.name);
    if (groesse > 0xffffffff || offset > 0xffffffff) throw new Error("ZIP zu groß (über 4 GiB, ZIP64 fehlt)");

    const lokal = new Uint8Array(30 + name.length);
    const l = new DataView(lokal.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, 10, true); // benötigte Version 1.0 (store)
    l.setUint16(6, 0x0800, true); // Bit 11: Name in UTF-8
    l.setUint16(8, 0, true); // Methode store
    l.setUint16(10, zeit, true);
    l.setUint16(12, datum, true);
    l.setUint32(14, crc, true);
    l.setUint32(18, groesse, true);
    l.setUint32(22, groesse, true);
    l.setUint16(26, name.length, true);
    l.setUint16(28, 0, true);
    lokal.set(name, 30);

    const z = new Uint8Array(46 + name.length);
    const c = new DataView(z.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true); // erstellt mit Version 2.0
    c.setUint16(6, 10, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true);
    c.setUint16(12, zeit, true);
    c.setUint16(14, datum, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, groesse, true);
    c.setUint32(24, groesse, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    z.set(name, 46);

    teile.push(lokal, daten);
    zentral.push(z);
    offset += lokal.length + groesse;
  }

  const zentralGroesse = zentral.reduce((s, z) => s + z.length, 0);
  const ende = new Uint8Array(22);
  const v = new DataView(ende.buffer);
  v.setUint32(0, 0x06054b50, true);
  v.setUint16(8, eintraege.length, true);
  v.setUint16(10, eintraege.length, true);
  v.setUint32(12, zentralGroesse, true);
  v.setUint32(16, offset, true);

  return new Blob([...teile, ...zentral, ende], { type: "application/zip" });
}

// Liest ein ZIP (Blob/File) in Stücken und prüft jeden Eintrag gegen seinen CRC.
// Ergebnis: [{ name, groesse, methode, crcErwartet, crcIst, ok, fehler?, daten? }]; daten ist der Inhalt als Blob-Ausschnitt (ohne Kopie).
export async function liesZip(blob) {
  const lies = async (von, bis) => new Uint8Array(await blob.slice(von, bis).arrayBuffer());
  const schwanzLaenge = Math.min(blob.size, 22 + 65535);
  const schwanz = await lies(blob.size - schwanzLaenge, blob.size);
  let p = -1;
  for (let i = schwanz.length - 22; i >= 0; i--) {
    if (schwanz[i] === 0x50 && schwanz[i + 1] === 0x4b && schwanz[i + 2] === 0x05 && schwanz[i + 3] === 0x06) { p = i; break; }
  }
  if (p < 0) throw new Error("Kein ZIP: Endeintrag nicht gefunden");
  const ev = new DataView(schwanz.buffer, p);
  const anzahl = ev.getUint16(10, true);
  const zGroesse = ev.getUint32(12, true);
  const zOffset = ev.getUint32(16, true);
  const zd = await lies(zOffset, zOffset + zGroesse);
  const dv = new DataView(zd.buffer);
  const dec = new TextDecoder();
  const ergebnis = [];
  let q = 0;
  for (let n = 0; n < anzahl; n++) {
    if (dv.getUint32(q, true) !== 0x02014b50) throw new Error(`Verzeichnis kaputt bei Eintrag ${n + 1}`);
    const methode = dv.getUint16(q + 10, true);
    const crcErwartet = dv.getUint32(q + 16, true);
    const komprimiert = dv.getUint32(q + 20, true);
    const groesse = dv.getUint32(q + 24, true);
    const nameLaenge = dv.getUint16(q + 28, true);
    const extraLaenge = dv.getUint16(q + 30, true);
    const kommentarLaenge = dv.getUint16(q + 32, true);
    const lokalOffset = dv.getUint32(q + 42, true);
    const name = dec.decode(zd.subarray(q + 46, q + 46 + nameLaenge));
    q += 46 + nameLaenge + extraLaenge + kommentarLaenge;

    const eintrag = { name, groesse, methode, crcErwartet, crcIst: null, ok: false };
    if (methode !== 0) {
      eintrag.fehler = `Methode ${methode} nicht unterstützt (nur store)`;
      ergebnis.push(eintrag);
      continue;
    }
    const kopf = await lies(lokalOffset, lokalOffset + 30);
    const kv = new DataView(kopf.buffer);
    if (kv.getUint32(0, true) !== 0x04034b50) {
      eintrag.fehler = "lokaler Kopf fehlt";
      ergebnis.push(eintrag);
      continue;
    }
    const start = lokalOffset + 30 + kv.getUint16(26, true) + kv.getUint16(28, true);
    eintrag.daten = blob.slice(start, start + komprimiert);
    eintrag.crcIst = await crcVonBlob(eintrag.daten);
    eintrag.ok = eintrag.crcIst === crcErwartet && komprimiert === groesse;
    ergebnis.push(eintrag);
  }
  return ergebnis;
}
