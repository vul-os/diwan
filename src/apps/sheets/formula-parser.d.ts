/**
 * Minimal ambient types for `@fortune-sheet/formula-parser`, which ships no
 * declaration file of its own (verified: no `.d.ts` under its `lib`/`es`
 * dirs). Covers only the surface colorScales.ts actually uses: constructing a
 * `Parser`, its two reference-resolution events, and `.parse()`.
 */
declare module '@fortune-sheet/formula-parser' {
  export interface FormulaCoordPart {
    index: number
    isAbsolute: boolean
  }

  export interface FormulaCellCoord {
    label: string
    row: FormulaCoordPart
    column: FormulaCoordPart
    sheetName?: string | null
  }

  export interface FormulaParseResult {
    error: string | null
    result: unknown
  }

  export class Parser {
    constructor()
    parse(expression: string, options?: Record<string, unknown>): FormulaParseResult
    setVariable(name: string, value: unknown): Parser
    on(
      event: 'callCellValue',
      handler: (coord: FormulaCellCoord, options: unknown, done: (value: unknown) => void) => void,
    ): void
    on(
      event: 'callRangeValue',
      handler: (
        start: FormulaCellCoord,
        end: FormulaCellCoord,
        options: unknown,
        done: (value: unknown[][]) => void,
      ) => void,
    ): void
  }
}
