import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { RuntimeDeclaration } from "../../verifier/types.js";
import { ENV_ARTIFACT_DIR, artifactFileName, type VibehardArtifact } from "../playwright/artifact.js";
import { VIBEHARD_TASK } from "./index.js";

export { VIBEHARD_TASK } from "./index.js";

interface ArtifactPayload {
  title: string;
  titlePath: string[];
  status: string;
  declared: RuntimeDeclaration;
  istanbul: Record<string, unknown> | null;
}

type OnFn = (
  event: string,
  handler: Record<string, (arg: unknown) => unknown> | ((spec: { absolute?: string }) => void),
) => void;

function validPayload(value: unknown): value is ArtifactPayload {
  if (value === null || typeof value !== "object") return false;
  const v = value as Partial<ArtifactPayload>;
  return (
    typeof v.title === "string" &&
    Array.isArray(v.titlePath) &&
    typeof v.status === "string" &&
    v.declared !== null &&
    typeof v.declared === "object"
  );
}

/**
 * Register vibehard's Cypress node-side handlers inside
 * `setupNodeEvents`. Tracks the running spec (for artifact file
 * attribution) and writes each reported per-test artifact into
 * `VIBEHARD_ARTIFACT_DIR` when the vibehard CLI is driving the run.
 * Plain `cypress run` is unaffected (no artifact dir, no writes).
 */
export function registerVibehardTasks(on: OnFn): void {
  let currentSpec = "";
  on("before:spec", (spec: { absolute?: string }) => {
    currentSpec = typeof spec.absolute === "string" ? spec.absolute : "";
  });
  on("task", {
    [VIBEHARD_TASK](payload: unknown): null {
      const dir = process.env[ENV_ARTIFACT_DIR];
      if (dir === undefined || dir === "" || !validPayload(payload)) return null;
      mkdirSync(dir, { recursive: true });
      const artifact: VibehardArtifact = {
        version: 1,
        file: currentSpec,
        line: 0,
        title: payload.title,
        titlePath: payload.titlePath,
        status: payload.status === "passed" ? "passed" : payload.status,
        declared: {
          uses: payload.declared.uses ?? null,
          allowTransitive: payload.declared.allowTransitive ?? [],
          skipVerify: payload.declared.skipVerify ?? null,
        },
        clientScripts: [],
        istanbul: payload.istanbul ?? null,
        errors: payload.status === "passed" ? [] : [`cypress test state: ${payload.status}`],
      };
      writeFileSync(
        path.join(dir, artifactFileName(artifact.file, artifact.line, artifact.title)),
        `${JSON.stringify(artifact)}\n`,
      );
      return null;
    },
  });
}
