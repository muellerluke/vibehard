import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { parseArtifact, type VibehardArtifact } from "../adapters/playwright/artifact.js";

export interface ListedTest {
  /** Absolute test file path. */
  file: string;
  /** POSIX path relative to the project root. */
  relFile: string;
  line: number;
  title: string;
  /** Describe titles plus the test title. */
  titlePath: string[];
  testId: string;
}

/** Minimal test reference a framework driver needs to run a selection. */
export interface RunnableTestRef {
  testId: string;
  /** POSIX path relative to the project root. */
  file: string;
  line: number;
  title: string;
  titlePath: string[];
}

export function makeTestId(relFile: string, titlePath: readonly string[]): string {
  return `${relFile}::${titlePath.join(" > ")}`;
}

export function toRunnableRef(test: ListedTest): RunnableTestRef {
  return {
    testId: test.testId,
    file: test.relFile,
    line: test.line,
    title: test.title,
    titlePath: test.titlePath,
  };
}

export function readArtifacts(dir: string): VibehardArtifact[] {
  const out: VibehardArtifact[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    const parsed = parseArtifact(readFileSync(path.join(dir, name), "utf8"));
    if (parsed !== null) out.push(parsed);
  }
  return out;
}
