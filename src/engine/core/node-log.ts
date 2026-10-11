/** The step that owns a server line. Shared lines stay off every card. */
export function exclusiveActiveNode(active: Iterable<string>): string {
  let only = "";
  for (const id of active) {
    if (!id) continue;
    if (only) return "";
    only = id;
  }
  return only;
}
