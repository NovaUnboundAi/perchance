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
const TURNSTILE_ATTEMPT_TIMEOUT_MS = 90_000;
const IFRAME_POLL_DEADLINE_MS = 30_000;
const IFRAME_POLL_INTERVAL_MS = 500;
const GENERATE_CLICK_SETTLE_MS = 1_000;
const KEY_POLL_INTERVAL_MS = 500;
// Perchance rotates userKeys at the top of each hour, so cache expires just
// before the next hour boundary rather than on a rolling clock. A safety
// margin (30s) leaves room for clock skew and in-flight requests.
const HOUR_BOUNDARY_SAFETY_MARGIN_MS = 30_000;

/**
 * Module-level userKey cache shared across every Generator instance in the
 * process. Nova-tools spawns a fresh Generator per tool call, so per-instance
 * caching only helps within one call. Sharing at module level means the
 * expensive Turnstile flow only runs once per hour instead of once per call.
 */
const sharedUserKeyCache = new Map<string, { key: string; expiresAt: number }>();

function nextHourBoundaryMs(now = Date.now()): number {
  const d = new Date(now);
  d.setUTCMinutes(0, 0, 0);
  d.setUTCHours(d.getUTCHours() + 1);
  return d.getTime();
}

/** Invalidate the shared userKey cache for a given baseUrl (or all baseUrls). */
export function invalidateSharedUserKey(baseUrl?: string): void {
  if (baseUrl) sharedUserKeyCache.delete(baseUrl);
  else sharedUserKeyCache.clear();
}

export abstract class Generator {
  protected browserContext: BrowserContext | null = null;

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
   * Path in order of cost:
   *   1. Shared module-level cache (0ms). Valid until the top of the hour.
   *   2. Fast path via /verifyUser GET (~500ms). Succeeds when the pooled
   *      browser context has a Cloudflare clearance cookie from a prior pass.
   *   3. Full Turnstile flow (~15-30s). Stochastic against headless browsers;
   *      we do a single attempt here and let the caller rotate the browser
   *      context and retry via ensureUserKey again if this throws. Retrying in
   *      the same context can't help — once Cloudflare has flagged a context,
   *      re-issuing the challenge in it will keep failing.
   */
  async ensureUserKey(baseUrl: string): Promise<string> {
    const cached = sharedUserKeyCache.get(baseUrl);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.key;
    }

    const fast = await this.getKeyFast(baseUrl);
    if (fast) return this.cacheAndReturn(baseUrl, fast);

    try {
      const key = await this.getKeyViaTurnstile();
      if (key) return this.cacheAndReturn(baseUrl, key);
      throw new AuthenticationError(
        "Turnstile completed without a userKey (challenge blocked or verifyUser response format changed)",
      );
    } catch (error) {
      throw new AuthenticationError(
        `Failed to retrieve user key: ${(error as Error)?.message ?? String(error)}`,
      );
    }
  }

  /** Invalidate the shared cache. Mostly used after an invalid_key API response. */
  invalidateKey(baseUrl?: string): void {
    invalidateSharedUserKey(baseUrl);
  }

  private cacheAndReturn(baseUrl: string, key: string): string {
    sharedUserKeyCache.set(baseUrl, {
      key,
      expiresAt: nextHourBoundaryMs() - HOUR_BOUNDARY_SAFETY_MARGIN_MS,
    });
    return key;
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
    // Note: shared userKey cache is intentionally NOT cleared here — it's
    // module-level and shared with future Generator instances. Callers who
    // need to invalidate it use invalidateSharedUserKey().
  }
}
