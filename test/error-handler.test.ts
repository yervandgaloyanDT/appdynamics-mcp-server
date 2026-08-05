import { describe, it, expect } from "vitest";
import { handleError, isAxios404 } from "../src/utils/error-handler.js";

function axiosError(status: number, data: unknown): Error {
  const err = new Error(`Request failed with status code ${status}`) as Error & {
    isAxiosError: boolean;
    response: { status: number; data: unknown };
  };
  err.isAxiosError = true;
  err.response = { status, data };
  return err;
}

function networkError(code: string): Error {
  const err = new Error(code) as Error & { isAxiosError: boolean; code: string };
  err.isAxiosError = true;
  err.code = code;
  return err;
}

function textOf(response: ReturnType<typeof handleError>): string {
  return response.content[0]!.text;
}

describe("handleError", () => {
  it("marks responses as errors", () => {
    const response = handleError(axiosError(500, "boom"));
    expect(response.isError).toBe(true);
  });

  it("gives actionable messages for known status codes", () => {
    expect(textOf(handleError(axiosError(401, "")))).toMatch(/APPD_CLIENT_SECRET/);
    expect(textOf(handleError(axiosError(403, "")))).toMatch(/Permission denied/);
    expect(textOf(handleError(axiosError(404, "")))).toMatch(/not found/);
    expect(textOf(handleError(axiosError(429, "")))).toMatch(/Rate limit/);
  });

  it("keeps the controller's own message alongside the guidance", () => {
    // A 404/400 body normally names the entity that was rejected; dropping it
    // left the caller with generic advice and no idea what was wrong.
    const text = textOf(
      handleError(axiosError(404, "Invalid application id no-such-app is specified"))
    );
    expect(text).toMatch(/not found/);
    expect(text).toContain("Invalid application id no-such-app is specified");
  });

  it("attaches upstream detail on every known status", () => {
    for (const status of [401, 403, 404, 429]) {
      expect(textOf(handleError(axiosError(status, "detail here")))).toContain(
        "detail here"
      );
    }
  });

  it("omits the detail line when the body is empty", () => {
    for (const status of [401, 403, 404, 429]) {
      expect(textOf(handleError(axiosError(status, "")))).not.toContain(
        "Controller said:"
      );
      expect(textOf(handleError(axiosError(status, undefined)))).not.toContain(
        "Controller said:"
      );
    }
  });

  it("caps an oversized HTML error body", () => {
    const htmlPage = `<html><body>${"<div>noise</div>".repeat(5000)}</body></html>`;
    const text = textOf(handleError(axiosError(500, htmlPage)));

    expect(text.length).toBeLessThan(800);
    expect(text).toContain("truncated");
    expect(text).toContain(String(htmlPage.length));
  });

  it("collapses multi-line error bodies to a single line", () => {
    const text = textOf(handleError(axiosError(500, "line one\n\nline two\n   line three")));
    expect(text).toContain("line one line two line three");
    expect(text.split("\n")).toHaveLength(1);
  });

  it("leaves short error bodies intact", () => {
    const text = textOf(handleError(axiosError(500, "metric path invalid")));
    expect(text).toContain("metric path invalid");
    expect(text).not.toContain("truncated");
  });

  it("serializes object error bodies", () => {
    const text = textOf(handleError(axiosError(400, { message: "bad request" })));
    expect(text).toContain("bad request");
  });

  it("handles a missing response body", () => {
    const text = textOf(handleError(axiosError(500, undefined)));
    expect(text).toContain("no response body");
  });

  it("survives a circular error body", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(() => handleError(axiosError(500, circular))).not.toThrow();
  });

  it("explains connection failures", () => {
    expect(textOf(handleError(networkError("ECONNABORTED")))).toMatch(/timed out/);
    expect(textOf(handleError(networkError("ECONNREFUSED")))).toMatch(/APPD_URL/);
    expect(textOf(handleError(networkError("ENOTFOUND")))).toMatch(/APPD_URL/);
  });

  it("passes through plain Error messages", () => {
    const text = textOf(handleError(new Error("endTime must be after startTime.")));
    expect(text).toContain("endTime must be after startTime.");
  });

  it("handles non-Error throwables", () => {
    expect(textOf(handleError("just a string"))).toContain("just a string");
  });
});

describe("isAxios404", () => {
  it("identifies 404 responses", () => {
    expect(isAxios404(axiosError(404, ""))).toBe(true);
  });

  it("rejects other statuses and non-axios errors", () => {
    expect(isAxios404(axiosError(500, ""))).toBe(false);
    expect(isAxios404(new Error("nope"))).toBe(false);
    expect(isAxios404(undefined)).toBe(false);
  });
});
