/**
 * zipBombFixture.js — shared TEST fixtures for zip-bomb import guards.
 * ----------------------------------------------------------------------------
 * Hand-builds zip archives whose CENTRAL DIRECTORY lies about an entry's
 * uncompressed size, so the importer's zip-bomb pre-check (assertArchiveBounds)
 * can be exercised without shipping a real multi-gigabyte bomb:
 *
 *  - buildLyingZip(name, content, declaredUncompressed): a single deflate entry
 *    whose headers DECLARE `declaredUncompressed` bytes while the stream really
 *    inflates to `content.length`. Declaring SMALL (< actual) models the classic
 *    "lying central directory" that fools a declared-size gate — only an actual
 *    inflate cap catches it. Declaring LARGE (> the caps) models an oversize
 *    bomb the central-directory pre-check rejects before inflating a byte.
 */
import zlib from 'node:zlib'

function crc32(buf: Buffer): number {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1))
  }
  return (~c) >>> 0
}

/** Single deflate entry whose local + central headers LIE about uncompressed size. */
export function buildLyingZip(name: string, content: Buffer, declaredUncompressed: number): Uint8Array {
  const nameBuf = Buffer.from(name, 'utf8')
  const comp = zlib.deflateRawSync(content)
  const crc = crc32(content)
  const D = declaredUncompressed >>> 0

  const local = Buffer.alloc(30 + nameBuf.length)
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6)
  local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(D, 22) // LIE
  local.writeUInt16LE(nameBuf.length, 26); nameBuf.copy(local, 30)

  const cd = Buffer.alloc(46 + nameBuf.length)
  cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6)
  cd.writeUInt16LE(8, 10); cd.writeUInt32LE(crc, 16)
  cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(D, 24) // LIE
  cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(0, 42); nameBuf.copy(cd, 46)

  const localBlock = Buffer.concat([local, comp])
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(localBlock.length, 16)
  return new Uint8Array(Buffer.concat([localBlock, cd, eocd]))
}
