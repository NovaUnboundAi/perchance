/**
 * AI image generator powered by Perchance.
 */

import { Generator, BrowserPage } from "./generator.js";
import { AuthenticationError, ConnectionError } from "./errors.js";
import type { GenerateImageOptions, ImageResultData, ImageShape } from "./types.js";

const BASE_URL = "https://image-generation.perchance.org/api";

const SHAPE_TO_RESOLUTION: Record<ImageShape, string> = {
  portrait: "512x768",
  square: "768x768",
  landscape: "768x512",
};

/**
 * Find the proxy image download path or token in a generate response.
 * Recursively searches dicts/lists/strings.
 */
function findProxyDownload(value: unknown): string | null {
  if (typeof value === "string") {
    if (value.includes("downloadTemporaryImageViaProxy")) return value;
    if (value.startsWith("v1.") && value.length > 80) {
      return `/downloadTemporaryImageViaProxy?t=${value}`;
    }
    return null;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const item of Object.values(obj)) {
      const result = findProxyDownload(item);
      if (result) return result;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = findProxyDownload(item);
      if (result) return result;
    }
  }
  return null;
}

export class ImageResult {
  readonly imageId: string;
  readonly fileExtension: string;
  readonly seed: number;
  readonly prompt: string;
  readonly width: number;
  readonly height: number;
  readonly guidanceScale: number;
  readonly negativePrompt: string;
  readonly maybeNsfw: boolean;
  readonly proxyDownload: string | null;

  private readonly generator: ImageGenerator;

  constructor(generator: ImageGenerator, data: ImageResultData) {
    this.generator = generator;
    this.imageId = data.imageId;
    this.fileExtension = data.fileExtension;
    this.seed = data.seed;
    this.prompt = data.prompt;
    this.width = data.width;
    this.height = data.height;
    this.guidanceScale = data.guidanceScale;
    this.negativePrompt = data.negativePrompt;
    this.maybeNsfw = data.maybeNsfw;
    this.proxyDownload = findProxyDownload(data);
  }

  toString(): string {
    return `${this.imageId}.${this.fileExtension}`;
  }

  get size(): readonly [number, number] {
    return [this.width, this.height] as const;
  }

  /**
   * Download the generated image as a Buffer.
   * Tries the proxy download URL first (if available), then falls
   * back to the direct downloadTemporaryImage endpoint.
   */
  async download(): Promise<Buffer> {
    const ctx = this.generator.getBrowserContext();
    if (!ctx) throw new ConnectionError("No browser context available");

    const ORIGIN = "https://image-generation.perchance.org";
    const urls: string[] = [];
    if (this.proxyDownload) {
      // proxyDownload already contains the full path (e.g. /api/downloadTemporaryImageViaProxy?t=...)
      urls.push(`${ORIGIN}${this.proxyDownload}`);
    }

    const page = await ctx.newPage();
    try {
      await page.goto(
        `${BASE_URL}/verifyUser?thread=0&__cacheBust=${Math.random()}`,
      );

      const result = await page.evaluate<
        { ok: true; data: string } | { ok: false; failures: string[] }
      >(
        async (urls: string[]) => {
          const failures: string[] = [];
          for (const url of urls) {
            const response = await fetch(url);
            if (!response.ok) { failures.push(response.status + ' ' + url); continue; }
            const blob = await response.blob();
            const base64 = await new Promise<string>(resolve => {
              const reader = new FileReader();
              reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
              reader.readAsDataURL(blob);
            });
            return { ok: true, data: base64 };
          }
          return { ok: false, failures };
        },
        urls,
      );

      if (!result.ok) {
        const errResult = result as { ok: false; failures: string[] };
        throw new ConnectionError(`Failed to download image: ${errResult.failures.join(", ")}`);
      }

      return Buffer.from(result.data, "base64");
    } finally {
      await page.close();
    }
  }

  /** Download and save the image to disk. */
  async save(filename?: string): Promise<string> {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const file = filename ?? `${this.imageId}.${this.fileExtension}`;
    const data = await this.download();
    await fs.writeFile(path.resolve(file), data);
    return file;
  }
}

export class ImageGenerator extends Generator {
  private static readonly BASE_URL = BASE_URL;
  private static readonly OVERALL_DEADLINE_MS = 180_000;
  private static readonly POLL_INTERVAL_MS = 2_000;
  private static readonly KEY_REFRESH_LIMIT = 1;

  /**
   * Generate an image.
   *
   * Perchance's protocol: POST to /generate with a stable requestId and keep
   * polling. Early polls return `waiting_for_prev_request_to_finish` quickly;
   * the eventual "ready" poll blocks server-side until the image is finished
   * (~20-30s typical). Rolling a fresh requestId per attempt would start a new
   * request each time and queue behind the previous one forever — that was the
   * historical bug that produced the misleading "user key rejected" errors.
   *
   * The Turnstile flow (used only when the key cache is cold) also submits a
   * "test" generation to trigger the challenge, so on a fresh key our very
   * first poll is queued behind that. Reusing the requestId lets us wait it
   * out and get our image on the same requestId.
   */
  async image(prompt: string, options: GenerateImageOptions = {}): Promise<ImageResult> {
    const {
      negativePrompt = null,
      seed = -1,
      shape = "square",
      guidanceScale = 7.0,
    } = options;

    const resolution = SHAPE_TO_RESOLUTION[shape];
    if (!resolution) throw new Error(`Invalid shape: ${shape}`);

    const requestId = `aiImageCompletion${Math.floor(Math.random() * 2 ** 30)}`;
    const deadline = Date.now() + ImageGenerator.OVERALL_DEADLINE_MS;

    let key = await this.ensureUserKey(BASE_URL);
    let keyRefreshes = 0;
    let lastResponse: unknown = null;

    while (Date.now() < deadline) {
      const response = await this.postGenerate(
        key, requestId, resolution, prompt, negativePrompt, seed, guidanceScale,
      );
      lastResponse = response;

      // Success — the server finished the request and returned the image data.
      const record = response as Record<string, unknown> | null;
      if (record && typeof record.imageId === "string") {
        return new ImageResult(this, response as ImageResultData);
      }

      const status = record?.status;

      // Still queued (either behind Perchance's own Turnstile-triggered "test"
      // gen, or behind another user's request) — poll again with the same id.
      if (status === "waiting_for_prev_request_to_finish") {
        await new Promise(resolve => setTimeout(resolve, ImageGenerator.POLL_INTERVAL_MS));
        continue;
      }

      // The key we cached is no longer accepted. Force a fresh one and retry
      // the same requestId, but only once — a persistent invalid_key is a real
      // failure we shouldn't hide behind an infinite refresh loop.
      if (status === "invalid_key" && keyRefreshes < ImageGenerator.KEY_REFRESH_LIMIT) {
        this.invalidateKey();
        key = await this.ensureUserKey(BASE_URL);
        keyRefreshes += 1;
        continue;
      }

      // Unknown status, or invalid_key after we already refreshed. Surface the
      // actual payload so we can see new Perchance statuses in the logs.
      throw new AuthenticationError(
        `Perchance /generate rejected the request. status=${String(status ?? "(none)")}, ` +
        `response=${JSON.stringify(response).slice(0, 400)}`,
      );
    }

    throw new AuthenticationError(
      `Perchance /generate did not deliver an image within ${ImageGenerator.OVERALL_DEADLINE_MS / 1000}s. ` +
      `Last response: ${JSON.stringify(lastResponse).slice(0, 400)}`,
    );
  }

  /** POST once to /generate with the caller's requestId and return the parsed JSON. */
  private async postGenerate(
    key: string,
    requestId: string,
    resolution: string,
    prompt: string,
    negativePrompt: string | null,
    seed: number,
    guidanceScale: number,
  ): Promise<Partial<ImageResultData> | null> {
    const ctx = this.getBrowserContext();
    if (!ctx) throw new ConnectionError("No browser context available");

    const page = await ctx.newPage();
    try {
      await page.goto(
        `${BASE_URL}/verifyUser?thread=0&__cacheBust=${Math.random()}`,
      );

      const url =
        `${BASE_URL}/generate?userKey=${key}` +
        `&requestId=${requestId}` +
        `&__cacheBust=${Math.random()}`;

      const body = {
        generatorName: "ai-image-generator",
        channel: "ai-text-to-image-generator",
        subChannel: "public",
        prompt,
        negativePrompt: negativePrompt ?? "",
        seed,
        resolution,
        guidanceScale,
      };

      return await page.evaluate<Partial<ImageResultData>>(
        async ({ url, body }: { url: string; body: Record<string, unknown> }) => {
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          return await response.json();
        },
        { url, body },
      );
    } finally {
      await page.close();
    }
  }

  /** Expose browser context for ImageResult.download(). */
  getBrowserContext() {
    return this.browserContext;
  }
}
