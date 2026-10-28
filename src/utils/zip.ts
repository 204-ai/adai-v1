// A minimal ZIP writer (deflate, no zip64, no encryption) — enough to hand out
// the contributor skill as the archive Claude's skill uploader wants:
// `adai-contribute/SKILL.md` inside a .zip. No dependency: zlib does the
// deflate and the CRC-32.
import zlib from "node:zlib";

export interface ZipEntry {
  /** Path inside the archive, `/`-separated; a trailing `/` makes a directory. */
  name: string;
  data?: Buffer;
  mtime?: Date;
}

function dosTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export function buildZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const isDir = e.name.endsWith("/");
    const raw = isDir ? Buffer.alloc(0) : (e.data ?? Buffer.alloc(0));
    const deflated = isDir ? raw : zlib.deflateRawSync(raw, { level: 9 });
    const method = isDir ? 0 : 8;
    const crc = isDir ? 0 : zlib.crc32(raw);
    const name = Buffer.from(e.name, "utf-8");
    const { time, date } = dosTime(e.mtime ?? new Date(1980, 0, 1));
    const flags = 0x0800; // names are UTF-8

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, deflated);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    // external attrs: Unix mode in the high word (dir 0755, file 0644), plus MS-DOS dir bit
    central.writeUInt32LE((((isDir ? 0o040755 : 0o100644) << 16) | (isDir ? 0x10 : 0)) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + deflated.length;
  }

  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, cd, end]);
}

/** The skill folder Claude's uploader expects: `adai-contribute/SKILL.md`. */
export const SKILL_FOLDER = "adai-contribute";

export function skillZip(skillMd: Buffer, mtime?: Date): Buffer {
  return buildZip([
    { name: `${SKILL_FOLDER}/`, mtime },
    { name: `${SKILL_FOLDER}/SKILL.md`, data: skillMd, mtime },
  ]);
}
