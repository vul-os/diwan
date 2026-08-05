/**
 * src/lib/xmlText.js — XML-1.0 text sanitisation shared by the OOXML / ODF
 * exporters (docx, xlsx, pptx, odt, ods).
 *
 * WHY (deep/office2 data-integrity fix): XML 1.0 forbids most C0 control
 * characters in element/attribute text — only TAB (#x9), LF (#xA) and CR (#xD)
 * are legal below #x20. A document string can carry an illegal control char
 * (VT #x0B, FF #x0C, NUL #x00, #x1F, …) via .txt/.docx/.odt/.md import (mammoth
 * and the plain-text importer pass them through untouched) or a pasting/hostile
 * CRDT peer. The exporters escaped `& < > " '` but did NOT strip these control
 * chars, so the emitted content.xml / document.xml / slide1.xml contained a
 * "disallowed character" and Word / LibreOffice / PowerPoint REFUSE or "repair"
 * the file — a corrupt, non-round-trippable export. SheetJS already strips them
 * for xlsx/ods; this brings the hand-rolled serialisers to parity.
 *
 * stripXmlInvalidChars removes exactly the code points XML 1.0 disallows:
 *   • [#x0–#x8], #xB, #xC, [#xE–#x1F]  (C0 controls except TAB/LF/CR)
 *   • #xFFFE, #xFFFF                   (the permanently-unassigned non-chars)
 * It KEEPS TAB/LF/CR, all printable ASCII, astral emoji, CJK, and RTL text.
 */

// eslint-disable-next-line no-control-regex
const XML10_INVALID = /[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]/g

/** Remove characters illegal in XML 1.0 text (keeps TAB/LF/CR + all valid text). */
export function stripXmlInvalidChars(s: unknown): string {
  const str = typeof s === 'string' || typeof s === 'number' || typeof s === 'boolean' ? String(s) : ''
  return str.replace(XML10_INVALID, '')
}

/** Strip XML-invalid chars, then escape the five XML metacharacters for text/attr. */
export function escapeXmlText(s: unknown): string {
  return stripXmlInvalidChars(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
