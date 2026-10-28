// /adai-contribute.zip must be what Claude's skill uploader takes: a zip whose
// one file is `adai-contribute/SKILL.md`, byte-identical to /skill.md.
import { it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { buildZip, skillZip } from "../src/utils/zip.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

interface Read { name: string; method: number; data: Buffer }

// An independent reader: end record → central directory → local headers.
function readZip(buf: Buffer): Read[] {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, "end of central directory present");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: Read[] = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, "central header signature");
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf-8");
    assert.equal(buf.readUInt32LE(local), 0x04034b50, "local header signature");
    const lstart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const comp = buf.subarray(lstart, lstart + csize);
    const data = method === 8 ? zlib.inflateRawSync(comp) : Buffer.from(comp);
    assert.equal(data.length, usize, `${name}: size`);
    assert.equal(zlib.crc32(data), crc, `${name}: crc`);
    out.push({ name, method, data });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

it("skillZip packs SKILL.md as adai-contribute/SKILL.md, byte-identical", async () => {
  const md = await readFile(path.join(root, "SKILL.md"));
  const entries = readZip(skillZip(md, new Date(2026, 9, 28, 12, 0, 0)));
  assert.deepEqual(entries.map((e) => e.name), ["adai-contribute/", "adai-contribute/SKILL.md"]);
  const file = entries[1];
  assert.equal(file.method, 8, "deflated");
  assert.ok(file.data.equals(md), "content equals SKILL.md");
});

it("buildZip round-trips several files, empty and non-ASCII ones too", () => {
  const files = [
    { name: "a/", data: undefined },
    { name: "a/empty.txt", data: Buffer.alloc(0) },
    { name: "a/ünïcode.md", data: Buffer.from("héllo ".repeat(500)) },
  ];
  const got = readZip(buildZip(files));
  assert.deepEqual(got.map((e) => e.name), files.map((f) => f.name));
  assert.ok(got[1].data.equals(Buffer.alloc(0)));
  assert.ok(got[2].data.equals(files[2].data!));
});
