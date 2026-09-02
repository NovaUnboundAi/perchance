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
    // If this adapter owns the browser (non-pooled), close context + browser.
    // If pooled (browser === null), closing the shared context would kill it for
    // other consumers — so just let the idle timer handle cleanup.
    if (this.browser) {
      await this.ctx.close();
      try { await this.browser.close(); } catch { /* already closed */ }
    }
    // Pooled: no-op. Caller should close individual pages instead.
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
    // EPERM means the PID exists but we lack permission to signal it.
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
  // Playwright makes the launched browser its own process group leader so
  // it can kill the whole tree (renderer/GPU helpers included) on close.
  // Signaling the negated pid targets that whole group.
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

let pooledBrowser: PlaywrightBrowser | null = null;
let pooledContext: PlaywrightContext | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function armIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    // Snapshot then null the pool immediately so re-entrant launchCamoufox
    // calls don't observe a half-closed context or race the close promises.
    const ctx = pooledContext;
    const browser = pooledBrowser;
    pooledContext = null;
    pooledBrowser = null;
    idleTimer = null;
    // Fire-and-forget the close promises with .catch attached. Without the
    // catch, either close() rejecting mid-shutdown (browser already gone,
    // context/browser close racing each other) becomes an unhandled
    // rejection that crashes the host process.
    ctx?.close().catch(() => {});
    browser?.close().catch(() => {});
    void clearBrowserLock();
  }, IDLE_TIMEOUT_MS);
}

// Fresh process load (not a re-import within the same process): reap a
// leftover Camoufox/Firefox process from a previous crash.
if (!(globalThis as any).__perchance_camoufox_loaded) {
  (globalThis as any).__perchance_camoufox_loaded = true;
  void reapOrphanedBrowser();
}

// Force-kill the live Camoufox/Firefox process on shutdown, synchronously,
// so a graceful stop never leaves one running. Guarded so re-importing this
// module in the same process doesn't stack duplicate listeners.
if (!(globalThis as any).__perchance_camoufox_shutdown_hook_installed) {
  (globalThis as any).__perchance_camoufox_shutdown_hook_installed = true;
  const killPooledBrowser = () => {
    const pid = typeof pooledBrowser?.process === 'function' ? pooledBrowser.process()?.pid ?? null : null;
    if (typeof pid === "number") killProcessTree(pid);
    void clearBrowserLock();
  };
  process.on("SIGTERM", killPooledBrowser);
  process.on("SIGINT", killPooledBrowser);
  process.on("exit", killPooledBrowser);
}

let launchPromise: Promise<BrowserContext> | null = null;

export async function launchCamoufox(options: LaunchOptions = {}): Promise<BrowserContext> {
  // Reuse pooled browser if alive
  if (pooledBrowser && pooledBrowser.isConnected() && pooledContext) {
    armIdleTimer();
    return new PlaywrightContextAdapter(pooledContext, null); // null = don't close browser on adapter.close()
  }

  // Serialize concurrent cold-start launches. Without this, two callers
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

    // camoufox-js may return either a Browser or a BrowserContext
    if ('newPage' in browserOrContext && 'browser' in browserOrContext && typeof (browserOrContext as any).browser === 'function') {
      // Already a BrowserContext — extract the browser for proper cleanup
      pooledContext = browserOrContext as unknown as PlaywrightContext;
      pooledBrowser = (browserOrContext as any).browser() as PlaywrightBrowser | null;
      const pid = typeof pooledBrowser?.process === 'function' ? pooledBrowser.process()?.pid ?? null : null;
      if (typeof pid === "number") void writeBrowserLock(pid);
      armIdleTimer();
      return new PlaywrightContextAdapter(pooledContext, null);
    }

    // It's a Browser, need to create a context
    const browser = browserOrContext as unknown as PlaywrightBrowser;
    const ctx = await browser.newContext();
    pooledBrowser = browser;
    pooledContext = ctx;
    const pid = typeof pooledBrowser?.process === 'function' ? pooledBrowser.process()?.pid ?? null : null;
    if (typeof pid === "number") void writeBrowserLock(pid);
    (pooledBrowser as any).on?.('disconnected', () => {
      pooledBrowser = null;
      pooledContext = null;
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      void clearBrowserLock();
    });
    armIdleTimer();
    return new PlaywrightContextAdapter(ctx, null);
  })();

  try {
    return await launchPromise;
  } finally {
    launchPromise = null;
  }
}

/**
 * Wrap an existing Playwright/Camoufox BrowserContext.
 * Useful if you already have a browser instance running.
 */
export function wrapContext(ctx: unknown): BrowserContext {
  return new PlaywrightContextAdapter(ctx as PlaywrightContext);
}
