import { createHash } from "node:crypto";

import type { ScriptInput } from "../../observer/types.js";
import type { RuntimeOptions, VibehardTestOptions } from "../../verifier/types.js";

export const VIBEHARD_ANNOTATION_TYPE = "vibehard.options";
export const ENV_ARTIFACT_DIR = "VIBEHARD_ARTIFACT_DIR";
export const ENV_RESOLVE_MAP = "VIBEHARD_RESOLVE_MAP";
export const ENV_BASE_URL = "VIBEHARD_BASE_URL";

/** Per-test artifact written by the adapter fixture, read by the verifier. */
export interface VibehardArtifact {
  version: 2;
  /** Absolute test file path. */
  file: string;
  line: number;
  title: string;
  titlePath: string[];
  /** Framework test status at teardown ("passed", "failed", …). */
  status: string;
  options: RuntimeOptions;
  clientScripts: ScriptInput[];
  /**
   * Cypress only: the raw Istanbul `window.__coverage__` object captured
   * for this test, or null when the app exposed none (unmappable).
   */
  istanbul?: Record<string, unknown> | null;
  errors: string[];
}

export function encodeOptions(opts: VibehardTestOptions | null): string {
  const runtime: RuntimeOptions = {
    alwaysRun: opts?.alwaysRun ?? null,
  };
  return JSON.stringify(runtime);
}

export function decodeOptions(
  annotations: readonly { type: string; description?: string }[],
): RuntimeOptions {
  for (const annotation of annotations) {
    if (annotation.type !== VIBEHARD_ANNOTATION_TYPE) continue;
    try {
      const parsed = JSON.parse(annotation.description ?? "") as Partial<RuntimeOptions>;
      return {
        alwaysRun: typeof parsed.alwaysRun === "string" ? parsed.alwaysRun : null,
      };
    } catch {
      return { alwaysRun: null };
    }
  }
  return { alwaysRun: null };
}

export function artifactFileName(file: string, line: number, title: string): string {
  const hash = createHash("sha256").update(`${file}:${line}:${title}`).digest("hex").slice(0, 24);
  return `vh-${hash}.json`;
}

export function parseArtifact(text: string): VibehardArtifact | null {
  try {
    const value = JSON.parse(text) as Partial<VibehardArtifact>;
    if (value.version !== 2 || typeof value.file !== "string" || typeof value.title !== "string") {
      return null;
    }
    if (typeof value.options !== "object" || value.options === null) {
      value.options = { alwaysRun: null };
    }
    return value as VibehardArtifact;
  } catch {
    return null;
  }
}
