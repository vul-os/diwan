/**
 * src/apps/sheets/csvImport.ts
 *
 * CSV import — parses CSV text (quoted fields, custom delimiters) into
 * a Fortune Sheet celldata array, ready to merge as a new sheet.
 */

export interface CsvCellValue {
  v: string | number
  m: string
  ct: { fa: string; t: string }
}

export interface CsvCellEntry {
  r: number
  c: number
  v: CsvCellValue
}

export interface CsvSheet {
  name: string
  celldata: CsvCellEntry[]
  config: Record<string, never>
}

/** A sheet-like input to sheetsToCSV — only celldata's shape matters here. */
export interface CsvSourceCell {
  r: number
  c: number
  v?: { v?: string | number | boolean; m?: string | number } | string | number | boolean | null
}
export interface CsvSourceSheet {
  celldata?: CsvSourceCell[]
}

/**
 * parseCSV(text, delimiter) → string[][]
 * RFC 4180-compliant parser: handles quoted fields, embedded newlines,
 * escaped double-quotes (""). Returns a 2D array of raw strings.
 */
export function parseCSV(text: string, delimiter = ','): string[][] {
  const rows: string[][] = []
  let col: string[] = []
  let i = 0
  const n = text.length

  while (i < n) {
    if (text[i] === '"') {
      // Quoted field.
      let val = ''
      i++ // skip opening quote
      while (i < n) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            val += '"'
            i += 2
          } else {
            i++ // skip closing quote
            break
          }
        } else {
          val += text[i]
          i++
        }
      }
      col.push(val)
      // Skip delimiter or newline after quoted field.
      if (i < n && text[i] === delimiter) i++
      else if (i < n && text[i] === '\r') { i++; if (text[i] === '\n') i++; rows.push(col); col = [] }
      else if (i < n && text[i] === '\n') { i++; rows.push(col); col = [] }
    } else {
      // Unquoted field — scan to delimiter or newline.
      const start = i
      while (i < n && text[i] !== delimiter && text[i] !== '\n' && text[i] !== '\r') i++
      col.push(text.slice(start, i))
      if (i < n && text[i] === delimiter) {
        i++
      } else if (i < n && text[i] === '\r') {
        i++
        if (text[i] === '\n') i++
        rows.push(col); col = []
      } else if (i < n && text[i] === '\n') {
        i++
        rows.push(col); col = []
      }
    }
  }
  if (col.length > 0) rows.push(col)
  return rows
}

/**
 * csvToSheet(text, sheetName, delimiter) → Fortune Sheet Sheet object.
 */
export function csvToSheet(text: string, sheetName = 'Imported', delimiter = ','): CsvSheet {
  const rows = parseCSV(text, delimiter)
  const celldata: CsvCellEntry[] = []
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < rows[r].length; c++) {
      const raw = rows[r][c]
      if (raw === '') continue
      const num = Number(raw)
      const isNum = raw !== '' && !isNaN(num) && raw.trim() !== ''
      celldata.push({
        r, c,
        v: {
          v: isNum ? num : raw,
          m: raw,
          ct: { fa: 'General', t: isNum ? 'n' : 's' },
        },
      })
    }
  }
  return { name: sheetName, celldata, config: {} }
}

/**
 * importCSVFile(file, delimiter) → Promise<Sheet>
 * Reads a File object and returns a Fortune Sheet sheet.
 */
export function importCSVFile(file: File, delimiter = ','): Promise<CsvSheet> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const result = e.target?.result
        const sheet = csvToSheet(String(result ?? ''), file.name.replace(/\.csv$/i, ''), delimiter)
        resolve(sheet)
      } catch (err) {
        reject(err)
      }
    }
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.readAsText(file, 'UTF-8')
  })
}

/**
 * sheetsToCSV(sheet) → CSV string for the given Fortune Sheet sheet.
 */
export function sheetsToCSV(sheet: CsvSourceSheet): string {
  const cells = sheet.celldata || []
  let maxR = 0, maxC = 0
  for (const { r, c } of cells) {
    if (r > maxR) maxR = r
    if (c > maxC) maxC = c
  }
  const grid: string[][] = Array.from({ length: maxR + 1 }, () => new Array(maxC + 1).fill(''))
  for (const { r, c, v } of cells) {
    if (!v) continue
    const val = typeof v === 'object' ? (v.v !== undefined ? v.v : (v.m ?? '')) : v
    grid[r][c] = String(val)
  }
  return grid.map((row) =>
    row.map((cell) => {
      if (cell.includes(',') || cell.includes('"') || cell.includes('\n')) {
        return `"${cell.replace(/"/g, '""')}"`
      }
      return cell
    }).join(',')
  ).join('\n')
}
