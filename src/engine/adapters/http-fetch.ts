export interface HeaderCapture {
  lastHeaders: Record<string, string>;
}

/** Wraps fetch to capture the most recent response headers (lowercased keys). */
export function createCapturingFetch(
  baseFetch: typeof fetch = fetch,
): { fetchFn: typeof fetch; capture: HeaderCapture } {
  const capture: HeaderCapture = { lastHeaders: {} };
  const fetchFn = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const response = await baseFetch(input, init);
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    capture.lastHeaders = headers;
    return response;
  };
  return { fetchFn, capture };
}
