/**
 * Desktop XLSX preflight. SheetJS eagerly expands ZIP members, so measure
 * ACTUAL inflation before calling it; do not trust the advertised ZIP sizes.
 * No unbounded fallback is allowed when raw-DEFLATE streams are unsupported.
 */
const MAX_INPUT = 2 * 1024 * 1024;
const MAX_EXPANDED = 16 * 1024 * 1024;
const MAX_ENTRY = 8 * 1024 * 1024;
const MAX_SHEET = 4 * 1024 * 1024;
const MAX_ENTRIES = 128;
const COMPRESSED_CHUNK = 16 * 1024;

interface ZipMember {
  start: number;
  end: number;
  dataOffset: number;
  compressed: number;
  expanded: number;
  method: number;
  checksum: number;
  maximum: number;
}

const crcTable = new Uint32Array(256);
for (let index = 0; index < 256; index++) {
  let value = index;
  for (let i = 0; i < 8; i++) {
    value = (value & 1) ? ((value >>> 1) ^ 0xedb88320) : (value >>> 1);
  }
  crcTable[index] = value >>> 0;
}

export async function assertBoundedDesktopXlsxArchive(bytes: string): Promise<void> {
  const fail = (): never => {
    throw new Error('ملف XLSX المضغوط كبير جداً أو غير صالح للاستيراد الآمن');
  };
  const length = bytes.length;
  if (length < 22 || length > MAX_INPUT) fail();
  // FileReader.readAsBinaryString is a Latin-1 binary string. Higher code
  // units would alias ZIP offsets and corrupt the CRC calculation.
  for (let i = 0; i < length; i++) if (bytes.charCodeAt(i) > 255) fail();

  const byte = (offset: number) => bytes.charCodeAt(offset);
  const u16 = (offset: number) => byte(offset) | (byte(offset + 1) << 8);
  const u32 = (offset: number) => (
    byte(offset) + byte(offset + 1) * 256 + byte(offset + 2) * 65536 +
    byte(offset + 3) * 16777216
  ) >>> 0;
  const check = (offset: number, needed: number): void => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(needed) ||
        offset < 0 || needed < 0 || offset + needed > length) fail();
  };
  const checkExtras = (offset: number, size: number): void => {
    check(offset, size);
    const end = offset + size;
    while (offset < end) {
      if (offset + 4 > end) fail();
      const kind = u16(offset);
      const size = u16(offset + 2);
      offset += 4 + size;
      if (kind === 1 || offset > end) fail(); // Reject ZIP64 even without sentinels.
    }
  };

  if (u32(0) !== 0x04034b50) fail();
  let end = -1;
  for (let position = length - 22; position >= Math.max(0, length - 65557); position--) {
    if (u32(position) === 0x06054b50 &&
        position + 22 + u16(position + 20) === length) {
      end = position;
      break;
    }
  }
  if (end < 0 || u16(end + 4) !== 0 || u16(end + 6) !== 0 ||
      u16(end + 8) !== u16(end + 10)) fail();
  const entries = u16(end + 10);
  const directoryLength = u32(end + 12);
  const directoryOffset = u32(end + 16);
  if (!entries || entries > MAX_ENTRIES ||
      directoryLength === 0xffffffff || directoryOffset === 0xffffffff ||
      directoryOffset + directoryLength !== end) fail();

  let cursor = directoryOffset;
  let declaredTotal = 0;
  let workbook = false;
  let contentTypes = false;
  let sheet = false;
  const names = new Set<string>();
  const members: ZipMember[] = [];
  for (let i = 0; i < entries; i++) {
    check(cursor, 46);
    if (u32(cursor) !== 0x02014b50) fail();
    const flags = u16(cursor + 8);
    const method = u16(cursor + 10);
    const checksum = u32(cursor + 16);
    const compressed = u32(cursor + 20);
    const expanded = u32(cursor + 24);
    const nameLength = u16(cursor + 28);
    const extraLength = u16(cursor + 30);
    const commentLength = u16(cursor + 32);
    const localOffset = u32(cursor + 42);
    if ((flags & ~(0x0008 | 0x0800)) !== 0 ||
        (method !== 0 && method !== 8) ||
        compressed === 0xffffffff || expanded === 0xffffffff ||
        localOffset === 0xffffffff || u16(cursor + 34) !== 0 ||
        expanded > MAX_ENTRY || (declaredTotal += expanded) > MAX_EXPANDED) fail();
    check(cursor + 46, nameLength + extraLength + commentLength);
    const name = bytes.slice(cursor + 46, cursor + 46 + nameLength);
    // ASCII-only names avoid ambiguities from ZIP filename encodings while
    // accepting standard XLSX member paths, including Content_Types.xml.
    if (!name || !/^[\x21-\x7e]+$/.test(name) || name.includes('\\') ||
        name.startsWith('/') ||
        name.split('/').some(part => !part || part === '.' || part === '..') ||
        names.has(name.toLowerCase())) fail();
    names.add(name.toLowerCase());
    checkExtras(cursor + 46 + nameLength, extraLength);
    if (name === 'xl/workbook.xml') workbook = true;
    if (name === '[Content_Types].xml') contentTypes = true;
    const worksheet = /^xl\/worksheets\/[^/]+\.xml$/i.test(name);
    if (worksheet) {
      sheet = true;
      if (expanded > MAX_SHEET) fail();
    }

    check(localOffset, 30);
    if (localOffset >= directoryOffset || u32(localOffset) !== 0x04034b50 ||
        u16(localOffset + 6) !== flags || u16(localOffset + 8) !== method) fail();
    const localNameLength = u16(localOffset + 26);
    const localExtraLength = u16(localOffset + 28);
    check(localOffset + 30, localNameLength + localExtraLength);
    if (bytes.slice(localOffset + 30, localOffset + 30 + localNameLength) !== name) fail();
    checkExtras(localOffset + 30 + localNameLength, localExtraLength);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const descriptor = (flags & 8) !== 0;
    const matchesLocal = (field: number, value: number) =>
      descriptor ? (field === 0 || field === value) : field === value;
    if (!matchesLocal(u32(localOffset + 14), checksum) ||
        !matchesLocal(u32(localOffset + 18), compressed) ||
        !matchesLocal(u32(localOffset + 22), expanded) ||
        (method === 0 && compressed !== expanded)) fail();
    const dataEnd = dataOffset + compressed;
    if (dataEnd > directoryOffset) fail();
    let localEnd = dataEnd;
    if (descriptor) {
      if (localEnd + 4 > directoryOffset) fail();
      if (u32(localEnd) === 0x08074b50) localEnd += 4;
      if (localEnd + 12 > directoryOffset ||
          u32(localEnd) !== checksum || u32(localEnd + 4) !== compressed ||
          u32(localEnd + 8) !== expanded) fail();
      localEnd += 12;
    }
    members.push({
      start: localOffset, end: localEnd, dataOffset, compressed, expanded,
      method, checksum, maximum: worksheet ? MAX_SHEET : MAX_ENTRY,
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== end || !workbook || !contentTypes || !sheet) fail();
  // Reject hidden, overlapping, out-of-order, or repeated local ZIP members.
  members.sort((a, b) => a.start - b.start);
  let nextLocal = 0;
  for (const member of members) {
    if (member.start !== nextLocal) fail();
    nextLocal = member.end;
  }
  if (nextLocal !== directoryOffset) fail();

  let actualTotal = 0;
  for (const member of members) {
    let actual = 0;
    let crc = 0xffffffff;
    const consume = (chunk: Uint8Array) => {
      actual += chunk.byteLength;
      actualTotal += chunk.byteLength;
      if (actual > member.maximum || actual > member.expanded ||
          actualTotal > MAX_EXPANDED) fail();
      for (const b of chunk) crc = crcTable[(crc ^ b) & 255] ^ (crc >>> 8);
    };
    if (member.method === 0) {
      // Stored entries are intrinsically limited by the 2 MiB file cap.
      for (let position = 0; position < member.compressed; position += COMPRESSED_CHUNK) {
        const size = Math.min(COMPRESSED_CHUNK, member.compressed - position);
        const chunk = new Uint8Array(size);
        for (let i = 0; i < size; i++) chunk[i] = byte(member.dataOffset + position + i);
        consume(chunk);
      }
    } else {
      // Tauri WebView2 runtime support is feature-detected: older embedded
      // browsers MUST fail closed rather than delegate unchecked to SheetJS.
      if (typeof DecompressionStream !== 'function' || typeof ReadableStream !== 'function') fail();
      let inflater: DecompressionStream;
      try {
        inflater = new DecompressionStream('deflate-raw' as CompressionFormat);
      } catch { fail(); }
      let inputPosition = 0;
      const source = new ReadableStream<BufferSource>({
        pull(controller) {
          if (inputPosition === member.compressed) {
            controller.close();
            return;
          }
          const size = Math.min(COMPRESSED_CHUNK, member.compressed - inputPosition);
          const chunk = new Uint8Array(size);
          for (let i = 0; i < size; i++) chunk[i] = byte(member.dataOffset + inputPosition + i);
          inputPosition += size;
          controller.enqueue(chunk);
        },
      });
      const reader = source.pipeThrough(inflater).getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          consume(value);
        }
      } catch {
        await reader.cancel().catch(() => undefined);
        fail();
      } finally {
        reader.releaseLock();
      }
    }
    if (actual !== member.expanded || ((crc ^ 0xffffffff) >>> 0) !== member.checksum) fail();
  }
}
