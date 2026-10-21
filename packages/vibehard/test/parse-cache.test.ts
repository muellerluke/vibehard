import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { SymbolRecord } from "../src/index.js";
import { createProjectParser, type ParsedFile } from "../src/indexer/index.js";
import { ParseCache, parseCacheEnabled, parseCacheKey } from "../src/selector/parse-cache.js";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "vibehard-parse-cache-"));
  tempDirs.push(dir);
  return dir;
}

const REL = "src/a.ts";
const TEXT = "export const a = 1;\nexport function f() { return a; }\n";

function parsedFixture(): ParsedFile {
  return createProjectParser(process.cwd()).parseFile(REL, TEXT);
}

describe("parseCacheKey", () => {
  it("varies with text, path, and TypeScript version", () => {
    const base = parseCacheKey(REL, TEXT, "5.7.2");
    expect(parseCacheKey(REL, TEXT, "5.7.2")).toBe(base);
    expect(parseCacheKey(REL, `${TEXT} `, "5.7.2")).not.toBe(base);
    expect(parseCacheKey("src/b.ts", TEXT, "5.7.2")).not.toBe(base);
    expect(parseCacheKey(REL, TEXT, "5.8.0")).not.toBe(base);
  });
});

describe("ParseCache", () => {
  it("round-trips a parsed file", () => {
    const cache = new ParseCache(path.join(makeTempDir(), "cache"));
    const parsed = parsedFixture();
    const key = parseCacheKey(REL, TEXT, "5.7.2");
    expect(cache.get(key, REL)).toBeNull();
    cache.set(key, parsed);
    expect(cache.get(key, REL)).toEqual(parsed);
    expect(cache.hits).toBe(1);
    expect(cache.misses).toBe(1);
  });

  it("round-trips stored symbol hashes and rejects malformed ones", () => {
    const dir = path.join(makeTempDir(), "cache");
    const cache = new ParseCache(dir);
    const parsed = parsedFixture();
    const key = parseCacheKey(REL, TEXT, "5.7.2");
    const hashes = { "src/a.ts#a": "a".repeat(64) };
    cache.set(key, parsed, hashes);
    expect(cache.get(key, REL)?.hashes).toEqual(hashes);
    writeFileSync(
      path.join(dir, `${key}.json`),
      JSON.stringify({ symbols: parsed.symbols, assetFiles: [], hashes: { x: "nope" } }),
    );
    expect(cache.get(key, REL)).toBeNull();
  });

  it("treats corrupt or malformed entries as misses and removes them", () => {
    const dir = path.join(makeTempDir(), "cache");
    const cache = new ParseCache(dir);
    const key = parseCacheKey(REL, TEXT, "5.7.2");
    const file = path.join(dir, `${key}.json`);
    writeFileSync(file, "not json{");
    expect(cache.get(key, REL)).toBeNull();
    writeFileSync(file, JSON.stringify({ symbols: [{ id: 42 }], assetFiles: [] }));
    expect(cache.get(key, REL)).toBeNull();
    // Symbols recorded for a different file are never served.
    const alien: SymbolRecord = {
      id: "src/other.ts#x",
      file: "src/other.ts",
      qualifiedName: "x",
      kind: "value",
      startOffset: 0,
      endOffset: 1,
      startLine: 1,
      endLine: 1,
    };
    writeFileSync(file, JSON.stringify({ symbols: [alien], assetFiles: [] }));
    expect(cache.get(key, REL)).toBeNull();
    expect(existsSync(file)).toBe(false);
  });

  it("async get/set round-trip and share entries with the sync API", async () => {
    const cache = new ParseCache(path.join(makeTempDir(), "cache"));
    const parsed = parsedFixture();
    const key = parseCacheKey(REL, TEXT, "5.7.2");
    const hashes = { "src/a.ts#a": "b".repeat(64) };
    expect(await cache.getAsync(key, REL)).toBeNull();
    await cache.setAsync(key, parsed, hashes);
    expect(await cache.getAsync(key, REL)).toEqual({ ...parsed, hashes });
    // Written async, readable sync (same on-disk shape).
    expect(cache.get(key, REL)).toEqual({ ...parsed, hashes });
    // Concurrent writes of one key settle on one valid entry.
    await Promise.all([
      cache.setAsync(key, parsed, hashes),
      cache.setAsync(key, parsed, hashes),
      cache.setAsync(key, parsed, hashes),
    ]);
    expect(await cache.getAsync(key, REL)).toEqual({ ...parsed, hashes });
  });

  it("async reads snapshot the directory once; new instances see later writes", async () => {
    const dir = path.join(makeTempDir(), "cache");
    const cache = new ParseCache(dir);
    const parsed = parsedFixture();
    const key = parseCacheKey(REL, TEXT, "5.7.2");
    // First async read snapshots the (empty) directory.
    expect(await cache.getAsync(key, REL)).toBeNull();
    // An entry written behind the snapshot (e.g. by another process)
    // reads as a miss for this instance, never as wrong data.
    writeFileSync(
      path.join(dir, `${key}.json`),
      JSON.stringify({ symbols: parsed.symbols, assetFiles: [] }),
    );
    expect(await cache.getAsync(key, REL)).toBeNull();
    const fresh = new ParseCache(dir);
    expect((await fresh.getAsync(key, REL))?.symbols).toEqual(parsed.symbols);
    // Entries written through the instance join its snapshot.
    const key2 = parseCacheKey(REL, `${TEXT}//2\n`, "5.7.2");
    await cache.setAsync(key2, parsed);
    expect((await cache.getAsync(key2, REL))?.symbols).toEqual(parsed.symbols);
  });

  it("does not rescan the directory on a write cadence far below the budget", async () => {
    const dir = path.join(makeTempDir(), "cache");
    const cache = new ParseCache(dir, { maxBytes: 1 << 30, pruneEveryWrites: 2 });
    const parsed = parsedFixture();
    for (let i = 0; i < 6; i += 1) {
      await cache.setAsync(parseCacheKey(REL, `${TEXT}//${i}\n`, "5.7.2"), parsed);
    }
    expect(readdirSync(dir).filter((n) => n.endsWith(".json"))).toHaveLength(6);
  });

  it("is a no-op when disabled (null dir)", () => {
    const cache = new ParseCache(null);
    const key = parseCacheKey(REL, TEXT, "5.7.2");
    cache.set(key, parsedFixture());
    expect(cache.get(key, REL)).toBeNull();
    expect(cache.hits).toBe(0);
    expect(cache.misses).toBe(1);
  });

  it("evicts oldest entries beyond the byte budget", () => {
    const dir = path.join(makeTempDir(), "cache");
    const cache = new ParseCache(dir, { maxBytes: 800, pruneEveryWrites: 1000 });
    const parsed = parsedFixture();
    const keys: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const key = parseCacheKey(REL, `${TEXT}// ${i}\n`, "5.7.2");
      keys.push(key);
      cache.set(key, parsed);
      const when = new Date(Date.now() - (6 - i) * 60_000);
      utimesSync(path.join(dir, `${key}.json`), when, when);
    }
    expect(readdirSync(dir).filter((n) => n.endsWith(".json"))).toHaveLength(6);
    cache.prune();
    const remaining = readdirSync(dir).filter((n) => n.endsWith(".json"));
    expect(remaining.length).toBeLessThan(6);
    // The newest entries survive.
    const newest = keys[keys.length - 1];
    expect(newest).toBeDefined();
    expect(cache.get(newest as string, REL)).toEqual(parsed);
  });

  it("survives an unwritable directory as a no-op cache", () => {
    const dir = makeTempDir();
    const blocker = path.join(dir, "blocker");
    writeFileSync(blocker, "a file, not a directory");
    const cache = new ParseCache(path.join(blocker, "cache"));
    expect(cache.dir).toBeNull();
    const key = parseCacheKey(REL, TEXT, "5.7.2");
    cache.set(key, parsedFixture());
    expect(cache.get(key, REL)).toBeNull();
  });
});

describe("parseCacheEnabled", () => {
  it("honours VIBEHARD_NO_CACHE", () => {
    expect(parseCacheEnabled({})).toBe(true);
    expect(parseCacheEnabled({ VIBEHARD_NO_CACHE: "0" })).toBe(true);
    expect(parseCacheEnabled({ VIBEHARD_NO_CACHE: "1" })).toBe(false);
    expect(parseCacheEnabled({ VIBEHARD_NO_CACHE: "true" })).toBe(false);
  });
});
