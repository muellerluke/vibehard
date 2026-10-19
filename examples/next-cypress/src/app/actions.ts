"use server";

import { normalizeNote } from "../lib/notes";

export async function saveNote(
  note: string,
): Promise<{ ok: boolean; note: string }> {
  const normalized = normalizeNote(note);
  return { ok: normalized !== "(empty)", note: normalized };
}
