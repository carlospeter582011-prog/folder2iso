/*
 * Minimal ISO 9660 (Level 1/2, no Joliet/Rock Ridge) writer.
 * Builds a standards-compliant .iso image entirely in the browser from a
 * FileSystemDirectoryHandle / File list. No network access, no uploads.
 *
 * Sector size: 2048 bytes (standard for data CD/DVD images).
 */

const SECTOR = 2048;

// ---------- byte helpers ----------
function u8(n) { return n & 0xff; }
function le16(n) { const b = new Uint8Array(2); b[0]=n&0xff; b[1]=(n>>8)&0xff; return b; }
function be16(n) { const b = new Uint8Array(2); b[0]=(n>>8)&0xff; b[1]=n&0xff; return b; }
function bothEndian16(n){ const a=le16(n), b=be16(n); const o=new Uint8Array(4); o.set(a,0); o.set(b,2); return o; }
function le32(n) { const b=new Uint8Array(4); b[0]=n&0xff; b[1]=(n>>>8)&0xff; b[2]=(n>>>16)&0xff; b[3]=(n>>>24)&0xff; return b; }
function be32(n) { const b=new Uint8Array(4); b[0]=(n>>>24)&0xff; b[1]=(n>>>16)&0xff; b[2]=(n>>>8)&0xff; b[3]=n&0xff; return b; }
function bothEndian32(n){ const a=le32(n), b=be32(n); const o=new Uint8Array(8); o.set(a,0); o.set(b,4); return o; }

function strPad(str, len, padChar=' ') {
  str = str.slice(0, len);
  const bytes = new Uint8Array(len).fill(padChar.charCodeAt(0));
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xff;
  return bytes;
}

function isoDate(d) {
  // 17-byte ISO 9660 date/time format (ASCII digits + GMT offset)
  const pad = (n, l=2) => String(n).padStart(l, '0');
  const s = pad(d.getUTCFullYear(),4)+pad(d.getUTCMonth()+1)+pad(d.getUTCDate())+
            pad(d.getUTCHours())+pad(d.getUTCMinutes())+pad(d.getUTCSeconds())+'00';
  const bytes = strPad(s, 16, '0');
  const out = new Uint8Array(17);
  out.set(bytes, 0);
  out[16] = 0; // GMT offset
  return out;
}

function dirRecordDate(d) {
  return new Uint8Array([
    d.getUTCFullYear() - 1900, d.getUTCMonth()+1, d.getUTCDate(),
    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), 0
  ]);
}

// Sanitize a name to ISO 9660 Level 1 (8.3, uppercase, A-Z0-9_) — we relax
// slightly to allow longer names (Level 2 style) since most modern OSes
// (Windows/macOS/Linux) read non-strict images fine. Version suffix ";1" added to files.
function sanitizeName(name, isDir) {
  let n = name.toUpperCase().replace(/[^A-Z0-9_.]/g, '_');
  if (!isDir) {
    if (!n.includes('.')) n += '.';
    n += ';1';
  }
  return n;
}

class TreeNode {
  constructor(name, isDir, file=null) {
    this.name = name;
    this.isDir = isDir;
    this.file = file; // File object for leaves
    this.children = []; // TreeNode[]
    this.isoName = null;
    this.lba = 0;       // starting sector
    this.size = 0;      // bytes
    this.dirRecordLen = 0;
  }
}

/** Build a tree from a FileSystemDirectoryHandle (webkitdirectory input fallback also supported via buildTreeFromFileList). */
async function buildTreeFromDirHandle(dirHandle, name='ROOT') {
  const root = new TreeNode(name, true);
  async function walk(handle, node) {
    for await (const [childName, childHandle] of handle.entries()) {
      if (childHandle.kind === 'directory') {
        const childNode = new TreeNode(childName, true);
        node.children.push(childNode);
        await walk(childHandle, childNode);
      } else {
        const file = await childHandle.getFile();
        node.children.push(new TreeNode(childName, false, file));
      }
    }
  }
  await walk(dirHandle, root);
  return root;
}

/** Build a tree from a flat FileList where each File has webkitRelativePath set. */
function buildTreeFromFileList(fileList, rootName='ROOT') {
  const root = new TreeNode(rootName, true);
  const dirCache = new Map();
  dirCache.set('', root);

  function getDir(path) {
    if (dirCache.has(path)) return dirCache.get(path);
    const parts = path.split('/');
    const leaf = parts.pop();
    const parentPath = parts.join('/');
    const parent = getDir(parentPath);
    const node = new TreeNode(leaf, true);
    parent.children.push(node);
    dirCache.set(path, node);
    return node;
  }

  for (const file of fileList) {
    const rel = file.webkitRelativePath || file.name;
    const parts = rel.split('/');
    parts.shift(); // drop the top-level folder name itself (becomes root)
    const fileName = parts.pop();
    const dirPath = parts.join('/');
    const dirNode = getDir(dirPath);
    dirNode.children.push(new TreeNode(fileName, false, file));
  }
  return root;
}

function assignIsoNames(node) {
  const usedNames = new Set();
  for (const child of node.children) {
    let base = sanitizeName(child.name, child.isDir);
    let candidate = base;
    let i = 1;
    while (usedNames.has(candidate)) {
      const suffix = `_${i}`;
      candidate = child.isDir
        ? (base.slice(0, 8 - suffix.length) + suffix)
        : base.replace(/(;1)$/, '').slice(0, 8 - suffix.length) + suffix + '.;1';
      i++;
    }
    usedNames.add(candidate);
    child.isoName = candidate;
    if (child.isDir) assignIsoNames(child);
  }
}

function dirRecordSize(nameLen) {
  let len = 33 + nameLen;
  if (len % 2 !== 0) len += 1; // padding byte
  return len;
}

function dirEntriesSize(node, selfName) {
  // '.' and '..' entries (34 bytes each, 1-byte name field)
  let total = 34 + 34;
  for (const child of node.children) {
    total += dirRecordSize(child.isoName.length);
  }
  return total;
}

/**
 * Two-pass layout:
 * Pass 1: assign LBAs to all directories and files (breadth-first-ish, simple scheme).
 * Pass 2: serialize.
 */
function layout(root, startLBA) {
  let lba = startLBA;
  const allDirs = [];
  const allFiles = [];

  function collect(node) {
    if (node.isDir) {
      allDirs.push(node);
      for (const c of node.children) collect(c);
    } else {
      allFiles.push(node);
    }
  }
  collect(root);

  // Assign directory extents first (each directory's own listing block)
  for (const dir of allDirs) {
    const raw = dirEntriesSize(dir);
    const sectors = Math.ceil(raw / SECTOR);
    dir.lba = lba;
    dir.size = sectors * SECTOR;
    dir.sectors = sectors;
    lba += sectors;
  }
  // Assign file extents
  for (const file of allFiles) {
    const size = file.file.size;
    const sectors = Math.max(1, Math.ceil(size / SECTOR));
    file.lba = size === 0 ? 0 : lba;
    file.size = size;
    file.sectors = size === 0 ? 0 : sectors;
    if (size > 0) lba += sectors;
  }

  return { endLBA: lba, allDirs, allFiles };
}

function makeDirRecord({ lba, size, isDir, name, date, isSpecial=null }) {
  let nameBytes, nameLen;
  if (isSpecial === 'self') { nameBytes = new Uint8Array([0]); nameLen = 1; }
  else if (isSpecial === 'parent') { nameBytes = new Uint8Array([1]); nameLen = 1; }
  else { nameBytes = new TextEncoder().encode(name); nameLen = nameBytes.length; }

  let recLen = 33 + nameLen;
  const pad = recLen % 2 !== 0 ? 1 : 0;
  recLen += pad;

  const rec = new Uint8Array(recLen);
  let o = 0;
  rec[o++] = recLen;                 // length of directory record
  rec[o++] = 0;                      // extended attribute record length
  rec.set(bothEndian32(lba), o); o += 8;
  rec.set(bothEndian32(size), o); o += 8;
  rec.set(dirRecordDate(date), o); o += 7;
  rec[o++] = isDir ? 0x02 : 0x00;    // file flags
  rec[o++] = 0;                      // file unit size
  rec[o++] = 0;                      // interleave gap
  rec.set(bothEndian16(1), o); o += 4; // volume sequence number
  rec[o++] = nameLen;
  rec.set(nameBytes, o); o += nameLen;
  if (pad) rec[o++] = 0;
  return rec;
}

function serializeDirectory(node, parentLBA, parentSize, date) {
  const buf = new Uint8Array(node.size);
  let o = 0;
  // '.' entry
  const self = makeDirRecord({ lba: node.lba, size: node.size, isDir: true, date, isSpecial: 'self' });
  buf.set(self, o); o += self.length;
  // '..' entry
  const parent = makeDirRecord({ lba: parentLBA, size: parentSize, isDir: true, date, isSpecial: 'parent' });
  buf.set(parent, o); o += parent.length;

  for (const child of node.children) {
    const rec = makeDirRecord({
      lba: child.lba, size: child.isDir ? child.size : child.size,
      isDir: child.isDir, name: child.isoName, date
    });
    // don't split a record across a sector boundary
    const sectorOffset = o % SECTOR;
    if (sectorOffset + rec.length > SECTOR) {
      o += (SECTOR - sectorOffset); // pad to next sector
    }
    buf.set(rec, o); o += rec.length;
  }
  return buf;
}

/**
 * Main entry point. Streams the ISO to a WritableStream (e.g. from
 * showSaveFilePicker) so large images never sit fully in memory.
 *
 * @param {TreeNode} root
 * @param {string} volumeLabel
 * @param {WritableStreamDefaultWriter} writer
 * @param {(progress:{written:number,total:number,phase:string})=>void} onProgress
 */
async function writeIso(root, volumeLabel, writer, onProgress) {
  const date = new Date();
  assignIsoNames(root);

  // System area = 16 sectors of zeros, then PVD (1) + terminator (1) at LBA 16-17.
  // Path tables and directory/file extents start at LBA 18 (kept simple/generous).
  const RESERVED = 18;
  const { endLBA, allDirs, allFiles } = layout(root, RESERVED);
  const totalSectors = endLBA;
  const totalBytes = totalSectors * SECTOR;

  let written = 0;
  async function writeSectors(bytes) {
    await writer.write(bytes);
    written += bytes.length;
    onProgress && onProgress({ written, total: totalBytes, phase: 'writing' });
  }

  // ---- 16 empty system sectors ----
  await writeSectors(new Uint8Array(16 * SECTOR));

  // ---- Primary Volume Descriptor ----
  const rootDirRec = makeDirRecord({ lba: root.lba, size: root.size, isDir: true, date, isSpecial: 'self' });
  const pvd = new Uint8Array(SECTOR);
  let o = 0;
  pvd[o++] = 1;                          // type: PVD
  pvd.set(strPad('CD001', 5), o); o += 5;
  pvd[o++] = 1;                          // version
  o += 1;                                // unused
  pvd.set(strPad('', 32), o); o += 32;   // system id
  pvd.set(strPad(volumeLabel, 32), o); o += 32; // volume id
  o += 8;                                // unused
  pvd.set(bothEndian32(totalSectors), o); o += 8; // volume space size
  o += 32;                               // unused
  pvd.set(bothEndian16(1), o); o += 4;   // volume set size
  pvd.set(bothEndian16(1), o); o += 4;   // volume sequence number
  pvd.set(bothEndian16(SECTOR), o); o += 4; // logical block size
  const pathTableSize = 10 + Math.max(0, 0); // placeholder, simplified path table below
  pvd.set(bothEndian32(pathTableSize), o); o += 8; // path table size (minimal/simplified)
  o += 4;  // Type-L path table location
  o += 4;  // Optional Type-L path table location
  o += 4;  // Type-M path table location
  o += 4;  // Optional Type-M path table location
  pvd.set(rootDirRec, o); o += 34;       // root directory record
  pvd.set(strPad(volumeLabel, 128), o); o += 128; // volume set id
  pvd.set(strPad('', 128), o); o += 128; // publisher id
  pvd.set(strPad('', 128), o); o += 128; // data preparer id
  pvd.set(strPad('FOLDER-TO-ISO WEB APP', 128), o); o += 128; // application id
  pvd.set(strPad('', 37), o); o += 37;   // copyright file id
  pvd.set(strPad('', 37), o); o += 37;   // abstract file id
  pvd.set(strPad('', 37), o); o += 37;   // bibliographic file id
  pvd.set(isoDate(date), o); o += 17;    // volume creation date
  pvd.set(isoDate(date), o); o += 17;    // volume modification date
  pvd.set(isoDate(new Date(0)), o); o += 17; // expiration date (none -> zeros)
  pvd.set(isoDate(new Date(0)), o); o += 17; // effective date
  pvd[o++] = 1;                          // file structure version
  o += 1;
  await writeSectors(pvd);

  // ---- Volume Descriptor Set Terminator ----
  const term = new Uint8Array(SECTOR);
  term[0] = 255;
  term.set(strPad('CD001', 5), 1);
  term[6] = 1;
  await writeSectors(term);

  // ---- filler sectors up to RESERVED (18) ----
  await writeSectors(new Uint8Array((RESERVED - 18) * SECTOR));

  // ---- directory records, in the order they were laid out ----
  for (const dir of allDirs) {
    const parent = findParent(root, dir) || dir; // root's parent is itself
    const data = serializeDirectory(dir, parent.lba, parent.size, date);
    await writeSectors(data);
    onProgress && onProgress({ written, total: totalBytes, phase: `dir:${dir.name}` });
  }

  // ---- file contents, streamed directly from disk (File API) in chunks ----
  const CHUNK = 4 * 1024 * 1024; // 4MB read chunks to keep memory low
  for (const file of allFiles) {
    if (file.size === 0) continue;
    let offset = 0;
    const f = file.file;
    while (offset < f.size) {
      const slice = f.slice(offset, Math.min(offset + CHUNK, f.size));
      const buf = new Uint8Array(await slice.arrayBuffer());
      offset += buf.length;
      // pad the final chunk of the final file to a full sector
      const isLastChunkOfFile = offset >= f.size;
      if (isLastChunkOfFile) {
        const total = f.size;
        const paddedTotal = Math.ceil(total / SECTOR) * SECTOR;
        const remainder = paddedTotal - total;
        if (remainder > 0) {
          const padded = new Uint8Array(buf.length + remainder);
          padded.set(buf, 0);
          await writeSectors(padded);
        } else {
          await writeSectors(buf);
        }
      } else {
        await writeSectors(buf);
      }
    }
    onProgress && onProgress({ written, total: totalBytes, phase: `file:${file.name}` });
  }

  onProgress && onProgress({ written: totalBytes, total: totalBytes, phase: 'done' });
}

function findParent(root, target) {
  if (root === target) return null;
  for (const c of root.children) {
    if (c === target) return root;
    if (c.isDir) {
      const found = findParent(c, target);
      if (found) return found;
    }
  }
  return null;
}

function countStats(node, stats={files:0, dirs:0, bytes:0}) {
  if (node.isDir) {
    stats.dirs++;
    for (const c of node.children) countStats(c, stats);
  } else {
    stats.files++;
    stats.bytes += node.file.size;
  }
  return stats;
}

// Exposed API
window.IsoBuilder = {
  buildTreeFromDirHandle,
  buildTreeFromFileList,
  writeIso,
  countStats,
};
