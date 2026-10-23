import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import {
  checkLockfile,
  emptyLockfile,
  INDEXER_VERSION,
  lockfileTrustReasons,
  parseLockfile,
  readLockfile,
  serializeLockfile,
  writeLockfile,
  type VibehardLockfile,
} from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "../../..");

const COMMITTED_LOCKFILES = [
  "fixtures/tiny-app/vibehard.lock.json",
  "fixtures/tiny-app/vibehard.puppeteer.lock.json",
  "examples/next-fullstack/vibehard.lock.json",
  "examples/next-express/vibehard.lock.json",
  "examples/next-cypress/vibehard.lock.json",
  "examples/plain-puppeteer/vibehard.lock.json",
  "examples/two-frontends/vibehard.lock.json",
];

/** Distinct valid 64-char lowercase hex hashes. */
function hash(n: number): string {
  return n.toString(16).padStart(64, "0");
}

const A = "src/a.ts#f";
const B = "src/a.ts#g";
const MOD = "src/a.ts#<module>";
const CLS = "src/b.ts#Widget";
const ASSET = "src/logo.svg#<file>";

/**
 * Hand-written v2 sample exercising every touch kind, an alwaysRun
 * entry, and a touched symbol with no recorded hash (fail-closed
 * unknown at trust time). This is the permanent v2 regression fixture.
 */
const V2_SAMPLE = {
  version: 2,
  framework: { name: "playwright", version: "1.59.0" },
  configHash: "cfg",
  graphVersion: INDEXER_VERSION,
  tests: {
    "e2e/a.spec.ts::one": {
      file: "e2e/a.spec.ts",
      titlePath: ["one"],
      touched: {
        [A]: "direct",
        [B]: "referenced",
        [MOD]: "module",
        [CLS]: "class",
        [ASSET]: "asset",
      },
      symbolHashes: {
        [A]: hash(1),
        [B]: hash(2),
        [MOD]: hash(3),
        [CLS]: hash(4),
        // ASSET deliberately has no recorded hash.
      },
    },
    "e2e/a.spec.ts::two": {
      file: "e2e/a.spec.ts",
      titlePath: ["two"],
      touched: { [A]: "direct" },
      symbolHashes: { [A]: hash(9) },
    },
    "e2e/b.spec.ts::always": {
      file: "e2e/b.spec.ts",
      titlePath: ["always"],
      touched: {},
      symbolHashes: {},
      alwaysRun: "flaky clock",
    },
  },
};

/** Serialize an in-memory lockfile in the retired v2 wire format. */
function serializeV2(lock: VibehardLockfile): string {
  const tests: Record<string, unknown> = {};
  for (const key of Object.keys(lock.tests).sort()) {
    const entry = lock.tests[key];
    if (entry === undefined) continue;
    const out: Record<string, unknown> = {
      file: entry.file,
      titlePath: [...entry.titlePath],
      touched: entry.touched,
      symbolHashes: entry.symbolHashes,
    };
    if (entry.alwaysRun !== undefined) out["alwaysRun"] = entry.alwaysRun;
    tests[key] = out;
  }
  return `${JSON.stringify(
    {
      version: 2,
      framework: lock.framework,
      configHash: lock.configHash,
      graphVersion: lock.graphVersion,
      tests,
    },
    null,
    2,
  )}\n`;
}

/** A minimal valid v3 document as a mutable object, for tamper cases. */
function v3Doc(): Record<string, unknown> {
  return {
    version: 3,
    framework: { name: "playwright", version: "1.59.0" },
    configHash: "cfg",
    graphVersion: INDEXER_VERSION,
    // Sorted by (id, hash): "#<module>" precedes "#f".
    symbols: [
      { id: MOD, h: hash(3) },
      { id: A, h: hash(1) },
      { id: B, h: hash(2) },
    ],
    tests: {
      "e2e/a.spec.ts::one": {
        file: "e2e/a.spec.ts",
        titlePath: ["one"],
        touched: { direct: [1], referenced: [2], module: [0] },
      },
    },
  };
}

function v3Text(mutate?: (doc: Record<string, unknown>) => void): string {
  const doc = v3Doc();
  if (mutate !== undefined) mutate(doc);
  return JSON.stringify(doc);
}

describe("AT-S05 lockfile v3", () => {
  it("v2 → internal → v3 → internal is lossless, incl. kinds, alwaysRun, missing hash", () => {
    const fromV2 = parseLockfile(JSON.stringify(V2_SAMPLE), "sample.lock.json");
    expect(fromV2.version).toBe(3);
    const v3 = serializeLockfile(fromV2);
    const parsed = JSON.parse(v3) as Record<string, unknown>;
    expect(parsed["version"]).toBe(3);
    expect(Array.isArray(parsed["symbols"])).toBe(true);
    expect(v3).not.toContain("symbolHashes");
    const fromV3 = parseLockfile(v3, "sample.lock.json");
    expect(fromV3).toEqual(fromV2);
    const one = fromV3.tests["e2e/a.spec.ts::one"];
    expect(one?.touched[CLS]).toBe("class");
    expect(one?.touched[ASSET]).toBe("asset");
    expect(one?.symbolHashes[ASSET]).toBeUndefined();
    expect(fromV3.tests["e2e/b.spec.ts::always"]?.alwaysRun).toBe("flaky clock");
    // Serialization is a fixed point.
    expect(serializeLockfile(fromV3)).toBe(v3);
  });

  it("interns by (id, hash) pair, preserving per-test hashes from partial re-records", () => {
    const fromV2 = parseLockfile(JSON.stringify(V2_SAMPLE), "sample.lock.json");
    const parsed = JSON.parse(serializeLockfile(fromV2)) as {
      symbols: { id: string; h?: string }[];
    };
    // A appears under two distinct hashes (hash(1), hash(9)); the rest once.
    expect(parsed.symbols.filter((s) => s.id === A)).toHaveLength(2);
    expect(parsed.symbols).toHaveLength(6);
    const asset = parsed.symbols.find((s) => s.id === ASSET);
    expect(asset).toBeDefined();
    expect(asset?.h).toBeUndefined();
    const fromV3 = parseLockfile(serializeLockfile(fromV2), "sample.lock.json");
    expect(fromV3.tests["e2e/a.spec.ts::one"]?.symbolHashes[A]).toBe(hash(1));
    expect(fromV3.tests["e2e/a.spec.ts::two"]?.symbolHashes[A]).toBe(hash(9));
  });

  it("committed lockfiles are canonical v3 and round-trip through v2 losslessly", () => {
    for (const rel of COMMITTED_LOCKFILES) {
      const abs = path.join(REPO_ROOT, rel);
      const text = readFileSync(abs, "utf8");
      const lock = parseLockfile(text, abs);
      expect(lock.version, rel).toBe(3);
      // The writer is canonical: re-serializing the committed file is
      // byte-identical, so verify on a clean tree stays written:false.
      expect(serializeLockfile(lock), rel).toBe(text);
      // The v2 reader still accepts the same data in the old format.
      expect(parseLockfile(serializeV2(lock), abs), rel).toEqual(lock);
    }
  });

  it("v3 is at least 5× smaller than v2 at synthetic scale", () => {
    const lock = emptyLockfile("cfg", "1.59.0", "playwright");
    const pool: string[] = [];
    for (let i = 0; i < 1000; i++) pool.push(`src/mod${i}.ts#fn${i}`);
    for (let t = 0; t < 300; t++) {
      const touched: Record<string, "direct"> = {};
      const symbolHashes: Record<string, string> = {};
      for (let k = 0; k < 100; k++) {
        const idx = (t * 7 + k * 3) % pool.length;
        const id = pool[idx] as string;
        touched[id] = "direct";
        symbolHashes[id] = hash(idx + 1);
      }
      lock.tests[`e2e/s${t % 50}.spec.ts::test ${t}`] = {
        file: `e2e/s${t % 50}.spec.ts`,
        titlePath: [`test ${t}`],
        touched,
        symbolHashes,
      };
    }
    const v3Bytes = Buffer.byteLength(serializeLockfile(lock));
    const v2Bytes = Buffer.byteLength(serializeV2(lock));
    expect(v3Bytes * 5).toBeLessThan(v2Bytes);
    expect(parseLockfile(serializeLockfile(lock), "synthetic.lock.json")).toEqual(lock);
  });

  it("checkLockfile and trust verdicts are identical for v2- and v3-parsed data", () => {
    const fromV2 = parseLockfile(JSON.stringify(V2_SAMPLE), "sample.lock.json");
    const fromV3 = parseLockfile(serializeLockfile(fromV2), "sample.lock.json");
    const expectations = [
      {
        testId: "e2e/a.spec.ts::one",
        touched: { [A]: "direct", [B]: "referenced", [MOD]: "module", [CLS]: "class", [ASSET]: "asset" },
        symbolHashes: { [A]: hash(1), [B]: hash(2), [MOD]: hash(3), [CLS]: hash(4) },
      },
    ];
    const input = {
      configHash: "cfg",
      frameworkVersion: "1.59.0",
      expectations,
      fullRun: false,
    };
    expect(checkLockfile(fromV2, input)).toEqual([]);
    expect(checkLockfile(fromV3, input)).toEqual(checkLockfile(fromV2, input));
    const tampered = {
      ...input,
      expectations: [
        { ...expectations[0], symbolHashes: { ...expectations[0]?.symbolHashes, [A]: hash(42) } },
      ],
    };
    const driftV2 = checkLockfile(fromV2, tampered as typeof input);
    expect(driftV2.some((d) => d.includes("source hash mismatch"))).toBe(true);
    expect(checkLockfile(fromV3, tampered as typeof input)).toEqual(driftV2);

    const resolved = { configHash: "cfg" } as Parameters<
      typeof lockfileTrustReasons
    >[0]["resolved"];
    const discoveredIds = new Set(["e2e/a.spec.ts::two"]);
    const trust = (lock: VibehardLockfile, baseHashes: Record<string, string>, headHashes: Record<string, string>) =>
      lockfileTrustReasons({
        lock,
        lockError: null,
        resolved,
        rootDir: REPO_ROOT,
        frameworkName: "playwright",
        frameworkVersion: "1.59.0",
        discoveredIds,
        baseHashes,
        headHashes,
      });
    for (const [base, head] of [
      [{ [A]: hash(9) }, { [A]: hash(1) }],
      [{ [A]: hash(1) }, { [A]: hash(9) }],
      [{ [A]: hash(1) }, { [A]: hash(1) }],
    ] as const) {
      expect(trust(fromV3, base, head)).toEqual(trust(fromV2, base, head));
    }
  });

  it("empty lockfile is v3 and round-trips byte-identically", () => {
    const lock = emptyLockfile("cfg", "1.59.0");
    expect(lock.version).toBe(3);
    const text = serializeLockfile(lock);
    expect(text.endsWith("\n")).toBe(true);
    expect(parseLockfile(text, "empty.lock.json")).toEqual(lock);
  });

  it("serialization is independent of in-memory insertion order", () => {
    const a = parseLockfile(JSON.stringify(V2_SAMPLE), "sample.lock.json");
    const b = parseLockfile(JSON.stringify(V2_SAMPLE), "sample.lock.json");
    const reversed: VibehardLockfile["tests"] = {};
    for (const key of Object.keys(b.tests).sort().reverse()) {
      const entry = b.tests[key];
      if (entry === undefined) continue;
      const touched: typeof entry.touched = {};
      for (const id of Object.keys(entry.touched).sort().reverse()) {
        const kind = entry.touched[id as keyof typeof entry.touched];
        if (kind !== undefined) touched[id] = kind;
      }
      reversed[key] = { ...entry, touched };
    }
    b.tests = reversed;
    expect(serializeLockfile(b)).toBe(serializeLockfile(a));
  });

  it("serializing an unknown touch kind fails instead of dropping the edge", () => {
    const lock = emptyLockfile("cfg", "1.59.0");
    lock.tests["e2e/a.spec.ts::one"] = {
      file: "e2e/a.spec.ts",
      titlePath: ["one"],
      touched: { [A]: "sideways" as "direct" },
      symbolHashes: { [A]: hash(1) },
    };
    expect(() => serializeLockfile(lock)).toThrow(/unknown touch kind/);
  });

  describe("strict v3 validation", () => {
    const bad: [string, (doc: Record<string, unknown>) => void][] = [
      ["out-of-range index", (d) => { ((d["tests"] as Record<string, { touched: { direct: number[] } }>)["e2e/a.spec.ts::one"] as { touched: { direct: number[] } }).touched.direct = [3]; }],
      ["negative index", (d) => { ((d["tests"] as Record<string, { touched: { direct: number[] } }>)["e2e/a.spec.ts::one"] as { touched: { direct: number[] } }).touched.direct = [-1]; }],
      ["non-integer index", (d) => { ((d["tests"] as Record<string, { touched: { direct: number[] } }>)["e2e/a.spec.ts::one"] as { touched: { direct: number[] } }).touched.direct = [1.5]; }],
      ["duplicate index within a group", (d) => { ((d["tests"] as Record<string, { touched: { direct: number[] } }>)["e2e/a.spec.ts::one"] as { touched: { direct: number[] } }).touched.direct = [0, 0]; }],
      ["duplicate index across groups", (d) => { ((d["tests"] as Record<string, { touched: { referenced: number[] } }>)["e2e/a.spec.ts::one"] as { touched: { referenced: number[] } }).touched.referenced = [0]; }],
      ["unsorted indexes", (d) => { ((d["tests"] as Record<string, { touched: Record<string, number[]> }>)["e2e/a.spec.ts::one"] as { touched: Record<string, number[]> }).touched = { direct: [2, 0] }; }],
      ["unsorted symbols", (d) => { (d["symbols"] as unknown[]).reverse(); }],
      ["duplicate (id, hash) pair", (d) => { (d["symbols"] as unknown[]).splice(2, 0, { id: A, h: hash(1) }); }],
      ["unknown touch kind", (d) => { ((d["tests"] as Record<string, { touched: Record<string, number[]> }>)["e2e/a.spec.ts::one"] as { touched: Record<string, number[]> }).touched = { sideways: [0] }; }],
      ["malformed hash", (d) => { (d["symbols"] as { h: string }[])[0]!.h = "xyz"; }],
      ["same symbol via two pairs in one test", (d) => {
        (d["symbols"] as unknown[]).splice(2, 0, { id: A, h: hash(7) });
        ((d["tests"] as Record<string, { touched: Record<string, number[]> }>)["e2e/a.spec.ts::one"] as { touched: Record<string, number[]> }).touched = { direct: [1, 2] };
      }],
      ["symbols not an array", (d) => { d["symbols"] = {}; }],
      ["unknown top-level key", (d) => { d["surprise"] = true; }],
      ["unknown test-entry key", (d) => { ((d["tests"] as Record<string, Record<string, unknown>>)["e2e/a.spec.ts::one"] as Record<string, unknown>)["surprise"] = true; }],
      ["non-string titlePath entry", (d) => { ((d["tests"] as Record<string, { titlePath: unknown[] }>)["e2e/a.spec.ts::one"] as { titlePath: unknown[] }).titlePath = [1]; }],
    ];
    for (const [name, mutate] of bad) {
      it(`rejects ${name}`, () => {
        expect(() => parseLockfile(v3Text(mutate), "bad.lock.json")).toThrow(/vibehard:/);
      });
    }
    it("accepts the unmutated document", () => {
      const lock = parseLockfile(v3Text(), "good.lock.json");
      expect(lock.tests["e2e/a.spec.ts::one"]?.touched).toEqual({
        [A]: "direct",
        [B]: "referenced",
        [MOD]: "module",
      });
      expect(lock.tests["e2e/a.spec.ts::one"]?.symbolHashes[A]).toBe(hash(1));
    });
  });

  describe("version handling", () => {
    it("keeps the v1 re-record message", () => {
      expect(() => parseLockfile(JSON.stringify({ version: 1, tests: {} }), "v1.lock.json"))
        .toThrow(/version 1/);
    });
    it("tells the user to upgrade for newer versions", () => {
      expect(() => parseLockfile(JSON.stringify({ version: 4, tests: {} }), "v4.lock.json"))
        .toThrow(/upgrade vibehard/);
    });
    it("rejects missing or non-numeric versions", () => {
      expect(() => parseLockfile(JSON.stringify({ tests: {} }), "x.lock.json"))
        .toThrow(/unsupported lockfile format/);
      expect(() => parseLockfile(JSON.stringify({ version: "3", tests: {} }), "x.lock.json"))
        .toThrow(/unsupported lockfile format/);
    });
  });

  describe("write/read round trip", () => {
    const dirs: string[] = [];
    afterAll(() => {
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    });
    it("writes v3 atomically and reports an unchanged second write", () => {
      const dir = mkdtempSync(path.join(REPO_ROOT, ".vh-test-"));
      dirs.push(dir);
      const p = path.join(dir, "vibehard.lock.json");
      const lock = parseLockfile(JSON.stringify(V2_SAMPLE), "sample.lock.json");
      expect(writeLockfile(p, lock)).toBe(true);
      expect(readFileSync(p, "utf8")).toContain('"version": 3');
      expect(readLockfile(p)).toEqual(lock);
      expect(writeLockfile(p, lock)).toBe(false);
    });
  });
});
