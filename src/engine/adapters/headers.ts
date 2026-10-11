/** HTTP field names are case-insensitive; the last supplied value wins. */
export function mergeHeaders(...sources: Array<Record<string, string> | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const source of sources) {
    for (const [name, value] of Object.entries(source ?? {})) {
      const previous = Object.keys(result).find((key) => key.toLowerCase() === name.toLowerCase());
      if (previous) delete result[previous];
      result[name] = value;
    }
  }
  return result;
}
