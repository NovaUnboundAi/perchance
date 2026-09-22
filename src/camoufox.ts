/**
 * Helper to launch Camoufox and adapt it to our BrowserContext interface.
 *
 * This is optional — consumers can inject any BrowserContext implementation.
 * This helper uses `camoufox-js` (the npm package wrapping the Camoufox browser)
 * which provides anti-detect fingerprinting out of the box.
 */

import { execFileSync } from "node:child_process";
import { readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { BrowserContext, BrowserPage, BrowserFrame, BrowserResponse } from "./generator.js";

// We dynamically import camoufox-js so it's an optional peer dependency.
// Users who already have a Playwright BrowserContext can inject it directly.

type PlaywrightPage = {
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  content(): Promise<string>;
  evaluate<T = unknown>(fn: string | ((...args: unknown[]) => T | Promise<T>), ...args: unknown[]): Promise<T>;
  frames(): PlaywrightFrame[];
  url(): string;
  on(event: string, handler: (response: PlaywrightResponse) => void): void;
  waitForTimeout(ms: number): Promise<void>;
  close(): Promise<void>;
  exposeFunction(name: string, callback: (...args: unknown[]) => unknown): Promise<void>;
};

type PlaywrightFrame = {
  url(): string;
  evaluate<T = unknown>(fn: string | ((...args: unknown[]) => T | Promise<T>), ...args: unknown[]): Promise<T>;
};

type PlaywrightResponse = {
  url(): string;
  text(): Promise<string>;
};

type PlaywrightContext = {
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
};

type PlaywrightBrowser = {
  newContext(opts?: Record<string, unknown>): Promise<PlaywrightContext>;
  close(): Promise<void>;
  isConnected(): boolean;
  process?(): { pid: number } | null;
};

/** Adapter that wraps a Playwright/Camoufox context into our interface. */
class PlaywrightContextAdapter implements BrowserContext {
  private ctx: PlaywrightContext;
  private browser: PlaywrightBrowser | null;

  constructor(ctx: PlaywrightContext, browser?: PlaywrightBrowser | null) {
    this.ctx = ctx;
    this.browser = browser ?? null;
  }

  async newPage(): Promise<BrowserPage> {
    const page = await this.ctx.newPage();
    return new PlaywrightPageAdapter(page);
  }

  async close(): Promise<void> {
    // No-op for pooled contexts (browser === null). The pool owns the
    // context; the caller uses invalidatePooledContext() to explicitly
    // rotate cookies after a Turnstile failure poisons them.
    if (this.browser) {
      try { await this.ctx.close(); } catch { /* already closed */ }
      try { await this.browser.close(); } catch { /* already closed */ }
    }
  }
}

class PlaywrightPageAdapter implements BrowserPage {
  private page: PlaywrightPage;

  constructor(page: PlaywrightPage) {
    this.page = page;
  }

  async goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<void> {
    await this.page.goto(url, opts);
  }

  async content(): Promise<string> {
    return await this.page.content();
  }

  async evaluate<T = unknown>(fn: string | ((...args: unknown[]) => T | Promise<T>), ...args: unknown[]): Promise<T> {
    return await this.page.evaluate(fn as any, ...args);
  }

  frames(): BrowserFrame[] {
    return this.page.frames().map(f => new PlaywrightFrameAdapter(f));
  }

  url(): string {
    return this.page.url();
  }

  on(event: string, handler: (response: BrowserResponse) => void): void {
    this.page.on(event, (res: PlaywrightResponse) => {
      handler({
        url: () => res.url(),
        text: () => res.text(),
      });
    });
  }

  async waitForTimeout(ms: number): Promise<void> {
    await this.page.waitForTimeout(ms);
  }

  async close(): Promise<void> {
    await this.page.close();
  }

  async exposeFunction(name: string, callback: (...args: any[]) => unknown): Promise<void> {
    await (this.page as any).exposeFunction(name, callback);
  }
}

class PlaywrightFrameAdapter implements BrowserFrame {
  private frame: PlaywrightFrame;

  constructor(frame: PlaywrightFrame) {
    this.frame = frame;
  }

  url(): string {
    return this.frame.url();
  }

  async evaluate<T = unknown>(fn: string | ((...args: unknown[]) => T | Promise<T>), ...args: unknown[]): Promise<T> {
    return await this.frame.evaluate(fn as any, ...args);
  }
}

export interface LaunchOptions {
  /** Run in headless mode (default: true) */
  headless?: boolean;
  /** Additional Camoufox options passed through */
  [key: string]: unknown;
}

/**
 * Launch Camoufox and return a BrowserContext adapter.
 *
 * Requires the `camoufox-js` npm package as a peer dependency.
 * ```
 * npm install camoufox-js
 * ```
 */
// --- Crash-safe browser PID tracking ---
//
// Playwright launches the Camoufox/Firefox process in its own detached
// process group so `.close()` can reliably kill the whole tree. That also
// means the browser does NOT die automatically if the host process dies
// without running cleanup — a hard crash, an OOM abort, or a `kill -9` all
// skip our idle-timer-based close. We record the live browser's PID next to
// this file and reap it on the next load if it's still running under our
// own hostname. This module has no framework dependency, so these are
// plain Node primitives rather than a host-provided process-tree helper.
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const LOCK_PATH = path.join(MODULE_DIR, ".perchance-browser.lock.json");

type BrowserLock = { pid: number; hostname: string; startedAt: number };

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function killProcessTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

async function writeBrowserLock(pid: number): Promise<void> {
  const lock: BrowserLock = { pid, hostname: os.hostname(), startedAt: Date.now() };
  await writeFile(LOCK_PATH, JSON.stringify(lock), "utf8").catch(() => {});
}

async function clearBrowserLock(): Promise<void> {
  await rm(LOCK_PATH, { force: true }).catch(() => {});
}

async function reapOrphanedBrowser(): Promise<void> {
  try {
    const raw = await readFile(LOCK_PATH, "utf8");
    const lock = JSON.parse(raw) as Partial<BrowserLock>;
    if (
      lock &&
      typeof lock.pid === "number" &&
      lock.hostname === os.hostname() &&
      isPidAlive(lock.pid)
    ) {
      killProcessTree(lock.pid);
    }
  } catch {
    // No lock file, or it's unreadable/corrupt — nothing to reap.
  } finally {
    await clearBrowserLock();
  }
}

// --- Module-level browser pool singleton ---
//
// Pool BOTH the browser and the context. Reusing the context across tool calls
// caches Cloudflare's clearance cookies, so subsequent calls hit the fast path
// (verifyUser returns the userKey without Turnstile) — a ~30s → ~500ms win.
//
// A shared context can accumulate bad state though: once Cloudflare flags a
// context as bot-like, every subsequent Turnstile in that context fails.
// Callers must explicitly rotate via invalidatePooledContext() when they see
// a Turnstile failure, and invalidatePooledBrowser() if a fresh context still
// fails (which points at IP/fingerprint-level flagging).

let pooledBrowser: PlaywrightBrowser | null = null;
let pooledContext: PlaywrightContext | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes — well under Perchance's hourly userKey rotation

function armIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const ctx = pooledContext;
    const browser = pooledBrowser;
    pooledContext = null;
    pooledBrowser = null;
    idleTimer = null;
    ctx?.close().catch(() => {});
    browser?.close().catch(() => {});
    void clearBrowserLock();
  }, IDLE_TIMEOUT_MS);
}

/**
 * Force the pooled context to be recycled on the next launchCamoufox() call.
 * Nukes cookies/localStorage without recycling the whole browser process.
 * Call this after Turnstile fails inside a call — the context's Cloudflare
 * state may be poisoned in ways that retrying inside it can't fix.
 */
export function invalidatePooledContext(): void {
  const ctx = pooledContext;
  pooledContext = null;
  ctx?.close().catch(() => {});
}

/**
 * Force the pooled BROWSER (and its context) to be recycled on the next
 * launchCamoufox() call. Reserved for cases where even a fresh context can't
 * pass Turnstile — usually means the browser's TLS/JA3 fingerprint or IP has
 * been accumulating "bot-like" scoring at Cloudflare.
 */
export function invalidatePooledBrowser(): void {
  const ctx = pooledContext;
  const browser = pooledBrowser;
  pooledContext = null;
  pooledBrowser = null;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  ctx?.close().catch(() => {});
  browser?.close().catch(() => {});
  void clearBrowserLock();
}

// Fresh process (Gateway start, not a plugin hot-reload within the same
// process): reap a leftover Camoufox/Firefox process from a previous crash.
if (!(globalThis as any).__perchance_camoufox_loaded) {
  (globalThis as any).__perchance_camoufox_loaded = true;
  void reapOrphanedBrowser();
}

// Force-kill the live Camoufox/Firefox process on shutdown, synchronously,
// so a graceful stop never leaves one running. Guarded so a plugin
// hot-reload doesn't stack duplicate listeners on the shared process object.
if (!(globalThis as any).__perchance_camoufox_shutdown_hook_installed) {
  (globalThis as any).__perchance_camoufox_shutdown_hook_installed = true;
  const killPooledBrowser = () => {
    const pid = pooledBrowser?.process?.()?.pid;
    if (typeof pid === "number") killProcessTree(pid);
    void clearBrowserLock();
  };
  process.on("SIGTERM", killPooledBrowser);
  process.on("SIGINT", killPooledBrowser);
  process.on("exit", killPooledBrowser);
}

let launchPromise: Promise<PlaywrightBrowser> | null = null;

async function ensurePooledBrowser(options: LaunchOptions): Promise<PlaywrightBrowser> {
  if (pooledBrowser && pooledBrowser.isConnected()) {
    return pooledBrowser;
  }

  // Serialize concurrent cold-start launches. Without this, two tool calls
  // racing against an idled-out pool would each launch their own Camoufox
  // process; whichever finished second would silently overwrite the module
  // singleton, orphaning the first one immediately.
  if (launchPromise) return launchPromise;

  launchPromise = (async () => {
    const { headless = true, ...rest } = options;

    // Dynamic import so camoufox-js is optional
    // @ts-ignore - camoufox-js is an optional peer dependency
    const { Camoufox } = await import("camoufox-js");

    const browserOrContext = await Camoufox({
      headless,
      humanize: true,
      enable_cache: false,
      // Critical: allow cross-origin iframe interaction for Turnstile
      disable_coop: true,
      i_know_what_im_doing: true,
      ...rest,
    } as any);

    // camoufox-js may return either a Browser or an initial BrowserContext.
    // We only keep the underlying Browser — the initial context (if returned)
    // is discarded so ensurePooledContext() can create a fresh one when needed.
    let browser: PlaywrightBrowser;
    if (
      "newPage" in browserOrContext &&
      "browser" in browserOrContext &&
      typeof (browserOrContext as any).browser === "function"
    ) {
      browser = (browserOrContext as any).browser() as PlaywrightBrowser;
      try { await (browserOrContext as unknown as PlaywrightContext).close(); } catch {}
    } else {
      browser = browserOrContext as unknown as PlaywrightBrowser;
    }

    pooledBrowser = browser;
    const pid = typeof browser.process === "function" ? browser.process()?.pid : null;
    if (typeof pid === "number") void writeBrowserLock(pid);
    (browser as any).on?.("disconnected", () => {
      if (pooledBrowser === browser) {
        pooledBrowser = null;
        pooledContext = null;
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        void clearBrowserLock();
      }
    });
    return browser;
  })();

  try {
    return await launchPromise;
  } finally {
    launchPromise = null;
  }
}

async function ensurePooledContext(browser: PlaywrightBrowser): Promise<PlaywrightContext> {
  if (pooledContext) return pooledContext;
  const ctx = await browser.newContext();
  pooledContext = ctx;
  return ctx;
}

export async function launchCamoufox(options: LaunchOptions = {}): Promise<BrowserContext> {
  const browser = await ensurePooledBrowser(options);
  const ctx = await ensurePooledContext(browser);
  armIdleTimer();
  return new PlaywrightContextAdapter(ctx, null);
}

/**
 * Wrap an existing Playwright/Camoufox BrowserContext.
 * Useful if you already have a browser instance running.
 */
export function wrapContext(ctx: unknown): BrowserContext {
  return new PlaywrightContextAdapter(ctx as PlaywrightContext);
}
