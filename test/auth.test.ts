import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("axios", () => ({
  default: { post: vi.fn() },
}));

const tick = () => new Promise((r) => setTimeout(r, 5));

/**
 * Re-imports axios and auth from a clean module registry so each test starts
 * with an empty token cache. Both imports must happen after resetModules so
 * they resolve to the same registry instance.
 */
async function freshAuth() {
  vi.resetModules();
  const axios = (await import("axios")).default;
  const post = vi.mocked(axios.post);
  // The mock factory result is cached across resetModules, so call history and
  // any implementation set by a previous test must be cleared explicitly.
  post.mockReset();
  const auth = await import("../src/services/auth.js");
  return { post, auth };
}

function okToken(token = "tok", expiresIn = 3600) {
  return { data: { access_token: token, expires_in: expiresIn } };
}

describe("getAccessToken", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.APPD_URL = "https://controller.example.com";
    process.env.APPD_CLIENT_NAME = "client";
    process.env.APPD_CLIENT_SECRET = "secret";
    process.env.APPD_ACCOUNT_NAME = "acct";
    consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("issues exactly one OAuth request for many concurrent callers", async () => {
    const { post, auth } = await freshAuth();
    post.mockImplementation(async () => {
      await tick();
      return okToken();
    });

    const tokens = await Promise.all(
      Array.from({ length: 25 }, () => auth.getAccessToken())
    );

    expect(post).toHaveBeenCalledTimes(1);
    expect(tokens).toHaveLength(25);
    expect(new Set(tokens)).toEqual(new Set(["tok"]));
  });

  it("reuses the cached token on subsequent calls", async () => {
    const { post, auth } = await freshAuth();
    post.mockResolvedValue(okToken());

    await auth.getAccessToken();
    await auth.getAccessToken();
    await auth.getAccessToken();

    expect(post).toHaveBeenCalledTimes(1);
  });

  it("fetches a new token after invalidateToken", async () => {
    const { post, auth } = await freshAuth();
    post.mockResolvedValueOnce(okToken("first"));
    post.mockResolvedValueOnce(okToken("second"));

    expect(await auth.getAccessToken()).toBe("first");
    auth.invalidateToken();
    expect(await auth.getAccessToken()).toBe("second");
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed token request", async () => {
    const { post, auth } = await freshAuth();
    post.mockRejectedValueOnce(new Error("network down"));
    post.mockResolvedValueOnce(okToken("recovered"));

    await expect(auth.getAccessToken()).rejects.toThrow(/OAuth authentication failed/);
    expect(await auth.getAccessToken()).toBe("recovered");
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("fails all concurrent callers when the token request fails", async () => {
    const { post, auth } = await freshAuth();
    post.mockImplementation(async () => {
      await tick();
      throw new Error("boom");
    });

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => auth.getAccessToken())
    );

    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("never includes the client secret in the thrown error", async () => {
    const { post, auth } = await freshAuth();
    post.mockRejectedValue(new Error("upstream detail"));

    await expect(auth.getAccessToken()).rejects.not.toThrow(/secret/);
  });

  it("refreshes early using the expiry safety margin", async () => {
    const { post, auth } = await freshAuth();
    // expires_in below the 300s safety margin → cached token is already stale.
    post.mockResolvedValue(okToken("short", 60));

    await auth.getAccessToken();
    await auth.getAccessToken();

    expect(post).toHaveBeenCalledTimes(2);
  });

  it("treats a missing access_token as a failure", async () => {
    const { post, auth } = await freshAuth();
    post.mockResolvedValue({ data: { expires_in: 3600 } });

    await expect(auth.getAccessToken()).rejects.toThrow(/OAuth authentication failed/);
  });
});

describe("API-key mode (no client secret)", () => {
  beforeEach(() => {
    process.env.APPD_URL = "https://controller.example.com";
    process.env.APPD_CLIENT_NAME = "raw-api-key";
    delete process.env.APPD_CLIENT_SECRET;
  });

  it("returns the client name without an OAuth request", async () => {
    const { post, auth } = await freshAuth();
    expect(await auth.getAccessToken()).toBe("raw-api-key");
    expect(post).not.toHaveBeenCalled();
  });

  it("reports OAuth as not configured so 401 retries are skipped", async () => {
    const { auth } = await freshAuth();
    expect(auth.isOAuthConfigured()).toBe(false);
  });
});

describe("unconfigured auth", () => {
  beforeEach(() => {
    delete process.env.APPD_CLIENT_NAME;
    delete process.env.APPD_API_KEY;
    delete process.env.APPD_CLIENT_SECRET;
  });

  it("throws an actionable error", async () => {
    const { auth } = await freshAuth();
    await expect(auth.getAccessToken()).rejects.toThrow(/not configured/);
  });
});
