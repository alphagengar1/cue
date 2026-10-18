import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Card } from "../../shared/types.js";

export const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
export const dataFile = (name: string) => path.join(DATA_DIR, name);

/** The display contract every card must meet (shared/types.ts Card, 02 section 2). */
export function assertValidCard(c: Card): void {
  assert.ok(["connect", "context", "angle"].includes(c.kind), `kind ${c.kind}`);
  assert.ok(c.title.length > 0 && c.title.length <= 20, `title "${c.title}" (${c.title.length})`);
  assert.ok(c.body.length > 0 && c.body.length <= 200, `body ${c.body.length} chars`);
  const lines = c.body.split("\n");
  assert.ok(lines.length <= 5, `body ${lines.length} lines`);
  for (const l of lines) assert.ok(l.length <= 40, `line "${l}" (${l.length})`);
  assert.match(c.body, /^[\x20-\x7e\n━─█▲▼●○■□★│╭╮╯╰]*$/, "body is display-safe");
  if (c.kind === "angle") assert.equal(c.source, null);
  else {
    assert.ok(c.source && c.source.length <= 34, `source "${c.source}"`);
    assert.doesNotMatch(c.source!, /^(https?:|www\.|src:)/);
  }
}
