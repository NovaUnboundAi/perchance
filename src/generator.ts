/**
 * Browser context manager using Camoufox/Playwright (same stack as
 * camofox-native, but standalone — no dependency on our plugin).
 *
 * Authentication strategy:
 * 1. Fast path: navigate directly to verifyUser. If Cloudflare
 *    remembers this IP (from a recent Turnstile pass), the userKey
 *    is returned immediately (under 1 second).
 * 2. Fallback: if the fast path fails (token_required), load the
 *    full Perchance generator page, inject a prompt, click Generate
 *    to trigger the Turnstile challenge, and intercept the
 *    verifyUser?token=*** response to extract the userKey.
 *
 * The consumer injects a BrowserContext (e.g. from a direct Camoufox
 * launch or a Playwright browser). Camoufox handles fingerprinting
 * and UA spoofing internally, so we don't override user agents here.
 */

import { AuthenticationError } from "./errors.js";

/** Minimal browser interface so users can inject their own context. */
export interface BrowserContext {
  newPage(): Promise<BrowserPage>;
  close(): Promise<void>;
}

export interface BrowserPage {
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<void>;
  content(): Promise<string>;
  evaluate<T = unknown>(fn: string | ((...args: any[]) => T | Promise<T>), ...args: any[]): Promise<T>;
  frames(): BrowserFrame[];
  url(): string;
  on(event: string, handler: (response: BrowserResponse) => void): void;
  waitForTimeout(ms: number): Promise<void>;
  close(): Promise<void>;
  exposeFunction(name: string, callback: (...args: any[]) => unknown): Promise<void>;
}

export interface BrowserFrame {
  url(): string;
  evaluate<T = unknown>(fn: string | ((...args: unknown[]) => T | Promise<T>), ...args: unknown[]): Promise<T>;
}

export interface BrowserResponse {
  url(): string;
  text(): Promise<string>;
}

/** Key cache entry with TTL. */
interface KeyEntry {
  key: string;
  expiresAt: number;
}

const USER_KEY_REGEX = /"userKey":"([^"]+)"/;
const DEFAULT_KEY_TTL_MS = 5 * 60 * 1000; // 5 minutes
const TURNSTILE_ATTEMPT_TIMEOUT_MS = 90_000;
const TURNSTILE_ATTEMPTS = 3;
const TURNSTILE_RETRY_BACKOFF_MS = 2_000;
const IFRAME_POLL_DEADLINE_MS = 30_000;
const IFRAME_POLL_INTERVAL_MS = 500;
const GENERATE_CLICK_SETTLE_MS = 1_000;
const KEY_POLL_INTERVAL_MS = 500;

export abstract class Generator {
  protected browserContext: BrowserContext | null = null;
  private keyCache: KeyEntry | null = null;
  protected readonly keyTtlMs: number = DEFAULT_KEY_TTL_MS;

  /** Inject a browser context (e.g. from Camoufox or Playwright). */
  setBrowserContext(ctx: BrowserContext): void {
    this.browserContext = ctx;
  }

  /** Check if a browser context is available. */
  protected hasBrowser(): boolean {
    return this.browserContext !== null;
  }

  /**
   * Return a valid Perchance userKey.
   *
   * Fast path is a single verifyUser GET — succeeds when Cloudflare has a
   * clearance cookie from a recent Turnstile pass. When it doesn't, we fall
   * through to the Turnstile flow, which is inherently stochastic against
   * headless browsers even with Camoufox — so we retry up to N times and
   * re-attempt the fast path between tries (a partial Turnstile pass may have
   * set a usable cookie before the challenge itself failed).
   */
  async ensureUserKey(baseUrl: string): Promise<string> {
    if (this.keyCache && Date.now() < this.keyCache.expiresAt) {
      return this.keyCache.key;
    }

    const fast = await this.getKeyFast(baseUrl);
    if (fast) return this.cacheAndReturn(fast);

    const failures: string[] = [];
    for (let attempt = 1; attempt <= TURNSTILE_ATTEMPTS; attempt++) {
      try {
        const key = await this.getKeyViaTurnstile();
        if (key) return this.cacheAndReturn(key);
        failures.push(`attempt ${attempt}: turnstile completed without a userKey`);
      } catch (error) {
        failures.push(`attempt ${attempt}: ${(error as Error)?.message ?? String(error)}`);
      }

      if (attempt < TURNSTILE_ATTEMPTS) {
        // A partial pass may have set the Cloudflare cookie server-side even
        // if we didn't intercept the userKey. Cheap to check between tries.
        const between = await this.getKeyFast(baseUrl);
        if (between) return this.cacheAndReturn(between);
        await this.sleep(TURNSTILE_RETRY_BACKOFF_MS);
      }
    }

    throw new AuthenticationError(
      `Failed to retrieve user key after ${TURNSTILE_ATTEMPTS} Turnstile attempts. ${failures.join("; ")}`,
    );
  }

  /** Invalidate the key cache (e.g. after a 401 from the API). */
  invalidateKey(): void {
    this.keyCache = null;
  }

  private cacheAndReturn(key: string): string {
    this.keyCache = { key, expiresAt: Date.now() + this.keyTtlMs };
    return key;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Fast path: direct navigation to verifyUser.
   * Works if Cloudflare remembers this IP from a recent Turnstile pass.
   */
  private async getKeyFast(baseUrl: string): Promise<string | null> {
    if (!this.browserContext) return null;

    const cacheBust = Math.random();
    const page = await this.browserContext.newPage();
    try {
      await page.goto(
        `${baseUrl}/verifyUser?thread=0&__cacheBust=${cacheBust}`,
        { waitUntil: "domcontentloaded", timeout: 15_000 },
      );
      const content = await page.content();
      const match = content.match(USER_KEY_REGEX);
      if (match) return match[1];
      return null;
    } catch {
      return null;
    } finally {
      await page.close();
    }
  }

  /**
   * Full Turnstile flow: load the Perchance AI image generator page, wait for
   * the generator iframe to appear, inject a prompt, click Generate, and
   * intercept the verifyUser?token=*** response for the userKey.
   *
   * Throws with a distinct message per failure mode (iframe never appeared,
   * generate button not found, Turnstile timed out) so the caller can log the
   * actual reason instead of a generic null.
   */
  private async getKeyViaTurnstile(): Promise<string | null> {
    if (!this.browserContext) return null;

    let key: string | null = null;
    const page = await this.browserContext.newPage();

    try {
      page.on("response", async (res: BrowserResponse) => {
        if (key) return;
        if (res.url().includes("verifyUser")) {
          try {
            const body = await res.text();
            const m = body.match(USER_KEY_REGEX);
            if (m) key = m[1];
          } catch { /* ignore body read races on abort */ }
        }
      });

      // domcontentloaded instead of networkidle — Perchance keeps polling
      // things, so networkidle may never fire and we'd waste our budget on
      // the goto instead of on the Turnstile challenge itself.
      await page.goto(
        "https://perchance.org/ai-text-to-image-generator",
        { waitUntil: "domcontentloaded", timeout: 60_000 },
      );

      // Poll for the generator iframe. Perchance loads it lazily; blind
      // sleeping is either too short (miss it) or too long (waste budget).
      const iframeDeadline = Date.now() + IFRAME_POLL_DEADLINE_MS;
      let target: BrowserFrame | undefined;
      while (Date.now() < iframeDeadline) {
        target = page.frames().find(
          (f) =>
            f.url().includes("perchance.org") &&
            f.url().includes("ai-text-to-image-generator") &&
            f.url() !== page.url(),
        );
        if (target) break;
        await page.waitForTimeout(IFRAME_POLL_INTERVAL_MS);
      }
      if (!target) {
        throw new Error(
          `generator iframe never appeared within ${IFRAME_POLL_DEADLINE_MS / 1000}s`,
        );
      }

      // Fill the prompt so the Generate button becomes enabled.
      await target.evaluate(() => {
        const ta = document.querySelector("textarea");
        if (ta) {
          ta.value = "test";
          ta.dispatchEvent(new Event("input", { bubbles: true }));
          ta.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });
      await page.waitForTimeout(GENERATE_CLICK_SETTLE_MS);

      // Report explicitly whether the button was actually clicked. Silent
      // failure here has cost us hours of "why did Turnstile time out?"
      const clicked = await target.evaluate<boolean>(() => {
        const btns = document.querySelectorAll("button");
        for (const b of btns) {
          if ((b.textContent || "").toLowerCase().includes("generate")) {
            b.click();
            return true;
          }
        }
        return false;
      });
      if (!clicked) {
        throw new Error("generate button not found in iframe");
      }

      const deadline = Date.now() + TURNSTILE_ATTEMPT_TIMEOUT_MS;
      while (!key && Date.now() < deadline) {
        await page.waitForTimeout(KEY_POLL_INTERVAL_MS);
      }

      if (!key) {
        throw new Error(
          `Turnstile did not deliver a userKey within ${TURNSTILE_ATTEMPT_TIMEOUT_MS / 1000}s (challenge blocked, network stalled, or verifyUser response format changed)`,
        );
      }

      return key;
    } finally {
      await page.close();
    }
  }

  /** Close the browser and release all resources. */
  async close(): Promise<void> {
    if (this.browserContext) {
      try {
        await this.browserContext.close();
      } catch { /* ignore */ }
      this.browserContext = null;
    }
    this.keyCache = null;
  }
}
