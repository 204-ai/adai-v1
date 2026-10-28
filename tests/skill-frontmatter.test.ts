// SKILL.md is downloaded from /skill.md and uploaded to Claude as a skill.
// Claude's uploader refuses a frontmatter `description` over 1024 characters,
// so an over-long description breaks onboarding for every contributor.
import { it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

async function frontmatter(): Promise<Record<string, string>> {
  const text = await readFile(path.join(root, "SKILL.md"), "utf-8");
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(fm, "SKILL.md starts with a frontmatter block");
  const out: Record<string, string> = {};
  for (const line of fm[1].split(/\r?\n/)) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

it("SKILL.md frontmatter fits Claude's skill upload limits", async () => {
  const fm = await frontmatter();
  assert.equal(fm.name, "adai-contribute");
  assert.ok(fm.description, "description is present");
  assert.ok(
    fm.description.length <= 1024,
    `description is ${fm.description.length} characters; Claude's skill upload allows at most 1024`,
  );
  assert.ok(!/[<>]/.test(fm.description), "description has no angle brackets");
  assert.match(fm.version ?? "", /^\d{4}-\d{2}-\d{2}$/, "version is an ISO date");
});
