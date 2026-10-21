import { performance } from "node:perf_hooks";

/** One measured phase. Durations are wall-clock milliseconds. */
export interface PhaseTiming {
  name: string;
  durationMs: number;
  /** Number of measurements aggregated into this entry (omitted when 1). */
  count?: number;
  /** Numeric counters describing the work measured (files, symbols, …). */
  details?: Record<string, number>;
}

type Clock = () => number;

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Resolve whether timing is enabled: explicit option wins over env. */
export function timingEnabled(
  explicit: boolean | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (explicit !== undefined) return explicit;
  const raw = env["VIBEHARD_PROFILE"];
  return raw === "1" || raw === "true";
}

/**
 * Collects ordered phase timings. A disabled timer is a pass-through:
 * measured functions run exactly as they would without it.
 */
export class PhaseTimer {
  readonly enabled: boolean;
  readonly #now: Clock;
  readonly #start: number;
  readonly #order: string[] = [];
  readonly #byName = new Map<string, PhaseTiming & { count: number }>();

  constructor(enabled = true, now: Clock = () => performance.now()) {
    this.enabled = enabled;
    this.#now = now;
    this.#start = enabled ? now() : 0;
  }

  /** Record one already-measured duration under `name`. */
  record(name: string, durationMs: number, details?: Record<string, number>): void {
    this.#add(name, durationMs, 1, details);
  }

  #add(
    name: string,
    durationMs: number,
    count: number,
    details?: Record<string, number>,
  ): void {
    if (!this.enabled) return;
    let entry = this.#byName.get(name);
    if (entry === undefined) {
      entry = { name, durationMs: 0, count: 0 };
      this.#byName.set(name, entry);
      this.#order.push(name);
    }
    entry.durationMs += durationMs;
    entry.count += count;
    if (details !== undefined) {
      entry.details ??= {};
      for (const [key, value] of Object.entries(details)) {
        entry.details[key] = (entry.details[key] ?? 0) + value;
      }
    }
  }

  /** Measure an async operation. Errors propagate unchanged. */
  async run<T>(
    name: string,
    fn: () => Promise<T>,
    details?: Record<string, number> | ((result: T) => Record<string, number>),
  ): Promise<T> {
    if (!this.enabled) return fn();
    const start = this.#now();
    let result: T | undefined;
    let completed = false;
    try {
      result = await fn();
      completed = true;
      return result;
    } finally {
      const resolved =
        completed && typeof details === "function"
          ? details(result as T)
          : typeof details === "function"
            ? undefined
            : details;
      this.record(name, this.#now() - start, resolved);
    }
  }

  /** Measure a synchronous operation. Errors propagate unchanged. */
  runSync<T>(
    name: string,
    fn: () => T,
    details?: Record<string, number> | ((result: T) => Record<string, number>),
  ): T {
    if (!this.enabled) return fn();
    const start = this.#now();
    let result: T | undefined;
    let completed = false;
    try {
      result = fn();
      completed = true;
      return result;
    } finally {
      const resolved =
        completed && typeof details === "function"
          ? details(result as T)
          : typeof details === "function"
            ? undefined
            : details;
      this.record(name, this.#now() - start, resolved);
    }
  }

  /** Start a manual span; call the returned function to record it. */
  span(name: string): (details?: Record<string, number>) => void {
    if (!this.enabled) return () => undefined;
    const start = this.#now();
    return (details) => this.record(name, this.#now() - start, details);
  }

  /** Merge another timer's snapshot into this one, preserving counts. */
  absorb(phases: readonly PhaseTiming[]): void {
    for (const phase of phases) {
      this.#add(phase.name, phase.durationMs, phase.count ?? 1, phase.details);
    }
  }

  /** Milliseconds since this timer was created (0 when disabled). */
  elapsedMs(): number {
    return this.enabled ? this.#now() - this.#start : 0;
  }

  /** Ordered snapshot; appends a `total` phase unless disabled. */
  snapshot(includeTotal = true): PhaseTiming[] {
    if (!this.enabled) return [];
    const out: PhaseTiming[] = [];
    for (const name of this.#order) {
      const entry = this.#byName.get(name);
      if (entry === undefined) continue;
      const phase: PhaseTiming = { name, durationMs: roundMs(entry.durationMs) };
      if (entry.count > 1) phase.count = entry.count;
      if (entry.details !== undefined) phase.details = { ...entry.details };
      out.push(phase);
    }
    if (includeTotal) {
      out.push({ name: "total", durationMs: roundMs(this.#now() - this.#start) });
    }
    return out;
  }
}

/** Render phases as a small aligned table, or "" when there are none. */
export function formatPhaseTimings(
  title: string,
  phases: readonly PhaseTiming[] | undefined,
): string {
  if (phases === undefined || phases.length === 0) return "";
  const width = Math.max(...phases.map((p) => p.name.length));
  const lines = [`${title}:`];
  for (const phase of phases) {
    const extras: string[] = [];
    if (phase.count !== undefined && phase.count > 1) extras.push(`count=${phase.count}`);
    for (const [key, value] of Object.entries(phase.details ?? {})) {
      extras.push(`${key}=${value}`);
    }
    const suffix = extras.length > 0 ? ` (${extras.join(", ")})` : "";
    lines.push(
      `  ${phase.name.padEnd(width)}  ${phase.durationMs.toFixed(2)} ms${suffix}`,
    );
  }
  return `${lines.join("\n")}\n`;
}
