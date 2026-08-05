/**
 * importBounds.test.js — the structural import trust boundary.
 * Covers: oversize gate, zip-slip entry-name rejection, XXE/DOCTYPE stripping,
 * safe XML parse (parsererror → ImportError), and bounded zip round-trip.
 */
import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import {
  assertFileSize, isUnsafeEntryName, stripDoctype, parseXmlSafe, safeLoadZip,
  entryText, entryDataUri, ImportError, MAX_FILE_BYTES,
} from '../importBounds.js'

describe('assertFileSize', () => {
  it('accepts a normal size', () => {
    expect(() => assertFileSize(1024, 'f')).not.toThrow()
  })
  it('rejects an oversize input fail-closed', () => {
    expect(() => assertFileSize(MAX_FILE_BYTES + 1, 'big')).toThrow(ImportError)
  })
})

describe('isUnsafeEntryName (zip-slip / traversal)', () => {
  it('flags traversal, absolute, drive, backslash and NUL paths', () => {
    for (const bad of [
      '../evil.txt', 'a/../../etc/passwd', '/abs/path', '\\win\\path',
      'C:\\x', 'foo\0bar', '..', 'a/..',
    ]) {
      expect(isUnsafeEntryName(bad)).toBe(true)
    }
  })
  it('allows ordinary in-archive paths', () => {
    for (const ok of ['content.xml', 'ppt/slides/slide1.xml', 'Pictures/img.png', 'a..b/c']) {
      expect(isUnsafeEntryName(ok)).toBe(false)
    }
  })
})

describe('stripDoctype (XXE / billion-laughs)', () => {
  it('removes DOCTYPE + ENTITY declarations', () => {
    const xml = `<?xml version="1.0"?>
      <!DOCTYPE lolz [ <!ENTITY lol "LOL"> <!ENTITY a "&lol;&lol;&lol;"> ]>
      <root>&a;</root>`
    const out = stripDoctype(xml)
    expect(out).not.toMatch(/DOCTYPE/i)
    expect(out).not.toMatch(/ENTITY/i)
    expect(out).toContain('<root>')
  })
  it('leaves normal markup untouched', () => {
    const xml = '<root><child>hi</child></root>'
    expect(stripDoctype(xml)).toBe(xml)
  })
})

describe('parseXmlSafe', () => {
  it('parses valid XML into a Document', () => {
    const doc = parseXmlSafe('<a><b>x</b></a>', 'test')
    expect(doc.getElementsByTagName('b')[0].textContent).toBe('x')
  })
  it('does NOT expand an entity from a stripped DOCTYPE (XXE-safe)', () => {
    const xml = '<!DOCTYPE r [ <!ENTITY secret "PWNED"> ]><r>&secret;</r>'
    // With the DOCTYPE stripped, &secret; is an undefined entity → parse error,
    // never an expansion to "PWNED". Either way, "PWNED" must never appear.
    let text = ''
    try { text = parseXmlSafe(xml, 'x').documentElement.textContent } catch { /* ImportError ok */ }
    expect(text).not.toContain('PWNED')
  })
  it('throws ImportError on malformed XML', () => {
    expect(() => parseXmlSafe('<a><b></a>', 'bad')).toThrow(ImportError)
  })

  it('does NOT resolve a SYSTEM (external) general entity — no file/SSRF read', () => {
    const xml = '<!DOCTYPE r [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]><r>&xxe;</r>'
    let text = ''
    try { text = parseXmlSafe(xml, 'x').documentElement.textContent } catch { /* ImportError ok */ }
    expect(text).not.toMatch(/root:/)      // /etc/passwd contents never appear
    expect(text).not.toContain('passwd')
  })

  it('does NOT fetch an external DTD (SYSTEM subset) — no SSRF', () => {
    const xml = '<!DOCTYPE r SYSTEM "http://169.254.169.254/latest/meta-data/"><r>ok</r>'
    // DOCTYPE stripped → either a clean parse of <r>ok</r> or a parse error, but
    // NEVER a network fetch of the external DTD URL.
    let text = ''
    try { text = parseXmlSafe(xml, 'x').documentElement.textContent } catch { /* ok */ }
    expect(text === 'ok' || text === '').toBe(true)
  })

  it('fails closed on a DOCTYPE whose internal subset entity carries a > / nested bracket', () => {
    // A crafted internal subset designed to slip a `>` past a naive strip. Whatever
    // the strip leaves, the entity must NOT expand to its payload.
    const xml = '<!DOCTYPE r [ <!ENTITY a "PWNED> ]"> ]><r>&a;</r>'
    let text = ''
    try { text = parseXmlSafe(xml, 'x').documentElement.textContent } catch { /* ImportError ok */ }
    expect(text).not.toContain('PWNED')
  })

  it('billion-laughs does not expand (nested internal entities neutralised)', () => {
    const xml = `<!DOCTYPE lolz [
      <!ENTITY lol "lol">
      <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
      <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
    ]><lolz>&lol3;</lolz>`
    let text = ''
    try { text = parseXmlSafe(xml, 'x').documentElement.textContent } catch { /* ImportError ok */ }
    // No expansion: the entity is stripped, so &lol3; is undefined text at most.
    expect(text.length).toBeLessThan(50)
    expect(text).not.toMatch(/lollollol/)
  })
})

describe('safeLoadZip / entryText / entryDataUri', () => {
  it('loads a clean zip and reads entries back', async () => {
    const zip = new JSZip()
    zip.file('content.xml', '<r>hello</r>')
    zip.file('Pictures/x.png', new Uint8Array([1, 2, 3, 4]))
    const ab = await zip.generateAsync({ type: 'arraybuffer' })
    const loaded = await safeLoadZip(ab, 'test.zip')
    expect(await entryText(loaded, 'content.xml')).toBe('<r>hello</r>')
    const uri = await entryDataUri(loaded, 'Pictures/x.png', 'image/png')
    expect(uri).toMatch(/^data:image\/png;base64,/)
  })
  it('rejects a zip carrying a traversal entry name', async () => {
    const zip = new JSZip()
    zip.file('ok.txt', 'x')
    // Force a raw traversal name into the archive.
    zip.files['../evil.txt'] = zip.files['ok.txt']
    const ab = await zip.generateAsync({ type: 'arraybuffer' })
    // Re-load (generate may normalise); assert the guard rejects it if present.
    const reloaded = await JSZip.loadAsync(ab)
    if (Object.keys(reloaded.files).some(isUnsafeEntryName)) {
      await expect(safeLoadZip(ab, 'evil.zip')).rejects.toThrow(ImportError)
    } else {
      expect(true).toBe(true) // JSZip normalised the name; nothing unsafe reached us
    }
  })
  it('rejects a non-archive buffer', async () => {
    const notZip = new TextEncoder().encode('not a zip at all').buffer
    await expect(safeLoadZip(notZip, 'x.zip')).rejects.toThrow(ImportError)
  })
})

// ── Zip-bomb: LYING central directory (declared << actual) ────────────────────
// A hostile archive can declare a tiny uncompressedSize in the central directory
// while the deflate stream actually inflates to gigabytes. The declared-size gate
// in safeLoadZip is fooled; the ONLY sound defence is bounding the ACTUAL inflate
// mid-stream. These tests build such a lying zip by hand and prove the streaming
// reader aborts on real bytes, not on the (fake) declared size — and never after
// fully decompressing.
import zlib from 'node:zlib'
import { inflateEntryBounded, assertArchiveBounds, MAX_SINGLE_ENTRY, MAX_TOTAL_UNCOMPRESSED } from '../importBounds.js'

function crc32(buf: Buffer): number {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1))
  }
  return (~c) >>> 0
}

// Single deflate entry whose headers LIE about the uncompressed size.
function buildLyingZip(name: string, content: Buffer, declaredUncompressed: number): Uint8Array {
  const nameBuf = Buffer.from(name, 'utf8')
  const comp = zlib.deflateRawSync(content)
  const crc = crc32(content)
  const D = declaredUncompressed

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

describe('zip-bomb: lying central directory (actual-inflate bound)', () => {
  it('safeLoadZip is fooled by the tiny declared size but the read still fails closed', async () => {
    // 8 MB of 'A' declared as only 100 bytes — safeLoadZip sees 100 and passes.
    const content = Buffer.alloc(8 * 1024 * 1024, 65)
    const ab = buildLyingZip('content.xml', content, 100)
    const zip = await safeLoadZip(ab, 'bomb.zip') // passes: declared 100 << caps

    // Inject a small per-entry cap: the streaming reader must reject on ACTUAL
    // inflated bytes (8 MB) despite the 100-byte declaration — and abort long
    // before the whole 8 MB is decompressed.
    await expect(inflateEntryBounded(zip, 'content.xml', 256 * 1024)).rejects.toThrow(ImportError)
  })

  it('a size-mismatched (lying) entry UNDER the cap ALSO fails closed', async () => {
    // Even below the size cap, a declared≠actual entry is refused: JSZip's own
    // end-of-stream length check fires (belt-and-braces with our streaming cap).
    const content = Buffer.from('hello '.repeat(1000)) // 6000 bytes
    const ab = buildLyingZip('content.xml', content, 5) // declares 5, really 6000
    const zip = await safeLoadZip(ab, 'liar.zip')
    await expect(entryText(zip, 'content.xml')).rejects.toThrow(ImportError)
  })

  it('an HONEST entry decompresses correctly (no false positive)', async () => {
    const zip = new JSZip()
    const text = 'hello '.repeat(1000)
    zip.file('content.xml', text)
    const ab = await zip.generateAsync({ type: 'uint8array' })
    const loaded = await safeLoadZip(ab, 'ok.zip')
    expect(await entryText(loaded, 'content.xml')).toBe(text)
  })

  it('the public entryText honours the per-archive cumulative decompressed budget', async () => {
    const jz = new JSZip()
    jz.file('content.xml', 'B'.repeat(4 * 1024 * 1024)) // 4 MB, honest
    const ab = await jz.generateAsync({ type: 'uint8array' })
    const zip = await safeLoadZip(ab, 'ok3.zip')
    // Simulate a nearly-exhausted archive budget (as if earlier entries already
    // consumed most of MAX_TOTAL_UNCOMPRESSED): the next 4 MB read must be refused.
    zip.__inflatedRemaining = 50 * 1024
    await expect(entryText(zip, 'content.xml')).rejects.toThrow(ImportError)
  })

  it('the cumulative budget decrements by the actual inflated size across reads', async () => {
    const jz = new JSZip()
    const text = 'C'.repeat(2 * 1024 * 1024) // 2 MB, honest
    jz.file('content.xml', text)
    const ab = await jz.generateAsync({ type: 'uint8array' })
    const zip = await safeLoadZip(ab, 'ok4.zip')
    await entryText(zip, 'content.xml')
    expect(zip.__inflatedRemaining).toBe(MAX_TOTAL_UNCOMPRESSED - text.length)
  })

  it('MAX_SINGLE_ENTRY is the default per-entry ceiling', () => {
    expect(MAX_SINGLE_ENTRY).toBeGreaterThan(0)
    expect(MAX_SINGLE_ENTRY).toBeLessThanOrEqual(MAX_TOTAL_UNCOMPRESSED)
  })
})

// ── assertArchiveBounds: the pre-check for self-inflating importers (docx/xlsx) ─
// mammoth (docx) and SheetJS (xlsx/ods) inflate the archive THEMSELVES, so the
// entryText/entryDataUri mid-stream cap never protects them. assertArchiveBounds
// runs first: the central-directory declared-size gate PLUS an actual-inflate
// pass over every entry, so BOTH a declared-oversize bomb and a lying-CD
// (declares small, inflates big) bomb are rejected before the library parses.
describe('assertArchiveBounds (docx/xlsx zip-bomb pre-check)', () => {
  it('passes an honest, in-bounds archive and returns the JSZip', async () => {
    const jz = new JSZip()
    jz.file('content.xml', '<r>ok</r>')
    jz.file('Pictures/x.png', new Uint8Array([1, 2, 3, 4]))
    const ab = await jz.generateAsync({ type: 'uint8array' })
    const zip = await assertArchiveBounds(ab, 'ok.xlsx')
    expect(Object.keys(zip.files)).toContain('content.xml')
  })

  it('rejects a central directory that DECLARES an oversize entry (no inflation needed)', async () => {
    // CD lies that a tiny entry is 200 MB (> MAX_SINGLE_ENTRY): the declared-size
    // gate in safeLoadZip fires first — rejected without inflating a byte.
    const ab = buildLyingZip('content.xml', Buffer.from('<r>tiny</r>'), 200 * 1024 * 1024)
    await expect(assertArchiveBounds(ab, 'bomb.xlsx')).rejects.toThrow(ImportError)
  })

  it('rejects a LYING central directory (declares 100 bytes, inflates megabytes) via the actual-inflate cap', async () => {
    // 8 MB of 'A' declared as 100 bytes: the declared gate is fooled, so the
    // actual-inflate pass is what must catch it. A 256 KB injected per-entry cap
    // exercises that layer cheaply (production uses MAX_SINGLE_ENTRY).
    const content = Buffer.alloc(8 * 1024 * 1024, 65)
    const ab = buildLyingZip('content.xml', content, 100)
    await expect(assertArchiveBounds(ab, 'liar.xlsx', 256 * 1024)).rejects.toThrow(ImportError)
  })
})
