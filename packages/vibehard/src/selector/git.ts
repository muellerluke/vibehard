import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { spawnCapture, spawnCaptureBuffer } from "../verifier/servers.js";
import { VibehardUsageError } from "../verifier/types.js";
import type { ResolvedBase } from "./types.js";

export interface GitRoot {
  /** Absolute git working-tree root. */
  toplevel: string;
  /** POSIX path of the project root relative to `toplevel` ("" when equal). */
  prefix: string;
}

export type ChangedFileStatus = "A" | "M" | "D" | "T" | "U" | "?";

export interface ChangedFile {
  /** POSIX path relative to the project root. */
  file: string;
  status: ChangedFileStatus;
}

async function git(
  cwd: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    return await spawnCapture("git", args, { cwd, timeoutMs: 120_000 });
  } catch (error) {
    throw new VibehardUsageError(
      `vibehard: failed to run git: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function gitOk(cwd: string, args: string[], what: string): Promise<string> {
  const result = await git(cwd, args);
  if (result.exitCode !== 0) {
    throw new VibehardUsageError(
      `vibehard: ${what} failed (git exit ${result.exitCode})\n${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result.stdout;
}

/** Locate the git root containing `rootDir`; throws when not in a repo. */
export async function resolveGitRoot(rootDir: string): Promise<GitRoot> {
  const root = path.resolve(rootDir);
  const result = await git(root, ["rev-parse", "--show-toplevel"]);
  if (result.exitCode !== 0) {
    throw new VibehardUsageError(
      `vibehard: ${root} is not inside a git repository (vibehard test needs git to compute the change set)`,
    );
  }
  const toplevel = result.stdout.trim();
  const prefix = path.relative(toplevel, root).split(path.sep).join("/");
  return { toplevel, prefix: prefix === "." ? "" : prefix };
}

async function revParseCommit(cwd: string, ref: string): Promise<string | null> {
  const result = await git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

/**
 * Resolve the comparison base. An explicit ref is used verbatim; otherwise
 * the merge-base with the configured base branch, falling back to HEAD.
 */
export async function resolveBase(
  gitRoot: GitRoot,
  options: { baseRef?: string; baseBranch?: string },
): Promise<ResolvedBase> {
  const cwd = gitRoot.toplevel;
  if (options.baseRef !== undefined) {
    const sha = await revParseCommit(cwd, options.baseRef);
    if (sha === null) {
      throw new VibehardUsageError(
        `vibehard: --base "${options.baseRef}" does not resolve to a commit`,
      );
    }
    return { ref: options.baseRef, sha, description: `explicit --base ${options.baseRef}` };
  }
  if (options.baseBranch !== undefined) {
    if ((await revParseCommit(cwd, options.baseBranch)) === null) {
      throw new VibehardUsageError(
        `vibehard: configured baseBranch "${options.baseBranch}" does not resolve to a commit (fetch it first?)`,
      );
    }
    if ((await revParseCommit(cwd, "HEAD")) === null) {
      throw new VibehardUsageError("vibehard: HEAD does not resolve to a commit (empty repository?)");
    }
    const sha = (await gitOk(cwd, ["merge-base", options.baseBranch, "HEAD"], "git merge-base")).trim();
    return { ref: sha, sha, description: `merge-base with ${options.baseBranch}` };
  }
  const sha = await revParseCommit(cwd, "HEAD");
  if (sha === null) {
    throw new VibehardUsageError("vibehard: HEAD does not resolve to a commit (empty repository?)");
  }
  return { ref: "HEAD", sha, description: "HEAD" };
}

function pathspec(gitRoot: GitRoot): string {
  return gitRoot.prefix === "" ? "." : gitRoot.prefix;
}

function toProjectRelative(gitRoot: GitRoot, toplevelRelative: string): string | null {
  if (gitRoot.prefix === "") return toplevelRelative;
  const head = `${gitRoot.prefix}/`;
  return toplevelRelative.startsWith(head) ? toplevelRelative.slice(head.length) : null;
}

/**
 * Every file under the project root that differs between the base commit
 * and the working tree: tracked changes from `git diff <base>` (staged and
 * unstaged) plus untracked files, which `git diff` never lists.
 */
export async function listChangedFiles(
  gitRoot: GitRoot,
  baseSha: string,
): Promise<ChangedFile[]> {
  const cwd = gitRoot.toplevel;
  const spec = pathspec(gitRoot);
  const byFile = new Map<string, ChangedFileStatus>();

  const diffOut = await gitOk(
    cwd,
    ["diff", "--no-renames", "--name-status", "-z", baseSha, "--", spec],
    "git diff --name-status",
  );
  const fields = diffOut.split("\0");
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const status = (fields[i] ?? "").trim();
    const file = fields[i + 1] ?? "";
    if (status === "" || file === "") continue;
    // With --no-renames every entry is a single path; the status may still
    // carry a score suffix in other modes, so keep only the letter.
    const letter = status[0] ?? "M";
    const rel = toProjectRelative(gitRoot, file);
    if (rel === null) continue;
    byFile.set(rel, (["A", "M", "D", "T", "U"].includes(letter) ? letter : "M") as ChangedFileStatus);
  }

  const untrackedOut = await gitOk(
    cwd,
    ["ls-files", "--others", "--exclude-standard", "-z", "--", spec],
    "git ls-files",
  );
  for (const file of untrackedOut.split("\0")) {
    if (file === "") continue;
    const rel = toProjectRelative(gitRoot, file);
    if (rel === null || byFile.has(rel)) continue;
    byFile.set(rel, "?");
  }

  return [...byFile.entries()]
    .map(([file, status]) => ({ file, status }))
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/** Zero-context unified diff of the working tree against the base. */
export async function diffPatch(gitRoot: GitRoot, baseSha: string): Promise<string> {
  return gitOk(
    gitRoot.toplevel,
    ["diff", "--no-renames", "--unified=0", "--no-color", baseSha, "--", pathspec(gitRoot)],
    "git diff",
  );
}

export interface BaseWorktree {
  /** Absolute path of the project root inside the base checkout. */
  projectRoot: string;
  cleanup: () => Promise<void>;
}

/**
 * Check out the base revision in a temporary linked worktree so the
 * indexer can read base source from disk. Always call `cleanup`.
 */
export async function createBaseWorktree(
  gitRoot: GitRoot,
  baseSha: string,
): Promise<BaseWorktree> {
  const holder = mkdtempSync(path.join(tmpdir(), "vibehard-base-"));
  const worktreeDir = path.join(holder, "wt");
  const cleanup = async (): Promise<void> => {
    await git(gitRoot.toplevel, ["worktree", "remove", "--force", worktreeDir]).catch(() => null);
    rmSync(holder, { recursive: true, force: true });
    await git(gitRoot.toplevel, ["worktree", "prune"]).catch(() => null);
  };
  const result = await git(gitRoot.toplevel, [
    "worktree",
    "add",
    "--detach",
    worktreeDir,
    baseSha,
  ]);
  if (result.exitCode !== 0) {
    await cleanup();
    throw new VibehardUsageError(
      `vibehard: could not check out base revision ${baseSha} in a temporary worktree\n${(result.stderr || result.stdout).trim()}`,
    );
  }
  const projectRoot =
    gitRoot.prefix === "" ? worktreeDir : path.join(worktreeDir, ...gitRoot.prefix.split("/"));
  return { projectRoot, cleanup };
}

/** True when the base checkout contains the project root directory. */
export function baseProjectExists(worktree: BaseWorktree): boolean {
  return existsSync(worktree.projectRoot);
}

/**
 * Absolute git common dir (shared across linked worktrees), or null
 * when git cannot report one. Never throws: callers use this only to
 * locate optional caches.
 */
export async function resolveGitCommonDir(gitRoot: GitRoot): Promise<string | null> {
  try {
    const result = await git(gitRoot.toplevel, ["rev-parse", "--git-common-dir"]);
    if (result.exitCode !== 0) return null;
    const raw = result.stdout.trim();
    if (raw === "") return null;
    return path.isAbsolute(raw) ? raw : path.resolve(gitRoot.toplevel, raw);
  } catch {
    return null;
  }
}

function toGitPath(gitRoot: GitRoot, projectRel: string): string {
  return gitRoot.prefix === "" ? projectRel : `${gitRoot.prefix}/${projectRel}`;
}

function batchRequests(
  gitRoot: GitRoot,
  baseSha: string,
  files: readonly string[],
): string {
  const lines: string[] = [];
  for (const file of files) {
    if (file.includes("\n") || file.includes("\r")) {
      throw new VibehardUsageError(
        `vibehard: file path cannot be read via git cat-file --batch: ${JSON.stringify(file)}`,
      );
    }
    lines.push(`${baseSha}:${toGitPath(gitRoot, file)}`);
  }
  return `${lines.join("\n")}\n`;
}

interface BaseObject {
  oid: string;
  type: string;
}

/**
 * Object identity of each `files` entry at the base revision via one
 * `git cat-file --batch-check` process (null = not present there).
 * Line i of the output answers request i.
 */
async function batchCheckBase(
  gitRoot: GitRoot,
  baseSha: string,
  files: readonly string[],
): Promise<(BaseObject | null)[]> {
  if (files.length === 0) return [];
  const result = await spawnCapture("git", ["cat-file", "--batch-check"], {
    cwd: gitRoot.toplevel,
    timeoutMs: 120_000,
    input: batchRequests(gitRoot, baseSha, files),
  }).catch((error: unknown) => {
    throw new VibehardUsageError(
      `vibehard: failed to run git: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  if (result.exitCode !== 0) {
    throw new VibehardUsageError(
      `vibehard: git cat-file --batch-check failed (git exit ${result.exitCode})\n${(result.stderr || result.stdout).trim()}`,
    );
  }
  const lines = result.stdout.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines.length !== files.length) {
    throw new VibehardUsageError(
      `vibehard: git cat-file --batch-check returned ${lines.length} line(s) for ${files.length} request(s)`,
    );
  }
  return lines.map((line) => {
    if (line.endsWith(" missing")) return null;
    const [oid, type] = line.split(" ");
    if (oid === undefined || oid === "" || type === undefined || type === "") {
      throw new VibehardUsageError(
        `vibehard: unexpected git cat-file --batch-check line: ${JSON.stringify(line)}`,
      );
    }
    return { oid, type };
  });
}

/**
 * Which of `files` (POSIX, project-relative) exist as blobs at the
 * base revision, via one `git ls-tree -r` walk of the project root
 * at the base (a per-file `cat-file <rev>:<path>` lookup per touched
 * file measured ~0.4 ms/file; one tree walk does not scale with the
 * number of files asked about).
 */
export async function baseTrackedFiles(
  gitRoot: GitRoot,
  baseSha: string,
  files: readonly string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (files.length === 0) return out;
  const wanted = new Set(files);
  const listing = await gitOk(
    gitRoot.toplevel,
    ["ls-tree", "-r", "-z", baseSha, "--", pathspec(gitRoot)],
    "git ls-tree",
  );
  for (const entry of listing.split("\0")) {
    if (entry === "") continue;
    const tab = entry.indexOf("\t");
    if (tab === -1) continue;
    const meta = entry.slice(0, tab).split(" ");
    if (meta[1] !== "blob") continue;
    const rel = toProjectRelative(gitRoot, entry.slice(tab + 1));
    if (rel !== null && wanted.has(rel)) out.add(rel);
  }
  return out;
}

/**
 * Raw contents of `files` (POSIX, project-relative) at the base
 * revision, or null per file that does not exist there as a blob.
 * Contents pass through `git cat-file --filters`, which applies the
 * working-tree conversion (CRLF, smudge filters) for each path, so
 * the bytes match what a base worktree checkout would contain — the
 * form lockfile hashes are recorded against.
 *
 * Filtered reads run one file per process: in `--filters` batch
 * output the header size is the pre-filter blob size while the
 * bytes that follow are post-filter, so a multi-object stream
 * cannot be framed reliably. Object lookup itself stays batched.
 */
export async function readBaseFiles(
  gitRoot: GitRoot,
  baseSha: string,
  files: readonly string[],
): Promise<Map<string, Buffer | null>> {
  const out = new Map<string, Buffer | null>();
  const objects = await batchCheckBase(gitRoot, baseSha, files);
  for (const [i, file] of files.entries()) {
    const object = objects[i];
    if (object === null || object === undefined || object.type !== "blob") {
      out.set(file, null);
      continue;
    }
    const gitPath = toGitPath(gitRoot, file);
    const result = await spawnCaptureBuffer("git", ["cat-file", "--filters", "--batch"], {
      cwd: gitRoot.toplevel,
      timeoutMs: 120_000,
      input: `${object.oid} ${gitPath}\n`,
    }).catch((error: unknown) => {
      throw new VibehardUsageError(
        `vibehard: failed to run git: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    if (result.exitCode !== 0) {
      throw new VibehardUsageError(
        `vibehard: git cat-file --batch failed (git exit ${result.exitCode})\n${(result.stderr || result.stdout.toString("utf8")).trim()}`,
      );
    }
    const buf = result.stdout;
    const nl = buf.indexOf(0x0a);
    if (nl === -1 || buf[buf.length - 1] !== 0x0a || buf.length < nl + 1) {
      throw new VibehardUsageError("vibehard: truncated git cat-file --batch output");
    }
    const header = buf.toString("utf8", 0, nl);
    if (!header.startsWith(`${object.oid} `)) {
      throw new VibehardUsageError(
        `vibehard: unexpected git cat-file --batch header: ${JSON.stringify(header)}`,
      );
    }
    out.set(file, Buffer.from(buf.subarray(nl + 1, buf.length - 1)));
  }
  return out;
}
