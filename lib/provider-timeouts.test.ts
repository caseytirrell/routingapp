import { describe, expect, it } from "vitest";
import {
  ProviderTimeoutError,
  withProviderTimeout,
} from "./provider-timeouts";

describe("withProviderTimeout", () => {
  it("returns the provider result when it completes before the timeout", async () => {
    await expect(
      withProviderTimeout("google", async () => "ok", 50)
    ).resolves.toBe("ok");
  });

  it("throws a provider timeout error when the operation does not finish", async () => {
    await expect(
      withProviderTimeout(
        "ors",
        () => new Promise(() => undefined),
        5
      )
    ).rejects.toMatchObject({
      name: "ProviderTimeoutError",
      provider: "ors",
      timeoutMs: 5,
    } satisfies Partial<ProviderTimeoutError>);
  });

  it("passes through non-timeout provider errors", async () => {
    await expect(
      withProviderTimeout(
        "geoapify",
        async () => {
          throw new Error("provider rejected the request");
        },
        50
      )
    ).rejects.toThrow("provider rejected the request");
  });
});
