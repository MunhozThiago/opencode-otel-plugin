/**
 * opencode-otel-plugin - Persistence Layer
 *
 * Local span persistence so traces are not lost if OTLP export fails
 * (RESEARCH.md gap #9: "No persistence layer - spans not stored locally before export").
 *
 * Design:
 * - Optional enable via config.persistence
 * - Append-only JSONL file (one JSON span summary per line)
 * - Bounded in-memory queue with disk spill
 * - Load/clear for retry after restart
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { Span } from "@opentelemetry/api";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PersistedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  status: { code: number; message?: string };
  attributes: Record<string, string | number | boolean>;
  resource?: Record<string, string | number | boolean>;
  persistedAt: number;
}

export interface PersistenceConfig {
  enabled: boolean;
  /** Directory for span files (default: ./.opencode-otel/spans) */
  directory?: string;
  /** Max spans kept in memory before spill to disk (default: 512) */
  maxInMemory?: number;
  /** Max total persisted spans (default: 10000) */
  maxSpans?: number;
}

export interface PersistenceStats {
  inMemory: number;
  onDisk: number;
  dropped: number;
  file: string | null;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_DIRECTORY = ".opencode-otel/spans";
const DEFAULT_MAX_IN_MEMORY = 512;
const DEFAULT_MAX_SPANS = 10000;

// ─── Span Store ───────────────────────────────────────────────────────────────

export class LocalSpanStore {
  private readonly directory: string;
  private readonly filePath: string;
  private readonly maxInMemory: number;
  private readonly maxSpans: number;
  private readonly enabled: boolean;
  private queue: PersistedSpan[] = [];
  private dropped = 0;
  private diskCount = 0;

  constructor(config: PersistenceConfig = { enabled: false }) {
    this.enabled = config.enabled;
    this.directory = resolve(config.directory ?? DEFAULT_DIRECTORY);
    this.filePath = `${this.directory}/spans.jsonl`;
    this.maxInMemory = config.maxInMemory ?? DEFAULT_MAX_IN_MEMORY;
    this.maxSpans = config.maxSpans ?? DEFAULT_MAX_SPANS;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Persist a span (from ReadableSpan or serialized form).
   * No-op when persistence is disabled.
   */
  record(span: ReadableSpan | PersistedSpan): void {
    if (!this.enabled) return;

    const entry = toPersistedSpan(span);
    if (!entry.traceId || !entry.spanId) return;

    this.queue.push(entry);

    // Spill oldest to disk when in-memory queue is full
    if (this.queue.length > this.maxInMemory) {
      const overflow = this.queue.shift();
      if (overflow) {
        this.spillToDisk(overflow);
      }
    }

    // Enforce global max by dropping oldest on disk representation
    if (this.diskCount + this.queue.length > this.maxSpans) {
      this.trim();
    }
  }

  /** Load all persisted spans (memory + disk), oldest first. */
  load(): PersistedSpan[] {
    const fromDisk = this.readDisk();
    return [...fromDisk, ...this.queue];
  }

  /** Number of spans currently held (memory + disk). */
  size(): number {
    return this.diskCount + this.queue.length;
  }

  stats(): PersistenceStats {
    return {
      inMemory: this.queue.length,
      onDisk: this.diskCount,
      dropped: this.dropped,
      file: this.enabled ? this.filePath : null,
    };
  }

  /** Clear all persisted spans (after successful export). */
  clear(): void {
    this.queue = [];
    this.diskCount = 0;
    this.dropped = 0;
    if (this.enabled && existsSync(this.filePath)) {
      try {
        writeFileSync(this.filePath, "");
      } catch {
        // Best-effort clear
      }
    }
  }

  // ─── Internals ──────────────────────────────────────────────────────────────

  private spillToDisk(entry: PersistedSpan): void {
    if (!this.enabled) return;
    try {
      if (!existsSync(this.directory)) {
        mkdirSync(this.directory, { recursive: true });
      }
      appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, "utf8");
      this.diskCount += 1;
    } catch {
      this.dropped += 1;
    }
  }

  private readDisk(): PersistedSpan[] {
    if (!this.enabled || !existsSync(this.filePath)) return [];
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const lines = raw.split("\n").filter((l) => l.trim().length > 0);
      const parsed: PersistedSpan[] = [];
      for (const line of lines) {
        try {
          parsed.push(JSON.parse(line) as PersistedSpan);
        } catch {
          this.dropped += 1;
        }
      }
      return parsed;
    } catch {
      return [];
    }
  }

  private trim(): void {
    // Drop from in-memory first (oldest)
    while (this.diskCount + this.queue.length > this.maxSpans && this.queue.length > 0) {
      this.queue.shift();
      this.dropped += 1;
    }
    // If still over (disk-heavy), rewrite file without oldest lines
    if (this.diskCount + this.queue.length > this.maxSpans && this.diskCount > 0) {
      try {
        const all = this.readDisk();
        const keep = all.slice(all.length - Math.max(0, this.maxSpans - this.queue.length));
        const tmp = `${this.filePath}.tmp`;
        writeFileSync(tmp, keep.map((s) => JSON.stringify(s)).join("\n") + (keep.length ? "\n" : ""), "utf8");
        renameSync(tmp, this.filePath);
        this.dropped += all.length - keep.length;
        this.diskCount = keep.length;
      } catch {
        // Leave as-is on trim failure
      }
    }
  }
}

// ─── Span Processor Wrapper ───────────────────────────────────────────────────

/**
 * SpanProcessor that mirrors ended spans into LocalSpanStore
 * (runs alongside BatchSpanProcessor; does not replace export).
 */
export class PersistenceSpanProcessor implements SpanProcessor {
  constructor(private readonly store: LocalSpanStore) {}

  onStart(_span: Span, _parentContext: unknown): void {
    // Persist on end only (complete span data)
  }

  onEnd(span: ReadableSpan): void {
    this.store.record(span);
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toPersistedSpan(span: ReadableSpan | PersistedSpan): PersistedSpan {
  if ("persistedAt" in span && typeof (span as PersistedSpan).persistedAt === "number") {
    return span as PersistedSpan;
  }

  const rs = span as ReadableSpan;
  const ctx = rs.spanContext?.();
  const attrs: Record<string, string | number | boolean> = {};
  const rawAttrs = (rs as any).attributes ?? {};
  for (const [k, v] of Object.entries(rawAttrs)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      attrs[k] = v;
    } else {
      attrs[k] = String(v);
    }
  }

  const start = (rs as any).startTime;
  const end = (rs as any).endTime;
  const status = (rs as any).status ?? { code: 0 };

  return {
    traceId: ctx?.traceId ?? "",
    spanId: ctx?.spanId ?? "",
    parentSpanId: (rs as any).parentSpanId || undefined,
    name: (rs as any).name ?? "",
    kind: typeof (rs as any).kind === "number" ? (rs as any).kind : 0,
    startTimeUnixNano: toUnixNano(start),
    endTimeUnixNano: toUnixNano(end),
    status: {
      code: typeof status.code === "number" ? status.code : 0,
      message: status.message,
    },
    attributes: attrs,
    persistedAt: Date.now(),
  };
}

function toUnixNano(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length >= 2) {
    // [seconds, nanos]
    const sec = Number(value[0]) || 0;
    const nanos = Number(value[1]) || 0;
    return String(BigInt(sec) * 1_000_000_000n + BigInt(nanos));
  }
  if (typeof value === "number") {
    return String(BigInt(Math.round(value)) * 1_000_000n);
  }
  return String(BigInt(Date.now()) * 1_000_000n);
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createLocalSpanStore(config: PersistenceConfig): LocalSpanStore {
  return new LocalSpanStore(config);
}

export function createPersistenceProcessor(config: PersistenceConfig): {
  store: LocalSpanStore;
  processor: PersistenceSpanProcessor;
} | null {
  if (!config.enabled) return null;
  const store = new LocalSpanStore(config);
  return { store, processor: new PersistenceSpanProcessor(store) };
}
