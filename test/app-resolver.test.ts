import { describe, it, expect, vi } from "vitest";

vi.mock("../src/services/api-client.js", () => ({
  appdGet: vi.fn(),
}));

/**
 * Re-imports the resolver from a clean module registry so each test starts with
 * an empty application cache.
 */
async function freshResolver() {
  vi.resetModules();
  const { appdGet } = await import("../src/services/api-client.js");
  const get = vi.mocked(appdGet);
  get.mockReset();
  const resolver = await import("../src/utils/app-resolver.js");
  return { get, resolver };
}

const APPS = [
  { id: 1, name: "Java-App1" },
  { id: 2, name: "Java-App2" },
  { id: 3, name: "Payments Prod" },
];

/** Mock the list endpoint, and 400 anything else (as the controller does). */
function listOnly(get: ReturnType<typeof vi.mocked<never>> | any) {
  get.mockImplementation(async (path: string) => {
    if (path === "/controller/rest/applications") return APPS;
    throw new Error("Invalid application id is specified");
  });
}

describe("resolveAppId", () => {
  it("passes numbers through without any request", async () => {
    const { get, resolver } = await freshResolver();
    expect(await resolver.resolveAppId(52210)).toBe(52210);
    expect(get).not.toHaveBeenCalled();
  });

  it("parses a numeric string without any request", async () => {
    const { get, resolver } = await freshResolver();
    expect(await resolver.resolveAppId("52210")).toBe(52210);
    expect(get).not.toHaveBeenCalled();
  });

  it("matches a name exactly, case-insensitively", async () => {
    const { get, resolver } = await freshResolver();
    listOnly(get);
    expect(await resolver.resolveAppId("java-app2")).toBe(2);
  });

  it("accepts an unambiguous partial name", async () => {
    const { get, resolver } = await freshResolver();
    listOnly(get);
    expect(await resolver.resolveAppId("Payments")).toBe(3);
  });

  it("rejects an ambiguous partial name with the candidates", async () => {
    const { get, resolver } = await freshResolver();
    listOnly(get);
    await expect(resolver.resolveAppId("Java-App")).rejects.toThrow(
      /Multiple applications match/
    );
  });

  it("falls back to a direct lookup for apps missing from the list", async () => {
    // SIM and other special application types never appear in
    // /rest/applications but do resolve by name directly.
    const { get, resolver } = await freshResolver();
    get.mockImplementation(async (path: string) => {
      if (path === "/controller/rest/applications") return APPS;
      if (path === "/controller/rest/applications/SIM%20Application")
        return [{ id: 322, name: "SIM Application" }];
      throw new Error("Invalid application id is specified");
    });

    expect(await resolver.resolveAppId("SIM Application")).toBe(322);
  });

  it("still reports a genuine miss after the direct lookup fails", async () => {
    const { get, resolver } = await freshResolver();
    listOnly(get);
    await expect(resolver.resolveAppId("No-Such-App")).rejects.toThrow(
      /No application found matching/
    );
  });

  it("caches the list across calls", async () => {
    const { get, resolver } = await freshResolver();
    listOnly(get);
    await resolver.resolveAppId("Java-App1");
    await resolver.resolveAppId("Java-App2");

    const listCalls = get.mock.calls.filter(
      (c: unknown[]) => c[0] === "/controller/rest/applications"
    );
    expect(listCalls).toHaveLength(1);
  });

  it("shares one in-flight request across concurrent callers", async () => {
    const { get, resolver } = await freshResolver();
    let resolveList: (apps: typeof APPS) => void = () => {};
    get.mockImplementation(
      (path: string) =>
        path === "/controller/rest/applications"
          ? new Promise((res) => {
              resolveList = res;
            })
          : Promise.reject(new Error("unexpected"))
    );

    const pending = Promise.all([
      resolver.resolveAppId("Java-App1"),
      resolver.resolveAppId("Java-App2"),
      resolver.resolveAppId("Payments Prod"),
    ]);
    resolveList(APPS);

    expect(await pending).toEqual([1, 2, 3]);
    const listCalls = get.mock.calls.filter(
      (c: unknown[]) => c[0] === "/controller/rest/applications"
    );
    expect(listCalls).toHaveLength(1);
  });

  it("does not cache a failed list fetch", async () => {
    const { get, resolver } = await freshResolver();
    get.mockRejectedValueOnce(new Error("controller down"));
    await expect(resolver.resolveAppId("Java-App1")).rejects.toThrow(
      "controller down"
    );

    listOnly(get);
    expect(await resolver.resolveAppId("Java-App1")).toBe(1);
  });
});

describe("resolveAppName", () => {
  it("reads the name from the cached list", async () => {
    const { get, resolver } = await freshResolver();
    listOnly(get);
    expect(await resolver.resolveAppName(2)).toBe("Java-App2");
  });

  it("falls back to a direct lookup for ids missing from the list", async () => {
    const { get, resolver } = await freshResolver();
    get.mockImplementation(async (path: string) => {
      if (path === "/controller/rest/applications") return APPS;
      if (path === "/controller/rest/applications/322")
        return [{ id: 322, name: "SIM Application" }];
      throw new Error("Invalid application id is specified");
    });

    expect(await resolver.resolveAppName(322)).toBe("SIM Application");
  });

  it("degrades to the numeric id when every lookup fails", async () => {
    const { get, resolver } = await freshResolver();
    listOnly(get);
    expect(await resolver.resolveAppName(999)).toBe("999");
  });
});
