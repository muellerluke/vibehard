import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { indexProject } from "../src/indexer/index.js";
import {
  baseTrackedFiles,
  readBaseFiles,
  resolveBase,
  resolveGitCommonDir,
  resolveGitRoot,
  type GitRoot,
} from "../src/selector/git.js";
import { hashAssetBytes, hashSymbolSources, hashSymbolTexts } from "../src/verifier/lockfile.js";
import { spawnCapture } from "../src/verifier/servers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "../../..");
const TINY_APP = path.join(REPO_ROOT, "fixtures/tiny-app");
const TIMEOUT = 60_000;

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
  // Realpath so the dir matches git's --show-toplevel form on macOS
  // (where the temp root is a /var -> /private/var symlink).
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "vibehard-git-batch-")));
  tempDirs.push(dir);
  return dir;
}

async function git(cwd: string, args: string[]): Promise<void> {
  const r = await spawnCapture("git", args, { cwd, timeoutMs: 60_000 });
  expect(r.exitCode, `git ${args.join(" ")}: ${r.stderr}`).toBe(0);
}

function write(dir: string, rel: string, data: string | Buffer): void {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, data);
}

describe("git cat-file batch readers", () => {
  let dir: string;
  let gitRoot: GitRoot;
  let baseSha: string;
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x0a, 0x0d, 0x80]);

  beforeAll(async () => {
    dir = makeTempDir();
    write(dir, "src/a.ts", "export const a = 1;\n");
    write(dir, "src/with space.ts", "export const s = 2;\n");
    write(dir, "assets/logo.png", pngBytes);
    write(dir, "empty.txt", "");
    write(dir, ".gitattributes", "crlf.txt text eol=crlf\n");
    write(dir, "crlf.txt", "one\ntwo\n");
    await git(dir, ["init", "-b", "main"]);
    await git(dir, ["config", "user.email", "test@example.invalid"]);
    await git(dir, ["config", "user.name", "Batch Test"]);
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "base"]);
    // Re-smudge crlf.txt so the working tree holds the CRLF form.
    rmSync(path.join(dir, "crlf.txt"));
    await git(dir, ["checkout", "--", "crlf.txt"]);
    gitRoot = await resolveGitRoot(dir);
    baseSha = (await resolveBase(gitRoot, {})).sha;
  }, TIMEOUT);

  it("reads text, binary, empty, and missing files in one batch", async () => {
    const files = ["src/a.ts", "assets/logo.png", "empty.txt", "nope.ts", "src/with space.ts"];
    const got = await readBaseFiles(gitRoot, baseSha, files);
    expect(got.get("src/a.ts")?.toString("utf8")).toBe("export const a = 1;\n");
    expect(got.get("assets/logo.png")).toEqual(pngBytes);
    expect(got.get("empty.txt")).toEqual(Buffer.alloc(0));
    expect(got.get("nope.ts")).toBeNull();
    expect(got.get("src/with space.ts")?.toString("utf8")).toBe("export const s = 2;\n");
  }, TIMEOUT);

  it("applies working-tree filters (CRLF) like a base worktree checkout", async () => {
    const worktreeBytes = readFileSync(path.join(dir, "crlf.txt"));
    expect(worktreeBytes.toString("utf8")).toContain("\r\n");
    const got = await readBaseFiles(gitRoot, baseSha, ["crlf.txt"]);
    expect(got.get("crlf.txt")).toEqual(worktreeBytes);
  }, TIMEOUT);

  it("reports tracked files without reading contents", async () => {
    const tracked = await baseTrackedFiles(gitRoot, baseSha, [
      "src/a.ts",
      "nope.ts",
      "assets/logo.png",
    ]);
    expect([...tracked].sort()).toEqual(["assets/logo.png", "src/a.ts"]);
    expect(await baseTrackedFiles(gitRoot, baseSha, [])).toEqual(new Set());
  }, TIMEOUT);

  it("resolves the common dir inside the repo", async () => {
    const common = await resolveGitCommonDir(gitRoot);
    expect(common).not.toBeNull();
    expect(path.basename(common as string)).toBe(".git");
  }, TIMEOUT);
});

describe("text/byte hashing equals disk hashing", () => {
  it("hashSymbolTexts matches hashSymbolSources on tiny-app", async () => {
    const full = await indexProject(TINY_APP);
    const nonAssets = full.symbols.filter((s) => s.kind !== "asset");
    const texts = new Map<string, string>();
    for (const file of new Set(nonAssets.map((s) => s.file))) {
      texts.set(file, readFileSync(path.join(TINY_APP, file), "utf8"));
    }
    expect(hashSymbolTexts(texts, nonAssets)).toEqual(hashSymbolSources(TINY_APP, nonAssets));
    // Missing texts are omitted, never guessed.
    expect(hashSymbolTexts(new Map(), nonAssets)).toEqual({});
  }, TIMEOUT);

  it("hashAssetBytes matches the asset hash from hashSymbolSources", async () => {
    const full = await indexProject(TINY_APP);
    const assets = full.symbols.filter((s) => s.kind === "asset");
    // tiny-app may have no assets; synthesize the equivalence directly.
    const data = Buffer.from([0x00, 0x9f, 0x92, 0xff, 0x0a]);
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "a.bin"), data);
    const record = {
      id: "a.bin#<file>",
      file: "a.bin",
      qualifiedName: "<file>",
      kind: "asset" as const,
      startOffset: 0,
      endOffset: data.length,
      startLine: 1,
      endLine: 1,
    };
    expect(hashSymbolSources(dir, [record])["a.bin#<file>"]).toBe(hashAssetBytes(data));
    void assets;
  }, TIMEOUT);
});
