// Impressum-Schalter (P4-9). Leer = in der App ist weder ein Impressum noch ein Verantwortlicher sichtbar,
// nur die Datenschutzhinweise. Der Betreiber trägt Name und Anschrift vor dem Release selbst hier ein
// (mehrzeiliger Text möglich); nichts davon darf erfunden oder geraten werden.
export const IMPRESSUM = "";

// Sichtbar nur bei nichtleerem Text (Leerzeichen zählen nicht).
export function impressumSichtbar(text) {
  return typeof text === "string" && text.trim() !== "";
}
