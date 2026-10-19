import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { loadConfig, startServers, verifyProject } from "../src/index.js";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function makeProject(config: unknown, files: Record<string, string> = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), "vibehard-config-"));
  tempDirs.push(dir);
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture" }));
  writeFileSync(path.join(dir, "vibehard.config.json"), JSON.stringify(config));
  for (const [rel, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

const API_SERVER = [
  'import { createServer } from "node:http";',
  'const port = Number(process.env["API_PORT"] ?? "0");',
  "const server = createServer((req, res) => {",
  '  res.writeHead(200, { "content-type": "application/json" });',
  '  res.end(JSON.stringify({ sawAppPort: process.env["APP_PORT"] ?? null }));',
  "});",
  'server.listen(port, "127.0.0.1");',
  'process.on("SIGTERM", () => server.close(() => process.exit(0)));',
  "",
].join("\n");

describe("Stage 5: servers + external config", () => {
  it("validates servers entries (names, duplicates, external)", async () => {
    const base = { framework: "playwright" };
    const dup = makeProject({
      ...base,
      servers: [
        { name: "api", command: "node", url: "http://127.0.0.1:{port}" },
        { name: "api", command: "node", url: "http://127.0.0.1:{port}" },
      ],
    });
    await expect(loadConfig(dup)).rejects.toThrow(/duplicate servers/);

    const reserved = makeProject({
      ...base,
      servers: [{ name: "app", command: "node", url: "http://127.0.0.1:{port}" }],
    });
    await expect(loadConfig(reserved)).rejects.toThrow(/reserved/);

    const badName = makeProject({
      ...base,
      servers: [{ name: "1api", command: "node", url: "http://127.0.0.1:{port}" }],
    });
    await expect(loadConfig(badName)).rejects.toThrow(/servers\[\]\.name/);

    const externalServer = makeProject({
      ...base,
      servers: [
        { name: "api", command: "node", url: "http://127.0.0.1:{port}", external: true },
      ],
    });
    await expect(loadConfig(externalServer)).rejects.toThrow(/not supported/);
  });

  it("accepts app.external at load, rejects it in verify/record", async () => {
    const dir = makeProject({
      framework: "playwright",
      app: { command: "node", url: "http://127.0.0.1:3000", external: true },
    });
    await expect(loadConfig(dir)).resolves.toMatchObject({ rootDir: dir });
    await expect(verifyProject({ rootDir: dir })).rejects.toThrow(
      /app\.external cannot be verified or recorded/,
    );
  });

  it("startServers starts labeled servers, substitutes ports, skips an external app", async () => {
    const dir = makeProject(
      {
        framework: "playwright",
        app: { command: "node", url: "http://127.0.0.1:3999", external: true },
        servers: [
          {
            name: "api",
            command: "node",
            args: ["api.mjs"],
            url: "http://127.0.0.1:{port}",
            env: { API_PORT: "{port}", APP_PORT: "3999" },
          },
        ],
      },
      { "api.mjs": API_SERVER },
    );
    const resolved = await loadConfig(dir);
    const session = await startServers(resolved);
    try {
      expect(session.baseUrl).toBe("http://127.0.0.1:3999");
      expect(session.children).toHaveLength(1);
      const apiUrl = session.urls["api"];
      expect(apiUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(session.env["VIBEHARD_API_URL"]).toBe(apiUrl);
      expect(session.env["VIBEHARD_BASE_URL"]).toBe("http://127.0.0.1:3999");
      const body = (await (await fetch(`${apiUrl}/`)).json()) as { sawAppPort: string };
      expect(body.sawAppPort).toBe("3999");
    } finally {
      const scripts = await session.stop();
      expect(scripts.length).toBeGreaterThan(0);
    }
  });

  it("startServers rejects an unknown {port:<name>} reference", async () => {
    const dir = makeProject(
      {
        framework: "playwright",
        app: {
          command: "node",
          args: ["api.mjs"],
          url: "http://127.0.0.1:{port}",
          env: { API_PORT: "{port}", OTHER: "{port:missing}" },
        },
      },
      { "api.mjs": API_SERVER },
    );
    const resolved = await loadConfig(dir);
    await expect(startServers(resolved)).rejects.toThrow(/unknown server/);
  });
});
