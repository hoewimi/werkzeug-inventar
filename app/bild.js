// Fotos verkleinern (E7, E22): lange Kante 1600 px, JPEG 0,8; das Original wird nicht gespeichert.
// Aus der iPhone-Probe übernommen (src/probe/probe.js, verkleinere). Braucht im Browser createImageBitmap und <canvas>;
// zielGroesse ist reine Rechnung und läuft auch in Node.

export const LANGE_KANTE = 1600;
export const QUALITAET = 0.8;

// 3024×4032 → 1200×1600; kleinere Bilder bleiben, wie sie sind
export function zielGroesse(qw, qh, lang = LANGE_KANTE) {
  const f = Math.min(1, lang / Math.max(qw, qh));
  return { w: Math.round(qw * f), h: Math.round(qh * f) };
}

// datei: File oder Blob aus der Datei-Eingabe (Kamera oder Mediathek). Erst createImageBitmap (dreht nach EXIF), sonst <img>.
// Ergebnis: { blob (image/jpeg), w, h, qw, qh, dauer (ms) }
export async function verkleinere(datei, lang = LANGE_KANTE, qualitaet = QUALITAET) {
  const t0 = performance.now();
  let quelle;
  try {
    quelle = await createImageBitmap(datei);
  } catch {
    const img = new Image();
    img.src = URL.createObjectURL(datei);
    await img.decode();
    quelle = img;
  }
  const qw = quelle.width || quelle.naturalWidth;
  const qh = quelle.height || quelle.naturalHeight;
  const { w, h } = zielGroesse(qw, qh, lang);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d").drawImage(quelle, 0, 0, w, h);
  if (quelle.close) quelle.close();
  if (quelle.src) URL.revokeObjectURL(quelle.src);
  const blob = await new Promise((ok, nein) => c.toBlob((b) => (b ? ok(b) : nein(new Error("toBlob lieferte nichts"))), "image/jpeg", qualitaet));
  c.width = c.height = 0;
  return { blob, w, h, qw, qh, dauer: performance.now() - t0 };
}
