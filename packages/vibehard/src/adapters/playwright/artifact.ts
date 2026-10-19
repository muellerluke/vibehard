import { createHash } from "node:crypto";

import type { ScriptInput } from "../../observer/types.js";
import type { RuntimeDeclaration, VibehardTestOptions } from "../../verifier/types.js";

export const VIBEHARD_ANNOTATION_TYPE = "vibehard.uses";
export const ENV_ARTIFACT_DIR = "VIBEHARD_ARTIFACT_DIR";
export const ENV_RESOLVE_MAP = "VIBEHARD_RESOLVE_MAP";
export const ENV_BASE_URL = "VIBEHARD_BASE_URL";

/** Per-test artifact written by the adapter fixture, read by the verifier. */
export interface VibehardArtifact {
  version: 1;
  /** Absolute test file path. */
  file: string;
  line: number;
  title: string;
  titlePath: string[];
  /** Framework test status at teardown ("passed", "failed", …). */
  status: string;
  declared: RuntimeDeclaration;
  clientScripts: ScriptInput[];
  /**
   * Cypress only: the raw Istanbul `window.__coverage__` object captured
   * for this test, or null when the app exposed none (unmappable).
   */
  istanbul?: Record<string, unknown> | null;
  errors: string[];
}

export function encodeDeclaration(opts: VibehardTestOptions | null): string {
  const runtime: RuntimeDeclaration = {
    uses: opts === null ? null : [...opts.uses],
    allowTransitive: opts?.allowTransitive ?? [],
    skipVerify: opts?.skipVerify ?? null,
  };
  return JSON.stringify(runtime);
}

export function decodeDeclaration(
  annotations: readonly { type: string; description?: string }[],
): RuntimeDeclaration {
  for (const annotation of annotations) {
    if (annotation.type !== VIBEHARD_ANNOTATION_TYPE) continue;
    try {
      const parsed = JSON.parse(annotation.description ?? "") as Partial<RuntimeDeclaration>;
      return {
        uses: Array.isArray(parsed.uses) ? parsed.uses.map(String) : null,
        allowTransitive: Array.isArray(parsed.allowTransitive)
          ? parsed.allowTransitive.map(String)
          : [],
        skipVerify: typeof parsed.skipVerify === "string" ? parsed.skipVerify : null,
      };
    } catch {
      return { uses: null, allowTransitive: [], skipVerify: null };
    }
  }
  return { uses: null, allowTransitive: [], skipVerify: null };
}

export function artifactFileName(file: string, line: number, title: string): string {
  const hash = createHash("sha256").update(`${file}:${line}:${title}`).digest("hex").slice(0, 24);
  return `vh-${hash}.json`;
}

export function parseArtifact(text: string): VibehardArtifact | null {
  try {
    const value = JSON.parse(text) as Partial<VibehardArtifact>;
    if (value.version !== 1 || typeof value.file !== "string" || typeof value.title !== "string") {
      return null;
    }
    return value as VibehardArtifact;
  } catch {
    return null;
  }
}
