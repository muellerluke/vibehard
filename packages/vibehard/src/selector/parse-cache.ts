import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SymbolRecord } from "../index.js";
import { INDEXER_VERSION, type ParsedFile } from "../indexer/index.js";
import { resolveGitCommonDir, type GitRoot } from "./git.js";

const CACHE_FORMAT = 1;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

/** Whether the parse cache is enabled (`VIBEHARD_NO_CACHE=1` disables). */
export function parseCacheEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const raw = env["VIBEHARD_NO_CACHE"];
  return raw !== "1" && raw !== "true";
}

/**
 * Content key for one file's parse: everything that can change the
 * extracted records for the same text (indexer rules, TypeScript
 * version, and the path — symbol IDs and page/route kinds embed it).
 */
export function parseCacheKey(relPosix: string, text: string, typescriptVersion: string): string {
  return createHash("sha256")
    .update(String(CACHE_FORMAT))
    .update("\0")
    .update(String(INDEXER_VERSION))
    .update("\0")
    .update(typescriptVersion)
    .update("\0")
    .update(relPosix)
    .update("\0")
    .update(text)
    .digest("hex");
}

interface CacheFileShape {
  symbols: SymbolRecord[];
  assetFiles: string[];
  /** Per-symbol source hashes for `symbols` (deduped IDs), when stored. */
  hashes?: Record<string, string>;
}

/** A cached parse, with the symbol hashes stored alongside it if any. */
export type CachedParse = ParsedFile & { hashes?: Record<string, string> };

function isValidEntry(value: unknown, relPosix: string): value is CacheFileShape {
  if (value === null || typeof value !== "object") return false;
  const shape = value as Partial<CacheFileShape>;
  if (!Array.isArray(shape.symbols) || !Array.isArray(shape.assetFiles)) return false;
  if (shape.assetFiles.some((f) => typeof f !== "string")) return false;
  if (shape.hashes !== undefined) {
    if (shape.hashes === null || typeof shape.hashes !== "object" || Array.isArray(shape.hashes)) {
      return false;
    }
    for (const hash of Object.values(shape.hashes)) {
      if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) return false;
    }
  }
  for (const symbol of shape.symbols) {
    if (symbol === null || typeof symbol !== "object") return false;
    const s = symbol as SymbolRecord;
    if (
      typeof s.id !== "string" ||
      s.file !== relPosix ||
      !s.id.startsWith(`${relPosix}#`) ||
      typeof s.qualifiedName !== "string" ||
      typeof s.kind !== "string" ||
      !Number.isFinite(s.startOffset) ||
      !Number.isFinite(s.endOffset) ||
      !Number.isFinite(s.startLine) ||
      !Number.isFinite(s.endLine)
    ) {
      return false;
    }
    if (s.hashSlices !== undefined) {
      if (!Array.isArray(s.hashSlices)) return false;
      for (const slice of s.hashSlices) {
        if (
          slice === null ||
          typeof slice !== "object" ||
          !Number.isFinite(slice.startOffset) ||
          !Number.isFinite(slice.endOffset)
        ) {
          return false;
        }
      }
    }
  }
  return true;
}

export interface ParseCacheOptions {
  maxBytes?: number;
  /** Run eviction after this many writes (tests use small values). */
  pruneEveryWrites?: number;
}

/**
 * On-disk cache of parse-only extraction results, one JSON file per
 * content key under the git common dir (shared across worktrees,
 * never committed). Purely an optimisation: every failure mode —
 * missing directory, unreadable or malformed entry, failed write —
 * degrades to a cache miss, and deleting the directory can never
 * change results.
 */
function serializeEntry(parsed: ParsedFile, hashes?: Record<string, string>): string {
  const file: CacheFileShape = {
    symbols: parsed.symbols.map((s) => {
      const copy: SymbolRecord = { ...s };
      delete copy.references;
      return copy;
    }),
    assetFiles: [...parsed.assetFiles],
    ...(hashes !== undefined ? { hashes: { ...hashes } } : {}),
  };
  return JSON.stringify(file);
}

function toCachedParse(value: CacheFileShape): CachedParse {
  return {
    symbols: value.symbols,
    assetFiles: value.assetFiles,
    ...(value.hashes !== undefined ? { hashes: value.hashes } : {}),
  };
}

export class ParseCache {
  readonly dir: string | null;
  hits = 0;
  misses = 0;
  readonly #maxBytes: number;
  readonly #pruneEveryWrites: number;
  #writes = 0;
  #tmpCounter = 0;
  /** Entry keys known on disk, snapshotted on first async read. */
  #known: Set<string> | null = null;
  #knownPromise: Promise<Set<string>> | null = null;
  /** Approximate cache size once measured; gates prune scans. */
  #estimatedBytes: number | null = null;

  constructor(dir: string | null, options: ParseCacheOptions = {}) {
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#pruneEveryWrites = options.pruneEveryWrites ?? 64;
    if (dir === null) {
      this.dir = null;
      return;
    }
    try {
      mkdirSync(dir, { recursive: true });
      this.dir = dir;
    } catch {
      this.dir = null;
    }
  }

  /** Open the cache for a repo; a null-dir (no-op) cache on any doubt. */
  static async open(
    gitRoot: GitRoot,
    options: ParseCacheOptions & { enabled?: boolean } = {},
  ): Promise<ParseCache> {
    if (options.enabled === false) return new ParseCache(null, options);
    const common = await resolveGitCommonDir(gitRoot);
    if (common === null) return new ParseCache(null, options);
    return new ParseCache(path.join(common, "vibehard-cache", `v${CACHE_FORMAT}`), options);
  }

  get(key: string, relPosix: string): CachedParse | null {
    if (this.dir === null || (this.#known !== null && !this.#known.has(key))) {
      this.misses += 1;
      return null;
    }
    const file = path.join(this.dir, `${key}.json`);
    try {
      const value: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!isValidEntry(value, relPosix)) {
        this.misses += 1;
        try {
          rmSync(file, { force: true });
        } catch {
          // a later write will replace it atomically
        }
        return null;
      }
      this.hits += 1;
      return toCachedParse(value);
    } catch {
      this.misses += 1;
      return null;
    }
  }

  /**
   * Keys present on disk, listed once per cache instance. Entries
   * written by other processes after the snapshot simply read as
   * misses (recomputed and overwritten atomically); entries deleted
   * after it fail their read as misses. Correctness never depends
   * on the snapshot being current — it exists so a cold run does
   * not pay one doomed file read per source file.
   */
  async #index(): Promise<Set<string>> {
    if (this.#known !== null) return this.#known;
    this.#knownPromise ??= (async () => {
      const known = new Set<string>();
      if (this.dir !== null) {
        try {
          for (const name of await readdir(this.dir)) {
            if (name.endsWith(".json")) known.add(name.slice(0, -".json".length));
          }
        } catch {
          // unreadable dir: every read misses, writes still attempted
        }
      }
      this.#known = known;
      return known;
    })();
    return this.#knownPromise;
  }

  /** Async `get`: file reads run on the libuv threadpool, off-thread. */
  async getAsync(key: string, relPosix: string): Promise<CachedParse | null> {
    if (this.dir === null) {
      this.misses += 1;
      return null;
    }
    if (!(await this.#index()).has(key)) {
      this.misses += 1;
      return null;
    }
    const file = path.join(this.dir, `${key}.json`);
    try {
      const value: unknown = JSON.parse(await readFile(file, "utf8"));
      if (!isValidEntry(value, relPosix)) {
        this.misses += 1;
        this.#known?.delete(key);
        await rm(file, { force: true }).catch(() => undefined);
        return null;
      }
      this.hits += 1;
      return toCachedParse(value);
    } catch {
      this.misses += 1;
      return null;
    }
  }

  set(key: string, parsed: ParsedFile, hashes?: Record<string, string>): void {
    if (this.dir === null) return;
    const tmp = path.join(this.dir, `${key}.tmp-${process.pid}-${this.#tmpCounter++}`);
    const data = serializeEntry(parsed, hashes);
    try {
      writeFileSync(tmp, data);
      renameSync(tmp, path.join(this.dir, `${key}.json`));
    } catch {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // cache writes are best-effort
      }
      return;
    }
    this.#known?.add(key);
    this.#noteWrite(Buffer.byteLength(data));
  }

  /** Async `set`: write + rename run on the libuv threadpool. */
  async setAsync(
    key: string,
    parsed: ParsedFile,
    hashes?: Record<string, string>,
  ): Promise<void> {
    if (this.dir === null) return;
    const tmp = path.join(this.dir, `${key}.tmp-${process.pid}-${this.#tmpCounter++}`);
    const data = serializeEntry(parsed, hashes);
    try {
      await writeFile(tmp, data);
      await rename(tmp, path.join(this.dir, `${key}.json`));
    } catch {
      await rm(tmp, { force: true }).catch(() => undefined);
      return;
    }
    this.#known?.add(key);
    this.#noteWrite(Buffer.byteLength(data));
  }

  /**
   * Record one successful write and maybe evict. Prune scans are
   * O(entries) `stat` calls, so they only run once the measured
   * cache size plus this session's writes can exceed the budget —
   * scanning on a fixed write cadence made cold bulk writes
   * quadratic in entry count.
   */
  #noteWrite(bytes: number): void {
    this.#writes += 1;
    if (this.#estimatedBytes !== null) this.#estimatedBytes += bytes;
    if (this.#writes % this.#pruneEveryWrites !== 0) return;
    if (this.#estimatedBytes === null) {
      this.#estimatedBytes = this.#scan().total;
    }
    if (this.#estimatedBytes > this.#maxBytes) this.prune();
  }

  #scan(): { entries: { file: string; size: number; mtimeMs: number }[]; total: number } {
    const entries: { file: string; size: number; mtimeMs: number }[] = [];
    let total = 0;
    if (this.dir === null) return { entries, total };
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(this.dir, name);
      try {
        const stat = statSync(file);
        entries.push({ file, size: stat.size, mtimeMs: stat.mtimeMs });
        total += stat.size;
      } catch {
        // raced with another process; ignore
      }
    }
    return { entries, total };
  }

  /** Evict oldest entries until the cache is within its byte budget. */
  prune(): void {
    if (this.dir === null) return;
    try {
      const { entries, total: scanned } = this.#scan();
      let total = scanned;
      this.#estimatedBytes = total;
      if (total <= this.#maxBytes) return;
      entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
      const target = Math.floor(this.#maxBytes * 0.8);
      for (const entry of entries) {
        if (total <= target) break;
        try {
          rmSync(entry.file, { force: true });
          total -= entry.size;
          const name = path.basename(entry.file);
          this.#known?.delete(name.slice(0, -".json".length));
        } catch {
          // best-effort
        }
      }
      this.#estimatedBytes = total;
    } catch {
      // eviction is best-effort; an oversized cache is still correct
    }
  }
}
