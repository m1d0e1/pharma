/** @jest-environment node */
import * as XLSX from 'xlsx';
import { deflateRawSync } from 'node:zlib';
import { assertBoundedDesktopXlsxArchive } from '../xlsx-zip-preflight';

function workbook(): string {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['drug_id', 'quantity'], [12, 2.75],
  ]), 'inventory');
  return XLSX.write(wb, { bookType: 'xlsx', type: 'binary' }) as string;
}

function rewriteU32(binary: string, position: number, value: number): string {
  return binary.slice(0, position) + String.fromCharCode(
    value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255,
  ) + binary.slice(position + 4);
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  return crc >>> 0;
});

function crc32(content: Buffer): number {
  let value = 0xffffffff;
  for (const b of content) value = crcTable[(value ^ b) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

interface Entry {
  name: string;
  contents: Buffer;
  method?: 0 | 8;
  // Simulate forged central/local metadata with REAL compressed data intact.
  claimedLength?: number;
  useDescriptor?: boolean;
}

function zip(entries: Entry[]): string {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const filename = Buffer.from(entry.name, 'ascii');
    const method = entry.method ?? 8;
    const payload = method === 8 ? deflateRawSync(entry.contents) : entry.contents;
    const claimed = entry.claimedLength ?? entry.contents.length;
    const checksum = crc32(entry.contents);
    const flags = entry.useDescriptor ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    if (!entry.useDescriptor) {
      local.writeUInt32LE(checksum, 14);
      local.writeUInt32LE(payload.length, 18);
      local.writeUInt32LE(claimed, 22);
    }
    local.writeUInt16LE(filename.length, 26);
    locals.push(local, filename, payload);
    offset += local.length + filename.length + payload.length;
    if (entry.useDescriptor) {
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(checksum, 4);
      descriptor.writeUInt32LE(payload.length, 8);
      descriptor.writeUInt32LE(claimed, 12);
      locals.push(descriptor);
      offset += descriptor.length;
    }

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(claimed, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset - local.length - filename.length -
      payload.length - (entry.useDescriptor ? 16 : 0), 42);
    centrals.push(central, filename);
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]).toString('latin1');
}

const baseEntries = (): Entry[] => [
  { name: '[Content_Types].xml', contents: Buffer.from('<Types/>') },
  { name: 'xl/workbook.xml', contents: Buffer.from('<workbook/>') },
  { name: 'xl/worksheets/sheet1.xml', contents: Buffer.from('<worksheet/>') },
];

describe('real inflated-byte desktop XLSX archive preflight', () => {
  it('accepts a real SheetJS workbook and valid raw-deflate ZIP entries', async () => {
    await expect(assertBoundedDesktopXlsxArchive(workbook())).resolves.toBeUndefined();
    await expect(assertBoundedDesktopXlsxArchive(zip(baseEntries()))).resolves.toBeUndefined();
  });

  it('accepts well-formed data descriptors and checks their exact sizes and CRC', async () => {
    const entries = baseEntries();
    entries[1].useDescriptor = true;
    const input = zip(entries);
    await expect(assertBoundedDesktopXlsxArchive(input)).resolves.toBeUndefined();
    const signature = input.indexOf('PK\x07\x08');
    expect(signature).toBeGreaterThan(0);
    await expect(assertBoundedDesktopXlsxArchive(rewriteU32(input, signature + 8, 123456)))
      .rejects.toThrow();
  });

  it('rejects compressed input above 2 MiB and malformed ZIP structure', async () => {
    await expect(assertBoundedDesktopXlsxArchive('PK\x03\x04')).rejects.toThrow();
    await expect(assertBoundedDesktopXlsxArchive('x'.repeat(2 * 1024 * 1024 + 1)))
      .rejects.toThrow();
    await expect(assertBoundedDesktopXlsxArchive('not zip')).rejects.toThrow();
    await expect(assertBoundedDesktopXlsxArchive(zip(baseEntries()).slice(0, -2)))
      .rejects.toThrow();
  });

  it('rejects an actual 9 MiB inflation bomb lying about 1 byte expanded', async () => {
    const entries = baseEntries();
    entries.push({
      name: 'xl/styles.xml',
      contents: Buffer.alloc(9 * 1024 * 1024, 0x41),
      claimedLength: 1,
    });
    const attack = zip(entries);
    expect(attack.length).toBeLessThan(2 * 1024 * 1024);
    // The original metadata-only validator ACCEPTED this payload; its
    // central and local declared sizes are both 1.
    await expect(assertBoundedDesktopXlsxArchive(attack)).rejects.toThrow();
  });

  it('rejects an actual >4 MiB worksheet even when its ZIP metadata claims 1 byte', async () => {
    const entries = baseEntries();
    entries[2] = {
      name: 'xl/worksheets/sheet1.xml',
      contents: Buffer.alloc(4 * 1024 * 1024 + 1024, 0x41),
      claimedLength: 1,
    };
    await expect(assertBoundedDesktopXlsxArchive(zip(entries))).rejects.toThrow();
  });

  it('rejects actual cumulative inflation above 16 MiB across individually legal entries', async () => {
    const entries = baseEntries();
    for (let i = 0; i < 3; i++) {
      entries.push({
        name: 'xl/customXml/item' + i + '.xml',
        contents: Buffer.alloc(6 * 1024 * 1024, 0x41),
        claimedLength: 1,
      });
    }
    await expect(assertBoundedDesktopXlsxArchive(zip(entries))).rejects.toThrow();
  });

  it('rejects inaccurate but small inflated sizes independently of CRC', async () => {
    const entries = baseEntries();
    entries[1].claimedLength = 2;
    await expect(assertBoundedDesktopXlsxArchive(zip(entries))).rejects.toThrow();
  });

  it('rejects corrupted central/local CRC and corrupted DEFLATE payloads', async () => {
    const input = zip(baseEntries());
    const central = input.indexOf('PK\x01\x02');
    expect(central).toBeGreaterThan(0);
    await expect(assertBoundedDesktopXlsxArchive(rewriteU32(input, central + 16, 0)))
      .rejects.toThrow();
    const bad = input.slice(0, 35) + String.fromCharCode(input.charCodeAt(35) ^ 0xff) + input.slice(36);
    await expect(assertBoundedDesktopXlsxArchive(bad)).rejects.toThrow();
  });

  it('rejects ZIP64 and forged central directory offsets', async () => {
    const input = workbook();
    const end = input.lastIndexOf('PK\x05\x06');
    expect(end).toBeGreaterThan(0);
    await expect(assertBoundedDesktopXlsxArchive(rewriteU32(input, end + 16, 0xffffffff)))
      .rejects.toThrow();
    await expect(assertBoundedDesktopXlsxArchive(rewriteU32(input, end + 16, 0x7fffffff)))
      .rejects.toThrow();
  });

  it('rejects duplicated member paths, hidden prefixes and inconsistent local names', async () => {
    const entries = baseEntries();
    entries.push({ ...entries[1] });
    await expect(assertBoundedDesktopXlsxArchive(zip(entries))).rejects.toThrow();
    const input = zip(baseEntries());
    await expect(assertBoundedDesktopXlsxArchive('junk' + input)).rejects.toThrow();
    const fakeLocal = input.slice(0, 30) + 'x' + input.slice(31);
    await expect(assertBoundedDesktopXlsxArchive(fakeLocal)).rejects.toThrow();
  });

  it('fails closed if raw DEFLATE decompression is unavailable in an embedded browser', async () => {
    const original = globalThis.DecompressionStream;
    try {
      Object.defineProperty(globalThis, 'DecompressionStream', {
        value: undefined, configurable: true,
      });
      await expect(assertBoundedDesktopXlsxArchive(zip(baseEntries()))).rejects.toThrow();
    } finally {
      Object.defineProperty(globalThis, 'DecompressionStream', {
        value: original, configurable: true, writable: true,
      });
    }
  });
});
