/** Stage 3: per-test isolated verification + lockfile. */
export interface VerifyResult {
  testId: string;
  missing: string[];
  extra: string[];
}

export function verifyTest(_testId: string): Promise<VerifyResult> {
  return Promise.reject(new Error("verifier: not implemented (Stage 3)"));
}
