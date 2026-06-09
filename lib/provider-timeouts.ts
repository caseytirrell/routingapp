export type ProviderName = "google" | "ors" | "tomtom" | "geoapify" | "nominatim";

export const PROVIDER_TIMEOUT_MS: Record<ProviderName, number> = {
  google: 30_000,
  ors: 30_000,
  tomtom: 30_000,
  geoapify: 30_000,
  nominatim: 20_000,
};

export class ProviderTimeoutError extends Error {
  constructor(
    public readonly provider: ProviderName,
    public readonly timeoutMs: number
  ) {
    super(`${formatProviderName(provider)} request timed out after ${timeoutMs / 1000}s.`);
    this.name = "ProviderTimeoutError";
  }
}

function formatProviderName(provider: ProviderName) {
  if (provider === "ors") return "OpenRouteService";
  if (provider === "tomtom") return "TomTom";
  return provider[0].toUpperCase() + provider.slice(1);
}

export async function withProviderTimeout<T>(
  provider: ProviderName,
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = PROVIDER_TIMEOUT_MS[provider]
): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new ProviderTimeoutError(provider, timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation(controller.signal), timeoutPromise]);
  } catch (error) {
    if (controller.signal.aborted && !(error instanceof ProviderTimeoutError)) {
      throw new ProviderTimeoutError(provider, timeoutMs);
    }

    throw error;
  } finally {
    clearTimeout(timeout!);
  }
}
