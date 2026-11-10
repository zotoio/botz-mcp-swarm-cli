export const RUNNER_LOCAL_MODEL_CATALOG_JSON = "RUNNER_LOCAL_MODEL_CATALOG_JSON";
export const RUNNER_CURSOR_RUNTIME = "RUNNER_CURSOR_RUNTIME";

export type ModelCatalogLister = (apiKey: string) => Promise<string[] | undefined>;

let catalogLister: ModelCatalogLister | null = null;

export function setModelCatalogListerForTests(fn: ModelCatalogLister | null): void {
  catalogLister = fn;
}

async function defaultModelLister(apiKey: string): Promise<string[] | undefined> {
  const sdk = (await import("@cursor/sdk")) as unknown as {
    Cursor: { models: { list(o: { apiKey: string }): Promise<unknown> } };
  };
  const response = await sdk.Cursor.models.list({ apiKey });
  const arr = (
    Array.isArray(response) ? response : ((response as { models?: unknown[] })?.models ?? [])
  ) as Array<{ id?: unknown }>;
  const ids = arr.map((item) => String(item?.id ?? "")).filter(Boolean);
  return ids.length > 0 ? ids : undefined;
}

export function readModelCatalogFromEnv(): string[] | undefined {
  const raw = process.env[RUNNER_LOCAL_MODEL_CATALOG_JSON];
  if (!raw?.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const ids = parsed.map((item) => String(item)).filter(Boolean);
    return ids.length > 0 ? ids : undefined;
  } catch {
    return undefined;
  }
}

export async function withSharedModelCatalog<T>(apiKey: string, fn: () => Promise<T>): Promise<T> {
  if (readModelCatalogFromEnv() || process.env[RUNNER_CURSOR_RUNTIME] === "cloud") {
    return fn();
  }
  let listed: string[] | undefined;
  try {
    listed = await (catalogLister ?? defaultModelLister)(apiKey);
  } catch {
    listed = undefined;
  }
  if (!listed?.length) {
    return fn();
  }
  const prior = process.env[RUNNER_LOCAL_MODEL_CATALOG_JSON];
  process.env[RUNNER_LOCAL_MODEL_CATALOG_JSON] = JSON.stringify(listed);
  try {
    return await fn();
  } finally {
    if (prior === undefined) delete process.env[RUNNER_LOCAL_MODEL_CATALOG_JSON];
    else process.env[RUNNER_LOCAL_MODEL_CATALOG_JSON] = prior;
  }
}
