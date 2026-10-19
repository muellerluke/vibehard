import { readFileSync } from "node:fs";

import type { ScriptInput } from "../observer/types.js";
import { ENV_RESOLVE_MAP } from "./playwright/artifact.js";

let resolveMapCache: { urlEndsWith: string; path: string }[] | null | undefined;

export function loadResolveMap(): { urlEndsWith: string; path: string }[] {
  if (resolveMapCache !== undefined) return resolveMapCache ?? [];
  resolveMapCache = null;
  const file = process.env[ENV_RESOLVE_MAP];
  if (file !== undefined && file !== "") {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (Array.isArray(parsed)) {
        resolveMapCache = parsed.filter(
          (e): e is { urlEndsWith: string; path: string } =>
            typeof e === "object" && e !== null &&
            typeof (e as { urlEndsWith?: unknown }).urlEndsWith === "string" &&
            typeof (e as { path?: unknown }).path === "string",
        );
      }
    } catch {
      resolveMapCache = null;
    }
  }
  return resolveMapCache ?? [];
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) return null;
      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/** Make a browser coverage entry self-contained: source + source map embedded. */
export async function embedCoverageEntry(entry: {
  url: string;
  source?: string;
  functions: ScriptInput["functions"];
}): Promise<ScriptInput> {
  let source = entry.source ?? null;
  if (source === null && /^https?:\/\//.test(entry.url)) {
    source = await fetchText(entry.url);
  }
  let sourceMap: unknown = null;
  if (source !== null) {
    const ref = /sourceMappingURL=([^\s]+)/.exec(source.slice(-4096))?.[1];
    if (ref !== undefined && ref.startsWith("data:")) {
      try {
        const comma = ref.indexOf(",");
        const payload = ref.slice(comma + 1);
        const text = ref.includes("base64,")
          ? Buffer.from(payload, "base64").toString("utf8")
          : decodeURIComponent(payload);
        sourceMap = JSON.parse(text) as unknown;
      } catch {
        sourceMap = null;
      }
    } else if (ref !== undefined && /^https?:\/\//.test(entry.url)) {
      const mapText = await fetchText(new URL(ref, entry.url).href);
      if (mapText !== null) {
        try {
          sourceMap = JSON.parse(mapText) as unknown;
        } catch {
          sourceMap = null;
        }
      }
    }
  }
  let sourcePath: string | null = null;
  for (const rule of loadResolveMap()) {
    if (entry.url.endsWith(rule.urlEndsWith)) {
      sourcePath = rule.path;
      break;
    }
  }
  return { url: entry.url, origin: "client", functions: entry.functions, source, sourcePath, sourceMap };
}
