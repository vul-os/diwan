/**
 * src/lib/index.js — @vulos/office-client main library barrel
 *
 * Re-exports the embeddable app components. Build target: dist-lib/
 * (Chat/video are third-party per the VulOS standard, not built by Office;
 * Calendar + Contacts are bring-your-own PIM via lilmail's CalDAV/CardDAV.)
 */

export { DocsApp }     from '../apps/docs/lib.jsx'
export { SheetsApp }   from '../apps/sheets/lib.jsx'
export { SlidesApp }   from '../apps/slides/lib.jsx'
export { PDFApp }      from '../apps/pdf/lib.jsx'
