/**
 * Unit tests for generator.ts
 * Tests key cache, invalidation, and ensureUserKey with mock browser.
 */
import { beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { Generator, invalidateSharedUserKey } from "../src/generator.js";
import type { BrowserContext, BrowserPage } from "../src/generator.js";

/** A concrete subclass for testing the abstract Generator. */
class TestGenerator extends Generator {}

/** Create a mock page that returns the given content and URL. */
function createMockPage(content: string): BrowserPage {
  return {
    goto: mock.fn(async () => {}),
    content: mock.fn(async () => content),
    evaluate: mock.fn(async () => undefined),
    frames: mock.fn(() => []),
    url: mock.fn(() => "https://example.com"),
    on: mock.fn(() => {}),
    waitForTimeout: mock.fn(async () => {}),
    close: mock.fn(async () => {}),
    exposeFunction: mock.fn(async () => {}),
  } as unknown as BrowserPage;
}

/** Create a mock browser context that returns the given pages in order. */
function createMockContext(pages: BrowserPage[]): BrowserContext {
  let idx = 0;
  return {
    newPage: mock.fn(async () => pages[idx++] ?? createMockPage("")),
    close: mock.fn(async () => {}),
  } as unknown as BrowserContext;
}

const KEY_RESPONSE = '<html>{"userKey":"test-key-12345"}</html>';
const NO_KEY_RESPONSE = "<html>token_required</html>";
const BASE_URL = "https://image-generation.perchance.org/api";

describe("generator", () => {
  // The userKey cache is module-level (shared across Generator instances), so
  // it must be reset between tests to avoid cross-test contamination.
  beforeEach(() => invalidateSharedUserKey());

  it("ensureUserKey returns key from fast path", async () => {
    const ctx = createMockContext([createMockPage(KEY_RESPONSE)]);
    const gen = new TestGenerator();
    gen.setBrowserContext(ctx);
    const key = await gen.ensureUserKey(BASE_URL);
    assert.equal(key, "test-key-12345");
  });

  it("ensureUserKey uses cache on second call", async () => {
    const ctx = createMockContext([createMockPage(KEY_RESPONSE)]);
    const gen = new TestGenerator();
    gen.setBrowserContext(ctx);
    const key1 = await gen.ensureUserKey(BASE_URL);
    assert.equal(key1, "test-key-12345");
    // Second call should use cache, not open a new page
    const key2 = await gen.ensureUserKey(BASE_URL);
    assert.equal(key2, "test-key-12345");
    assert.equal((ctx.newPage as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 1);
  });

  it("cache is shared across Generator instances", async () => {
    const ctxA = createMockContext([createMockPage(KEY_RESPONSE)]);
    const genA = new TestGenerator();
    genA.setBrowserContext(ctxA);
    const keyA = await genA.ensureUserKey(BASE_URL);
    assert.equal(keyA, "test-key-12345");

    // A fresh Generator (as spawned per tool call in nova-tools) should still
    // hit the shared cache without opening any pages of its own.
    const ctxB = createMockContext([createMockPage('<html>{"userKey":"other"}</html>')]);
    const genB = new TestGenerator();
    genB.setBrowserContext(ctxB);
    const keyB = await genB.ensureUserKey(BASE_URL);
    assert.equal(keyB, "test-key-12345");
    assert.equal((ctxB.newPage as unknown as ReturnType<typeof mock.fn>).mock.calls.length, 0);
  });

  it("invalidateKey forces re-fetch", async () => {
    const ctx = createMockContext([
      createMockPage(KEY_RESPONSE),
      createMockPage('<html>{"userKey":"new-key-67890"}</html>'),
    ]);
    const gen = new TestGenerator();
    gen.setBrowserContext(ctx);
    const key1 = await gen.ensureUserKey(BASE_URL);
    assert.equal(key1, "test-key-12345");
    gen.invalidateKey(BASE_URL);
    const key2 = await gen.ensureUserKey(BASE_URL);
    assert.equal(key2, "new-key-67890");
  });

  it("throws AuthenticationError when no key found and no browser", async () => {
    const gen = new TestGenerator();
    // No browser context set — should throw with the wrapped message
    await assert.rejects(
      () => gen.ensureUserKey(BASE_URL),
      /Failed to retrieve user key/,
    );
  });

  it("close releases the browser but leaves the shared cache intact", async () => {
    const ctx = createMockContext([createMockPage(KEY_RESPONSE)]);
    const gen = new TestGenerator();
    gen.setBrowserContext(ctx);
    await gen.ensureUserKey(BASE_URL);
    await gen.close();
    // The shared cache persists on purpose — a future Generator with a live
    // browser should still be able to reuse the same userKey.
    const gen2 = new TestGenerator();
    gen2.setBrowserContext(createMockContext([createMockPage("")]));
    const reused = await gen2.ensureUserKey(BASE_URL);
    assert.equal(reused, "test-key-12345");
  });
});
