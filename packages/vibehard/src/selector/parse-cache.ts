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
export class ParseCache {
  readonly dir: string | null;
  hits = 0;
  misses = 0;
  readonly #maxBytes: number;
  readonly #pruneEveryWrites: number;
  #writes = 0;

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
    if (this.dir === null) {
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
      return {
        symbols: value.symbols,
        assetFiles: value.assetFiles,
        ...(value.hashes !== undefined ? { hashes: value.hashes } : {}),
      };
    } catch {
      this.misses += 1;
      return null;
    }
  }

  set(key: string, parsed: ParsedFile, hashes?: Record<string, string>): void {
    if (this.dir === null) return;
    const file: CacheFileShape = {
      symbols: parsed.symbols.map((s) => {
        const copy: SymbolRecord = { ...s };
        delete copy.references;
        return copy;
      }),
      assetFiles: [...parsed.assetFiles],
      ...(hashes !== undefined ? { hashes: { ...hashes } } : {}),
    };
    const tmp = path.join(this.dir, `${key}.tmp-${process.pid}-${this.#writes}`);
    try {
      writeFileSync(tmp, JSON.stringify(file));
      renameSync(tmp, path.join(this.dir, `${key}.json`));
    } catch {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // cache writes are best-effort
      }
      return;
    }
    this.#writes += 1;
    if (this.#writes % this.#pruneEveryWrites === 0) this.prune();
  }

  /** Evict oldest entries until the cache is within its byte budget. */
  prune(): void {
    if (this.dir === null) return;
    try {
      const entries: { file: string; size: number; mtimeMs: number }[] = [];
      let total = 0;
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
      if (total <= this.#maxBytes) return;
      entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
      const target = Math.floor(this.#maxBytes * 0.8);
      for (const entry of entries) {
        if (total <= target) break;
        try {
          rmSync(entry.file, { force: true });
          total -= entry.size;
        } catch {
          // best-effort
        }
      }
    } catch {
      // eviction is best-effort; an oversized cache is still correct
    }
  }
}
