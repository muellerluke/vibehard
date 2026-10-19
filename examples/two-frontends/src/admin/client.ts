import { adminSummary } from "./stats.js";

/** Browser-executed admin code. */
export function bootAdmin(): void {
  const note = document.querySelector("#admin-note");
  if (note !== null) note.textContent = adminSummary();
}

bootAdmin();
