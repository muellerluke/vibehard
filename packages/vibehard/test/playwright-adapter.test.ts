import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  interface FakeCall {
    label: string;
    args: unknown[];
  }
  const calls: FakeCall[] = [];
  function makeFake(label: string): ((...args: unknown[]) => void) & Record<string, unknown> {
    const fn = (...args: unknown[]): void => {
      calls.push({ label, args });
    };
    const fake = fn as ((...args: unknown[]) => void) & Record<string, unknown>;
    fake["only"] = (...args: unknown[]): void => {
      calls.push({ label: `${label}.only`, args });
    };
    fake["extend"] = (): unknown => makeFake(`${label}.ext`);
    fake["describe"] = (): void => undefined;
    fake["use"] = (): void => undefined;
    return fake;
  }
  return { calls, base: makeFake("base") };
});

vi.mock("@playwright/test", () => ({
  test: hoisted.base,
  expect: { __fakeExpect: true },
}));

import {
  artifactFileName,
  decodeDeclaration,
  defineUses,
  encodeDeclaration,
  test,
} from "../src/adapters/playwright/index.js";
import type { VibehardTestOptions } from "../src/adapters/playwright/index.js";

function lastAnnotation(): { type: string; description?: string } {
  const call = hoisted.calls[hoisted.calls.length - 1];
  const details = call?.args[1] as { annotation: { type: string; description?: string } };
  return details.annotation;
}

beforeEach(() => {
  hoisted.calls.length = 0;
});

describe("vibehard/playwright wrapper (mocked base)", () => {
  it("test(title, fn) registers an undeclared annotation", () => {
    const fn = async (): Promise<void> => undefined;
    test("plain", fn as never);
    expect(hoisted.calls).toHaveLength(1);
    expect(hoisted.calls[0]?.label).toBe("base.ext");
    expect(hoisted.calls[0]?.args[0]).toBe("plain");
    expect(hoisted.calls[0]?.args[2]).toBe(fn);
    expect(decodeDeclaration([lastAnnotation()])).toEqual({
      uses: null,
      allowTransitive: [],
      skipVerify: null,
    });
  });

  it("test(title, opts, fn) encodes the declaration", () => {
    const fn = async (): Promise<void> => undefined;
    const opts: VibehardTestOptions = {
      uses: ["src/a.ts#A"],
      allowTransitive: ["src/lib/**"],
      skipVerify: "flaky",
    };
    test("declared", opts, fn as never);
    expect(decodeDeclaration([lastAnnotation()])).toEqual({
      uses: ["src/a.ts#A"],
      allowTransitive: ["src/lib/**"],
      skipVerify: "flaky",
    });
  });

  it("test.only routes through the wrapped only", () => {
    test.only("focused", { uses: [] }, (async (): Promise<void> => undefined) as never);
    expect(hoisted.calls[0]?.label).toBe("base.ext.only");
  });

  it("rejects malformed options at collection time", () => {
    expect(() =>
      test("bad", { uses: [42] } as unknown as VibehardTestOptions, (async () => undefined) as never),
    ).toThrow(TypeError);
    expect(hoisted.calls).toHaveLength(0);
  });

  it("exposes pass-through members from the extended test", () => {
    expect(typeof test.describe).toBe("function");
    expect(typeof test.use).toBe("function");
    expect(typeof test.extend).toBe("function");
  });

  it("encode/decode round-trips and artifact names are stable", () => {
    const encoded = encodeDeclaration({ uses: ["a.ts#A"] });
    expect(decodeDeclaration([{ type: "vibehard.uses", description: encoded }]).uses).toEqual([
      "a.ts#A",
    ]);
    expect(decodeDeclaration([{ type: "other" }]).uses).toBeNull();
    expect(artifactFileName("/x/a.spec.ts", 3, "t")).toBe(artifactFileName("/x/a.spec.ts", 3, "t"));
    expect(artifactFileName("/x/a.spec.ts", 3, "t")).not.toBe(
      artifactFileName("/x/a.spec.ts", 4, "t"),
    );
    expect(defineUses({ uses: [] })).toEqual({ uses: [] });
  });
});
