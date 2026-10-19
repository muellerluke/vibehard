import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { initProject, loadConfig, type VibehardConfig } from "../src/index.js";
import { runCli } from "../src/cli/index.js";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function makeProject(input: {
  deps: Record<string, string>;
  dirs?: string[];
  files?: Record<string, string>;
}): string {
  const dir = mkdtempSync(path.join(tmpdir(), "vibehard-init-"));
  tempDirs.push(dir);
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "fixture", private: true, dependencies: input.deps }),
  );
  for (const rel of input.dirs ?? []) mkdirSync(path.join(dir, rel), { recursive: true });
  for (const [rel, content] of Object.entries(input.files ?? {})) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

function writtenConfig(dir: string): VibehardConfig {
  return JSON.parse(
    readFileSync(path.join(dir, "vibehard.config.json"), "utf8"),
  ) as VibehardConfig;
}

describe("Stage 5: vibehard init detection", () => {
  it("detects a Next App Router project and writes a loadable config", async () => {
    const dir = makeProject({
      deps: { next: "16.4.2", "@playwright/test": "^1.59.0" },
      dirs: ["src/app", "e2e"],
    });
    const result = initProject({ rootDir: dir });
    expect(result.written).toBe(true);
    expect(result.alreadyWired).toBe(false);
    expect(result.detection).toMatchObject({
      framework: "playwright",
      appShape: "next",
      next: { appRouter: true, pagesRouter: false },
      express: false,
      testDir: "e2e",
    });
    const config = writtenConfig(dir);
    expect(config.app?.args?.join(" ")).toContain("next start");
    expect(config.ignore).toEqual(["next-env.d.ts"]);
    expect(result.instructions.join("\n")).toContain("productionBrowserSourceMaps");
    // The written config must pass the real config loader.
    await expect(loadConfig(dir)).resolves.toMatchObject({ rootDir: dir });
  });

  it("detects a Next Pages Router project and testDir from playwright.config", () => {
    const dir = makeProject({
      deps: { next: "16.4.2", playwright: "1.59.0" },
      dirs: ["pages", "specs"],
      files: {
        "playwright.config.ts":
          "export default { testDir: './specs' };\n",
      },
    });
    const result = initProject({ rootDir: dir });
    expect(result.detection?.next).toEqual({ appRouter: false, pagesRouter: true });
    expect(result.detection?.testDir).toBe("specs");
  });

  it("detects an Express backend and emits a labeled servers stub", () => {
    const dir = makeProject({
      deps: { next: "16.4.2", express: "5.3.0", "@playwright/test": "^1.59.0" },
      dirs: ["src/app", "e2e"],
    });
    const result = initProject({ rootDir: dir });
    expect(result.detection?.express).toBe(true);
    const config = writtenConfig(dir);
    expect(config.servers?.[0]?.name).toBe("api");
    expect(config.servers?.[0]?.args?.[0]).toContain("TODO");
    expect(config.app?.env?.["API_URL"]).toContain("{port:api}");
    expect(result.instructions.join("\n")).toContain("Separate backend");
  });

  it("writes TODO placeholders for a generic (non-Next) Playwright app", () => {
    const dir = makeProject({ deps: { "@playwright/test": "^1.59.0" }, dirs: ["tests"] });
    const result = initProject({ rootDir: dir });
    expect(result.detection?.appShape).toBe("generic");
    expect(result.detection?.testDir).toBe("tests");
    expect(writtenConfig(dir).app?.command).toContain("TODO");
  });

  it("never overwrites an existing config (already wired)", () => {
    const existing = '{"framework":"playwright","testDir":"custom"}\n';
    const dir = makeProject({
      deps: { next: "16.4.2", "@playwright/test": "^1.59.0" },
      dirs: ["app"],
      files: { "vibehard.config.json": existing },
    });
    const result = initProject({ rootDir: dir });
    expect(result.alreadyWired).toBe(true);
    expect(result.written).toBe(false);
    expect(readFileSync(path.join(dir, "vibehard.config.json"), "utf8")).toBe(existing);
  });

  it("rejects missing package.json, missing framework, and Stage 6 frameworks", () => {
    const empty = mkdtempSync(path.join(tmpdir(), "vibehard-init-empty-"));
    tempDirs.push(empty);
    expect(() => initProject({ rootDir: empty })).toThrow(/no package\.json/);

    const bare = makeProject({ deps: { react: "19.3.1" } });
    expect(() => initProject({ rootDir: bare })).toThrow(/no e2e framework/);

    const puppeteer = makeProject({ deps: { puppeteer: "^24.0.0" } });
    expect(() => initProject({ rootDir: puppeteer })).toThrow(/Stage 6/);

    const cypress = makeProject({ deps: { cypress: "^15.0.0" } });
    expect(() => initProject({ rootDir: cypress })).toThrow(/Stage 6/);
  });

  it("works through the CLI, including --json and a second already-wired run", async () => {
    const dir = makeProject({
      deps: { next: "16.4.2", "@playwright/test": "^1.59.0" },
      dirs: ["src/app", "src/pages", "e2e"],
    });
    const first = await runCli(["init", "--json"], { cwd: dir });
    expect(first.exitCode).toBe(0);
    const parsed = JSON.parse(first.stdout) as {
      command: string;
      detection: { next: { appRouter: boolean; pagesRouter: boolean } };
    };
    expect(parsed.command).toBe("init");
    expect(parsed.detection.next).toEqual({ appRouter: true, pagesRouter: true });
    expect(existsSync(path.join(dir, "vibehard.config.json"))).toBe(true);

    const second = await runCli(["init"], { cwd: dir });
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("already wired");

    expect((await runCli(["init", "extra"], { cwd: dir })).exitCode).toBe(3);
    expect((await runCli(["init", "--wat"], { cwd: dir })).exitCode).toBe(3);
  });
});
