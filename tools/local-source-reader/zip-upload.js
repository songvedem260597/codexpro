(() => {
  const GLOBAL_KEY = '__CODEXPRO_LOCAL_SOURCE_ZIP_V1__';
  if (globalThis[GLOBAL_KEY]) return;

  const NativeFile = globalThis.File;
  if (typeof NativeFile !== 'function') return;

  const encoder = new TextEncoder();
  const SNAPSHOT_NAME_RE = /-local-source-(?:full|delta)-r\d+\.txt$/i;
  const SOURCE_START = '===== SOURCE CONTENT START =====';
  const SOURCE_END = '===== SOURCE CONTENT END =====';
  const FILE_PREFIX = '===== FILE: ';

  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function u16(value) {
    const bytes = new Uint8Array(2);
    new DataView(bytes.buffer).setUint16(0, value & 0xffff, true);
    return bytes;
  }

  function u32(value) {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, Number(value) >>> 0, true);
    return bytes;
  }

  function concatBytes(parts) {
    const size = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const out = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.byteLength;
    }
    return out;
  }

  function dosDateTime(value) {
    const date = value instanceof Date && !Number.isNaN(value.getTime()) ? value : new Date();
    const year = Math.max(1980, Math.min(2107, date.getFullYear()));
    const dosTime = ((date.getHours() & 0x1f) << 11)
      | ((date.getMinutes() & 0x3f) << 5)
      | ((Math.floor(date.getSeconds() / 2)) & 0x1f);
    const dosDate = (((year - 1980) & 0x7f) << 9)
      | (((date.getMonth() + 1) & 0x0f) << 5)
      | (date.getDate() & 0x1f);
    return { dosTime, dosDate };
  }

  function safeZipPath(value) {
    const path = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!path || path.includes('\0')) return '';
    const parts = path.split('/').filter(Boolean);
    if (!parts.length || parts.some((part) => part === '.' || part === '..')) return '';
    return parts.join('/');
  }

  function stringParts(fileBits) {
    if (!fileBits || typeof fileBits[Symbol.iterator] !== 'function') return null;
    const parts = [];
    for (const part of fileBits) {
      if (typeof part !== 'string') return null;
      parts.push(part);
    }
    return parts.join('');
  }

  function parseSnapshot(snapshotText) {
    const startIndex = snapshotText.indexOf(SOURCE_START);
    const endIndex = snapshotText.lastIndexOf(SOURCE_END);
    if (startIndex < 0 || endIndex < startIndex) return null;

    const header = snapshotText.slice(0, startIndex).trimEnd();
    let cursor = startIndex + SOURCE_START.length;
    const entries = [];
    const seen = new Set();

    while (cursor < endIndex) {
      while (cursor < endIndex && /\s/.test(snapshotText[cursor])) cursor += 1;
      if (cursor >= endIndex) break;
      if (!snapshotText.startsWith(FILE_PREFIX, cursor)) return null;

      const nameEnd = snapshotText.indexOf(' =====\n', cursor + FILE_PREFIX.length);
      const windowsNameEnd = snapshotText.indexOf(' =====\r\n', cursor + FILE_PREFIX.length);
      let lineEnd = nameEnd;
      let lineBreakLength = 1;
      if (windowsNameEnd >= 0 && (lineEnd < 0 || windowsNameEnd < lineEnd)) {
        lineEnd = windowsNameEnd;
        lineBreakLength = 2;
      }
      if (lineEnd < 0 || lineEnd >= endIndex) return null;

      const rawPath = snapshotText.slice(cursor + FILE_PREFIX.length, lineEnd);
      const path = safeZipPath(rawPath);
      if (!path || seen.has(path)) return null;
      seen.add(path);

      const contentStart = lineEnd + ' ====='.length + lineBreakLength;
      const endMarker = `\n===== END FILE: ${rawPath} =====`;
      const fileEnd = snapshotText.indexOf(endMarker, contentStart);
      if (fileEnd < 0 || fileEnd > endIndex) return null;

      entries.push({ name: path, data: encoder.encode(snapshotText.slice(contentStart, fileEnd)) });
      cursor = fileEnd + endMarker.length;
      if (snapshotText.startsWith('\r\n', cursor)) cursor += 2;
      else if (snapshotText[cursor] === '\n') cursor += 1;
    }

    if (!entries.length) return null;
    return {
      entries: [
        {
          name: '_codexpro/manifest.txt',
          data: encoder.encode(`${header}\n\nARCHIVE FORMAT:\n- Source files are stored at their original project-relative paths.\n- For DELTA snapshots, deleted paths remain listed in this manifest.\n- This ZIP replaces the previous large plain-text attachment to avoid ChatGPT text-file processing stalls.\n`)
        },
        ...entries
      ]
    };
  }

  function makeStoredZip(entries, modifiedAt = new Date()) {
    if (!Array.isArray(entries) || !entries.length || entries.length > 0xffff) throw new Error('Invalid ZIP entry count');

    const localParts = [];
    const centralParts = [];
    let localOffset = 0;
    let centralSize = 0;
    const { dosTime, dosDate } = dosDateTime(modifiedAt);

    for (const entry of entries) {
      const name = safeZipPath(entry.name);
      const data = entry.data instanceof Uint8Array ? entry.data : encoder.encode(String(entry.data || ''));
      if (!name) throw new Error('Invalid ZIP path');
      if (data.byteLength > 0xffffffff || localOffset > 0xffffffff) throw new Error('ZIP32 size limit exceeded');

      const nameBytes = encoder.encode(name);
      const crc = crc32(data);
      const flags = 0x0800;
      const method = 0;

      const localHeader = concatBytes([
        u32(0x04034b50), u16(20), u16(flags), u16(method), u16(dosTime), u16(dosDate),
        u32(crc), u32(data.byteLength), u32(data.byteLength), u16(nameBytes.byteLength), u16(0), nameBytes
      ]);
      localParts.push(localHeader, data);

      const centralHeader = concatBytes([
        u32(0x02014b50), u16(20), u16(20), u16(flags), u16(method), u16(dosTime), u16(dosDate),
        u32(crc), u32(data.byteLength), u32(data.byteLength), u16(nameBytes.byteLength), u16(0), u16(0),
        u16(0), u16(0), u32(0), u32(localOffset), nameBytes
      ]);
      centralParts.push(centralHeader);
      centralSize += centralHeader.byteLength;
      localOffset += localHeader.byteLength + data.byteLength;
    }

    const end = concatBytes([
      u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
      u32(centralSize), u32(localOffset), u16(0)
    ]);

    return new Blob([...localParts, ...centralParts, end], { type: 'application/zip' });
  }

  function shouldZip(fileBits, fileName, options) {
    return SNAPSHOT_NAME_RE.test(String(fileName || ''))
      && String(options?.type || '').toLowerCase() === 'text/plain'
      && fileBits != null;
  }

  const FileProxy = new Proxy(NativeFile, {
    construct(target, args, newTarget) {
      const [fileBits, fileName, options = {}] = args;
      if (shouldZip(fileBits, fileName, options)) {
        try {
          const snapshotText = stringParts(fileBits);
          const parsed = snapshotText == null ? null : parseSnapshot(snapshotText);
          if (parsed) {
            const modifiedAt = Number(options?.lastModified) ? new Date(Number(options.lastModified)) : new Date();
            const zipBlob = makeStoredZip(parsed.entries, modifiedAt);
            const zipName = String(fileName).replace(/\.txt$/i, '.zip');
            const zipOptions = { ...options, type: 'application/zip' };
            const zipFile = Reflect.construct(target, [[zipBlob], zipName, zipOptions], target);
            try {
              console.debug('[Local Source ZIP]', {
                sourceName: String(fileName),
                zipName,
                sourceBytes: encoder.encode(snapshotText).byteLength,
                zipBytes: zipFile.size,
                entries: parsed.entries.length
              });
            } catch (_) {}
            return zipFile;
          }
        } catch (error) {
          console.warn('[Local Source ZIP] ZIP conversion failed; falling back to TXT snapshot', error);
        }
      }
      return Reflect.construct(target, args, newTarget);
    }
  });

  globalThis.File = FileProxy;
  globalThis[GLOBAL_KEY] = {
    version: 1,
    active: true,
    nativeFile: NativeFile,
    isSnapshotName: (name) => SNAPSHOT_NAME_RE.test(String(name || ''))
  };
})();
