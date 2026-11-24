import fs from "node:fs";
import path from "node:path";

function align4(n) {
  return n + ((4 - (n % 4)) % 4);
}

/**
 * Finds built app.asar archives inside apps/desktop/release.
 */
export function findAsarArchives(repoRoot) {
  const releaseDir = path.join(repoRoot, "apps/desktop/release");
  if (!fs.existsSync(releaseDir)) return [];
  const results = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name === "app.asar") {
        results.push(full);
      }
    }
  };
  walk(releaseDir);
  return results;
}

/**
 * Reads an ASAR archive header and returns flattened file entries.
 */
export function readAsarArchive(asarPath) {
  const fd = fs.openSync(asarPath, "r");
  try {
    const sizeBuf = Buffer.alloc(8);
    if (fs.readSync(fd, sizeBuf, 0, 8, 0) !== 8) {
      throw new Error(`Invalid ASAR header size in ${asarPath}`);
    }
    const headerPickleSize = sizeBuf.readUInt32LE(4);
    const headerBuf = Buffer.alloc(headerPickleSize);
    if (fs.readSync(fd, headerBuf, 0, headerPickleSize, 8) !== headerPickleSize) {
      throw new Error(`Truncated ASAR header in ${asarPath}`);
    }
    const strLen = headerBuf.readInt32LE(4);
    const headerJson = headerBuf.subarray(8, 8 + strLen).toString("utf8");
    const header = JSON.parse(headerJson);
    const baseOffset = 8 + headerPickleSize;

    const entries = [];
    const walkHeader = (node, prefix) => {
      if (!node || !node.files) return;
      for (const [name, child] of Object.entries(node.files)) {
        const relPath = prefix ? `${prefix}/${name}` : name;
        if (child.files) {
          walkHeader(child, relPath);
        } else {
          entries.push({
            relPath,
            size: Number(child.size ?? 0),
            offset: child.offset !== undefined ? Number(child.offset) : 0,
            unpacked: Boolean(child.unpacked),
          });
        }
      }
    };
    walkHeader(header, "");
    return { baseOffset, entries };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Reads a single file entry from an ASAR archive (or its .unpacked sidecar).
 */
export function readAsarEntryBuffer(asarPath, baseOffset, entry) {
  if (entry.size <= 0) return Buffer.alloc(0);
  if (entry.unpacked) {
    return fs.readFileSync(path.join(`${asarPath}.unpacked`, entry.relPath));
  }
  const fd = fs.openSync(asarPath, "r");
  try {
    const buf = Buffer.alloc(entry.size);
    fs.readSync(fd, buf, 0, entry.size, baseOffset + entry.offset);
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Writes a valid ASAR archive from a { "rel/path": Buffer } map (for deterministic tests).
 */
export function writeTestAsarArchive(asarPath, filesMap) {
  const root = { files: {} };
  const chunks = [];
  let offset = 0;

  for (const [rawRel, rawBuf] of Object.entries(filesMap)) {
    const buf = Buffer.isBuffer(rawBuf) ? rawBuf : Buffer.from(String(rawBuf));
    const parts = rawRel.split("/").filter(Boolean);
    let curr = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const dirName = parts[i];
      if (!curr.files[dirName]) {
        curr.files[dirName] = { files: {} };
      }
      curr = curr.files[dirName];
    }
    const fileName = parts[parts.length - 1];
    curr.files[fileName] = {
      size: buf.length,
      offset: String(offset),
    };
    chunks.push(buf);
    offset += buf.length;
  }

  const headerStr = JSON.stringify(root);
  const strBuf = Buffer.from(headerStr, "utf8");
  const alignedStrLen = align4(strBuf.length);
  const headerPayloadSize = 4 + alignedStrLen;
  const headerPickle = Buffer.alloc(4 + headerPayloadSize);
  headerPickle.writeUInt32LE(headerPayloadSize, 0);
  headerPickle.writeInt32LE(strBuf.length, 4);
  strBuf.copy(headerPickle, 8);

  const sizePickle = Buffer.alloc(8);
  sizePickle.writeUInt32LE(4, 0);
  sizePickle.writeUInt32LE(headerPickle.length, 4);

  fs.mkdirSync(path.dirname(asarPath), { recursive: true });
  fs.writeFileSync(asarPath, Buffer.concat([sizePickle, headerPickle, ...chunks]));
}
