/** Stage 4: git-diff → changed-symbols → test selection. */
export interface SelectionResult {
  selected: string[];
  unsafeReason: string | null;
}

export function selectTests(_baseRef: string): Promise<SelectionResult> {
  return Promise.reject(new Error("selector: not implemented (Stage 4)"));
}
