/** First signal asks the runner to close MCP sessions and write its report; a second forces exit. */
export async function withRunSignal<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const stop = (code: number) => {
    if (controller.signal.aborted) process.exit(code);
    process.exitCode = code;
    controller.abort();
  };
  const interrupt = () => stop(130);
  const terminate = () => stop(143);
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try { return await run(controller.signal); }
  finally { process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); }
}
