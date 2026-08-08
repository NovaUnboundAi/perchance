/**
 * Helper to launch Camoufox and adapt it to our BrowserContext interface.
 *
 * This is optional — consumers can inject any BrowserContext implementation.
 * This helper uses `camoufox-js` (the npm package wrapping the Camoufox browser)
 * which provides anti-detect fingerprinting out of the box.
 */

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
// --- Module-level browser pool singleton ---

let pooledBrowser: PlaywrightBrowser | null = null;
let pooledContext: PlaywrightContext | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function armIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (pooledContext) { try { pooledContext.close(); } catch { /* ignore */ } }
    if (pooledBrowser) { try { pooledBrowser.close(); } catch { /* ignore */ } }
    pooledContext = null;
    pooledBrowser = null;
    idleTimer = null;
  }, IDLE_TIMEOUT_MS);
}

export async function launchCamoufox(options: LaunchOptions = {}): Promise<BrowserContext> {
  const { headless = true, ...rest } = options;

  // Reuse pooled browser if alive
  if (pooledBrowser && pooledBrowser.isConnected() && pooledContext) {
    armIdleTimer();
    return new PlaywrightContextAdapter(pooledContext, null); // null = don't close browser on adapter.close()
  }

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
    armIdleTimer();
    return new PlaywrightContextAdapter(pooledContext, null);
  }

  // It's a Browser, need to create a context
  const browser = browserOrContext as unknown as PlaywrightBrowser;
  const ctx = await browser.newContext();
  pooledBrowser = browser;
  pooledContext = ctx;
  (pooledBrowser as any).on?.('disconnected', () => {
    pooledBrowser = null;
    pooledContext = null;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  });
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
