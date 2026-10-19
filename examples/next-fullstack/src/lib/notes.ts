export function normalizeNote(note: string): string {
  const trimmed = note.trim().replace(/\s+/g, " ");
  return trimmed === "" ? "(empty)" : trimmed.toUpperCase();
}
