/**
 * opencode-otel-plugin - Dynamic OTLP Headers
 *
 * Static headers + optional helper script for short-lived tokens.
 * On auth failure (401/403/UNAUTHENTICATED/PERMISSION_DENIED), refresh
 * headers from the helper and retry the export once.
 */

import { spawn } from "node:child_process";
import { resolve as pathResolve, isAbsolute } from "node:path";

/** Resolve helper path with project-root placeholders. */
function resolveHelperPath(
  helper: string | undefined,
  directory?: string,
  worktree?: string
): string | undefined {
  if (!helper) return undefined;
  let p = helper
    .replace(/\$\{directory\}/g, directory ?? process.cwd())
    .replace(/\$\{worktree\}/g, worktree ?? process.cwd())
    .replace(/\{directory\}/g, directory ?? process.cwd())
    .replace(/\{worktree\}/g, worktree ?? process.cwd());
  if (!isAbsolute(p)) {
    p = pathResolve(process.cwd(), p);
  }
  return p;
}

export type HeadersMap = Record<string, string>;

/** Parse "k=v,k2=v2" into a headers map. */
export function parseOtlpHeaders(raw: string | undefined): HeadersMap {
  const result: HeadersMap = {};
  if (!raw) return result;
  for (const pair of raw.split(",")) {
    const idx = pair.indexOf("=");
    if (idx <= 0) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

/** Detect OTLP auth failures from HTTP status or gRPC code. */
export function isAuthFailure(error: unknown): boolean {
  if (!error) return false;
  const anyErr = error as any;
  const status = anyErr?.code ?? anyErr?.statusCode ?? anyErr?.status;
  if (status === 401 || status === 403) return true;
  // gRPC: 7 = PERMISSION_DENIED, 16 = UNAUTHENTICATED
  if (status === 7 || status === 16) return true;
  const message = String(anyErr?.message ?? anyErr?.details ?? "").toLowerCase();
  return (
    message.includes("unauthenticated") ||
    message.includes("permission_denied") ||
    message.includes("permission denied") ||
    message.includes("unauthorized") ||
    message.includes("401") ||
    message.includes("403")
  );
}

const HELPER_TIMEOUT_MS = 5000;

/**
 * Dynamic headers that can refresh from an external helper executable.
 * Helper must print a JSON object of string headers to stdout.
 */
export class DynamicHeaders {
  private staticHeaders: HeadersMap;
  private helperPath: string | undefined;
  private current: HeadersMap;
  private version = 0;
  private refreshing: Promise<void> | null = null;

  constructor(staticHeaders: HeadersMap, helperPath?: string) {
    this.staticHeaders = { ...staticHeaders };
    this.helperPath = helperPath;
    this.current = { ...staticHeaders };
  }

  get(): HeadersMap {
    return { ...this.current };
  }

  getVersion(): number {
    return this.version;
  }

  hasHelper(): boolean {
    return !!this.helperPath;
  }

  /** Refresh from helper (or fall back to static). Concurrent calls share one promise. */
  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this._refresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async _refresh(): Promise<void> {
    if (!this.helperPath) {
      this.current = { ...this.staticHeaders };
      this.version++;
      return;
    }
    try {
      const json = await this.runHelper(this.helperPath);
      const parsed = JSON.parse(json) as Record<string, unknown>;
      const next: HeadersMap = { ...this.staticHeaders };
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string") next[k] = v;
      }
      this.current = next;
      this.version++;
    } catch (error) {
      console.warn("[opencode-otel-plugin] Failed to refresh OTLP headers helper. Keeping previous headers.", error);
      // Keep previous headers
    }
  }

  private runHelper(path: string): Promise<string> {
    return new Promise((resolvePromise, rejectPromise) => {
      let settled = false;
      let stdout = "";
      let stderr = "";
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(path, [], { shell: false, windowsHide: true });
      } catch (err) {
        rejectPromise(err);
        return;
      }
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try { child.kill(); } catch { /* ignore */ }
          rejectPromise(new Error("headers helper timed out"));
        }
      }, HELPER_TIMEOUT_MS);

      child.stdout?.on("data", (d) => { stdout += String(d); });
      child.stderr?.on("data", (d) => { stderr += String(d); });
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectPromise(err);
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) resolvePromise(stdout.trim());
        else rejectPromise(new Error(`headers helper exited with code ${code}: ${stderr}`));
      });
    });
  }
}

/**
 * Wrap an exporter so that auth failures trigger a header refresh + one retry.
 */
export function wrapExporterWithAuthRetry<T extends { export: (...args: any[]) => any; shutdown?: () => Promise<void>; forceFlush?: () => Promise<void> }>(
  makeExporter: (headers: HeadersMap) => T,
  dynamicHeaders: DynamicHeaders
): T & { __authRetry?: boolean } {
  let exporter = makeExporter(dynamicHeaders.get());
  let lastVersion = dynamicHeaders.getVersion();

  const rebuild = () => {
    exporter = makeExporter(dynamicHeaders.get());
    lastVersion = dynamicHeaders.getVersion();
  };

  const ensureFresh = async () => {
    if (dynamicHeaders.getVersion() !== lastVersion) {
      rebuild();
    }
  };

  const wrapped = {
    async export(...args: any[]) {
      await ensureFresh();
      // Support callback-style export (OTLP exporters use resultCallback)
      const lastArg = args[args.length - 1];
      if (typeof lastArg === "function") {
        const items = args.slice(0, -1);
        const callback = lastArg;
        return exporter.export(...items, (result: any) => {
          if (isAuthFailure(result) && dynamicHeaders.hasHelper()) {
            void dynamicHeaders
              .refresh()
              .then(() => {
                rebuild();
                return (exporter.export as any)(...items, callback);
              })
              .catch((err) => callback(err));
            return;
          }
          callback(result);
        });
      }
      try {
        return exporter.export(...args);
      } catch (error) {
        if (isAuthFailure(error) && dynamicHeaders.hasHelper()) {
          await dynamicHeaders.refresh();
          rebuild();
          return exporter.export(...args);
        }
        throw error;
      }
    },
    shutdown: () => exporter.shutdown?.(),
    forceFlush: () => exporter.forceFlush?.(),
    __authRetry: true,
  };
  return wrapped as any;
}

/** Resolve helper path with project-root placeholders (exported for callers). */
export function resolveHeadersHelper(
  helper: string | undefined,
  directory?: string,
  worktree?: string
): string | undefined {
  return resolveHelperPath(helper, directory, worktree);
}
