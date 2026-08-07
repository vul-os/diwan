// charts.go — REAL OOXML charts in the SERVER-side .xlsx export.
//
// THE BUG THIS FIXES. The server exporter wrote cells and nothing else: the
// backend Sheet struct had no `charts` field at all, so every chart a user built
// in Vulos Sheets vanished from `GET /files/:id/export?format=xlsx` and from the
// public `POST /v1/documents/:id/export` — with a 200 and no warning. The browser
// exporter (src/apps/sheets/xlsxCharts.js) had already grown a real chart writer;
// the server path — the one every integration uses — had not.
//
// THE FIX. excelize (already our spreadsheet engine) can WRITE chart parts, so
// unlike the browser (whose SheetJS cannot) we do not need ZIP surgery: we hand
// excelize the same descriptor the frontend resolves — series/categories as REAL
// cell references (`'Sheet1'!$B$2:$B$9`) — and it emits `xl/charts/chartN.xml`, the
// drawing, the rels and the content types. The chart therefore RECALCULATES in
// Excel/LibreOffice/Numbers, exactly as the browser export's does.
//
// The one type with no Excel equivalent is our HISTOGRAM: the bins are OUR
// computation, not the sheet's. The browser writes them as literal cached values
// (c:numLit); excelize's series are cell-reference-only, so we instead compute the
// bins server-side and write them into a hidden "Vulos Chart Data" sheet that the
// chart's series point at. The result is strictly better than a literal: a real,
// live, cell-backed Excel chart. It still cannot RE-BIN if the source data changes
// in Excel, and that caveat is reported to the caller as a warning (never silently).
//
// FAIL-CLOSED, and the same trust boundary the browser writer keeps:
//   - a chart whose range cannot be resolved is SKIPPED and REPORTED — never
//     emitted as a broken part, never dropped quietly;
//   - every free-text field that reaches a cell (title, axis labels, range) goes
//     through escapeChartText, so a hostile cell value like `=HYPERLINK("http://evil")`
//     lands in the metadata sheet as inert text, not as a live formula;
//   - the metadata sheet is written too, so re-importing the .xlsx into Vulos
//     restores every chart exactly (its type, its bin count, its pixel position) —
//     things Excel's own chart XML cannot express.
package sheets_export

import (
	"fmt"
	"math"
	"strconv"
	"strings"

	"github.com/xuri/excelize/v2"
)

// ─── Chart descriptor (mirrors src/apps/sheets/charts.js makeChart) ──────────

// ChartOptions mirrors the descriptor's options object.
type ChartOptions struct {
	XAxisLabel  string `json:"xAxisLabel"`
	YAxisLabel  string `json:"yAxisLabel"`
	Y2AxisLabel string `json:"y2AxisLabel"`
	// legend / headerRow / headerCol default to TRUE when absent, so they are
	// pointers: a missing key must not read as `false` (which would silently
	// re-interpret every chart's data range).
	Legend        *bool `json:"legend"`
	HeaderRow     *bool `json:"headerRow"`
	HeaderCol     *bool `json:"headerCol"`
	SecondaryAxis bool  `json:"secondaryAxis"`
	Bins          int   `json:"bins"`
}

func (o ChartOptions) legend() bool    { return o.Legend == nil || *o.Legend }
func (o ChartOptions) headerRow() bool { return o.HeaderRow == nil || *o.HeaderRow }
func (o ChartOptions) headerCol() bool { return o.HeaderCol == nil || *o.HeaderCol }

// Chart is one chart descriptor as the content model persists it.
type Chart struct {
	ID      string       `json:"id"`
	Type    string       `json:"type"`
	Range   string       `json:"range"`
	Title   string       `json:"title"`
	X       float64      `json:"x"`
	Y       float64      `json:"y"`
	W       float64      `json:"w"`
	H       float64      `json:"h"`
	Options ChartOptions `json:"options"`
}

// Histogram bin bounds — the same clamp charts.js applies.
const (
	histBinsMin     = 2
	histBinsMax     = 50
	histBinsDefault = 10
)

// Grid geometry used to turn a chart's pixel position into an anchor cell —
// the same constants xlsxCharts.js anchors with.
const (
	defaultColPx = 64.0
	defaultRowPx = 20.0
)

// chartPalette — fixed, non-user series colours (never derived from cell data,
// so it can never be an injection vector). Mirrors CHART_PALETTE in charts.js.
var chartPalette = []string{
	"3B82F6", "EF4444", "10B981", "F59E0B", "8B5CF6",
	"EC4899", "14B8A6", "F97316", "6366F1", "84CC16",
}

func paletteAt(i int) string { return chartPalette[i%len(chartPalette)] }

// ─── Report: what the export carried, and what it could not ─────────────────

// SkippedChart records ONE chart the exporter could not embed, and why. It is
// surfaced to the caller (response header / documented field) so a lossy export
// is never a silent one.
type SkippedChart struct {
	ID     string `json:"id,omitempty"`
	Type   string `json:"type"`
	Title  string `json:"title,omitempty"`
	Reason string `json:"reason"`
}

// Report is the honest account of an export: how much rode as real chart parts,
// what was degraded, what was skipped, and the caller-presentable warnings.
type Report struct {
	ChartsEmbedded int            `json:"charts_embedded"`
	ChartsSkipped  []SkippedChart `json:"charts_skipped,omitempty"`
	// Warnings are plain sentences safe for an HTTP header (no CR/LF, bounded).
	Warnings []string `json:"warnings,omitempty"`
}

// Degraded reports whether anything about this export was lossy.
func (r *Report) Degraded() bool { return r != nil && len(r.Warnings) > 0 }

func (r *Report) warn(format string, args ...any) {
	r.Warnings = append(r.Warnings, sanitizeWarning(fmt.Sprintf(format, args...)))
}

// sanitizeWarning keeps a warning safe to put in an HTTP header: single line,
// no control characters, bounded length.
func sanitizeWarning(s string) string {
	var sb strings.Builder
	for _, r := range s {
		switch {
		case r == '\n' || r == '\r' || r == '\t':
			sb.WriteRune(' ')
		case r < 0x20 || r == 0x7f:
			// drop
		default:
			sb.WriteRune(r)
		}
	}
	out := strings.TrimSpace(sb.String())
	if len(out) > 300 {
		out = out[:299] + "…"
	}
	return out
}

// ─── escapeChartText (port of charts.js escapeChartText) ────────────────────

// escapeChartText normalises an untrusted cell-derived string for a context that
// may RE-PARSE it (a spreadsheet cell): control chars are stripped and a leading
// formula trigger (= + - @) is neutralised with a quote, so a title like
// `=HYPERLINK("http://evil")` can never be written as a live formula into the
// exported workbook.
func escapeChartText(v string, max int) string {
	if max <= 0 {
		max = 200
	}
	var sb strings.Builder
	for _, r := range v {
		switch {
		case r == '\t' || r == '\n' || r == '\r':
			sb.WriteRune(' ')
		case r < 0x20 || r == 0x7f:
			// drop C0/DEL
		default:
			sb.WriteRune(r)
		}
	}
	s := sb.String()
	if s != "" {
		switch s[0] {
		case '=', '+', '-', '@':
			s = "'" + s
		}
	}
	rs := []rune(s)
	if len(rs) > max {
		s = string(rs[:max-1]) + "…"
	}
	return s
}

// ─── Range parsing (port of ConditionalFormatPanel.jsx parseRange) ───────────

type cellRange struct{ r0, r1, c0, c1 int }

// fallbackRange is what the frontend's parseRange returns for an empty/unparseable
// range (A1:Z100). Mirrored so the server resolves a chart exactly as the browser
// does rather than dropping it.
var fallbackRange = cellRange{r0: 0, r1: 99, c0: 0, c1: 25}

// parseCellRef parses "B7" → (col 1, row 6). Returns ok=false when malformed.
func parseCellRef(s string) (col, row int, ok bool) {
	s = strings.TrimSpace(strings.ToUpper(s))
	s = strings.ReplaceAll(s, "$", "")
	i := 0
	for i < len(s) && s[i] >= 'A' && s[i] <= 'Z' {
		col = col*26 + int(s[i]-'A') + 1
		i++
	}
	if i == 0 || i == len(s) {
		return 0, 0, false
	}
	n, err := strconv.Atoi(s[i:])
	if err != nil || n < 1 {
		return 0, 0, false
	}
	return col - 1, n - 1, true
}

func parseRange(text string) cellRange {
	t := strings.TrimSpace(strings.ToUpper(text))
	if t == "" {
		return fallbackRange
	}
	parts := strings.Split(t, ":")
	switch len(parts) {
	case 1:
		c, r, ok := parseCellRef(parts[0])
		if !ok {
			return fallbackRange
		}
		return cellRange{r0: r, r1: r, c0: c, c1: c}
	case 2:
		c0, r0, ok1 := parseCellRef(parts[0])
		c1, r1, ok2 := parseCellRef(parts[1])
		if !ok1 || !ok2 {
			return fallbackRange
		}
		return cellRange{
			r0: min(r0, r1), r1: max(r0, r1),
			c0: min(c0, c1), c1: max(c0, c1),
		}
	default:
		return fallbackRange
	}
}

// ─── Reference geometry (port of xlsxCharts.js chartRefs) ───────────────────

type seriesRef struct {
	nameRef string // "" when the range carries no header row
	valRef  string
	col     int
}

type chartRefs struct {
	r0, r1, c0, c1   int
	dataR0, dataC0   int
	catRef           string // "" when the range carries no header column
	nCat             int
	series           []seriesRef
	hasHeaderRow     bool
	hasHeaderColumns bool
}

// absRef builds `'My Sheet'!$B$2:$B$9`. The sheet name is quoted and internal
// apostrophes doubled (the A1 escaping rule).
func absRef(sheetName string, c0, r0, c1, r1 int) string {
	name := sheetName
	if name == "" {
		name = "Sheet1"
	}
	name = strings.ReplaceAll(name, "'", "''")
	a, err1 := excelize.CoordinatesToCellName(c0+1, r0+1, true)
	b, err2 := excelize.CoordinatesToCellName(c1+1, r1+1, true)
	if err1 != nil || err2 != nil {
		return ""
	}
	if a == b {
		return fmt.Sprintf("'%s'!%s", name, a)
	}
	return fmt.Sprintf("'%s'!%s:%s", name, a, b)
}

// resolveRefs resolves a descriptor's range into the concrete cell references its
// series/categories point at. Returns ok=false when the range is unusable — the
// caller then SKIPS + REPORTS the chart rather than emitting a broken part.
func resolveRefs(ch Chart, sheetName string) (chartRefs, bool) {
	p := parseRange(ch.Range)
	rows := p.r1 - p.r0 + 1
	cols := p.c1 - p.c0 + 1
	if rows > 1000 {
		rows = 1000
	}
	if cols > 100 {
		cols = 100
	}
	if rows <= 0 || cols <= 0 || p.r0 < 0 || p.c0 < 0 {
		return chartRefs{}, false
	}
	r1 := p.r0 + rows - 1
	c1 := p.c0 + cols - 1

	hasHeaderRow := ch.Options.headerRow() && rows > 1
	hasHeaderCol := ch.Options.headerCol() && cols > 1
	dataR0 := p.r0
	if hasHeaderRow {
		dataR0++
	}
	dataC0 := p.c0
	if hasHeaderCol {
		dataC0++
	}
	if dataR0 > r1 || dataC0 > c1 {
		return chartRefs{}, false
	}

	refs := chartRefs{
		r0: p.r0, r1: r1, c0: p.c0, c1: c1,
		dataR0: dataR0, dataC0: dataC0,
		nCat:             r1 - dataR0 + 1,
		hasHeaderRow:     hasHeaderRow,
		hasHeaderColumns: hasHeaderCol,
	}
	if hasHeaderCol {
		refs.catRef = absRef(sheetName, p.c0, dataR0, p.c0, r1)
	}
	for c := dataC0; c <= c1; c++ {
		s := seriesRef{col: c, valRef: absRef(sheetName, c, dataR0, c, r1)}
		if s.valRef == "" {
			return chartRefs{}, false
		}
		if hasHeaderRow {
			s.nameRef = absRef(sheetName, c, p.r0, c, p.r0)
		}
		refs.series = append(refs.series, s)
	}
	if len(refs.series) == 0 {
		return chartRefs{}, false
	}
	return refs, true
}

// ─── Histogram binning (port of charts.js histogramBins) ────────────────────

type histBin struct {
	label string
	count int
}

// histogramBins bins a flat list of numbers into equal-width buckets. Pure and
// bounded: bins is clamped to [2,50], a degenerate range (all values equal)
// collapses to one centred bucket so we never divide by zero, and the last bucket
// is inclusive of the max (standard histogram convention).
func histogramBins(values []float64, bins int) []histBin {
	if len(values) == 0 {
		return nil
	}
	k := bins
	if k < histBinsMin || k > histBinsMax {
		if k == 0 {
			k = histBinsDefault
		} else {
			k = min(histBinsMax, max(histBinsMin, k))
		}
	}
	lo, hi := values[0], values[0]
	for _, v := range values {
		lo = math.Min(lo, v)
		hi = math.Max(hi, v)
	}
	if lo == hi {
		lo -= 0.5
		hi += 0.5
	}
	width := (hi - lo) / float64(k)
	out := make([]histBin, k)
	for i := 0; i < k; i++ {
		x0 := lo + float64(i)*width
		x1 := hi
		if i != k-1 {
			x1 = lo + float64(i+1)*width
		}
		out[i] = histBin{label: binNum(x0) + "–" + binNum(x1)}
	}
	for _, v := range values {
		i := int(math.Floor((v - lo) / width))
		if i < 0 {
			i = 0
		}
		if i >= k {
			i = k - 1
		}
		out[i].count++
	}
	return out
}

func binNum(v float64) string {
	r := math.Round(v*100) / 100
	return strconv.FormatFloat(r, 'f', -1, 64)
}

// ─── Chart-type support matrix ──────────────────────────────────────────────

// nativeSupport answers: can this chart become a REAL Excel chart, and with what
// caveat? Computed from one table so the writer and the warning can never drift
// apart (the same discipline nativeXlsxSupport keeps in the browser).
func nativeSupport(t string) (excelize.ChartType, string, bool) {
	switch t {
	case "column":
		return excelize.Col, "", true
	case "bar":
		return excelize.Bar, "", true
	case "column-stacked":
		return excelize.ColStacked, "", true
	case "bar-stacked":
		return excelize.BarStacked, "", true
	case "column-100":
		return excelize.ColPercentStacked, "", true
	case "bar-100":
		return excelize.BarPercentStacked, "", true
	case "line":
		return excelize.Line, "", true
	case "area":
		return excelize.Area, "", true
	case "combo":
		return excelize.Col, "", true // + a Line combo chart, added by the writer
	case "pie":
		return excelize.Pie, "", true
	case "donut":
		return excelize.Doughnut, "", true
	case "scatter":
		return excelize.Scatter, "", true
	case "bubble":
		return excelize.Bubble, "", true
	case "histogram":
		return excelize.Col, "histogram bins are computed at export time and written to cells — Excel will not re-bin them if the data changes", true
	}
	return 0, "no Excel equivalent", false
}

// ─── The writer ─────────────────────────────────────────────────────────────

// chartMetaSheet / chartDataSheet are OUR bookkeeping sheets, both hidden.
const (
	// CHART_META_SHEET in src/apps/sheets/sheetsExport.js — the lossless round-trip
	// carrier the Vulos importer reads back (sheetsImport.chartsFromMetaSheet).
	chartMetaSheet = "Vulos Charts"
	// Backing cells for chart types whose values are ours, not the sheet's.
	chartDataSheet = "Vulos Chart Data"
)

// chartMetaColumns is the metadata sheet's schema — byte-for-byte the frontend's
// CHART_META_COLUMNS, because src/apps/sheets/sheetsImport.js parses it back and
// rejects any header that is not exactly this one.
var chartMetaColumns = []string{
	"type", "range", "title", "xAxisLabel", "yAxisLabel", "legend", "headerRow", "headerCol",
	"y2AxisLabel", "secondaryAxis", "bins", "x", "y", "w", "h", "id",
}

func yesNo(b bool) string {
	if b {
		return "yes"
	}
	return "no"
}

// anchorCell turns a chart's pixel position over the grid into the worksheet cell
// the drawing anchors at. Clamped: a hostile/corrupt geometry must not produce an
// out-of-range anchor (which is one of the few ways to make Excel reject a file).
func anchorCell(ch Chart) string {
	col := int(math.Round(clampFloat(ch.X, 0, 100000, 0) / defaultColPx))
	row := int(math.Round(clampFloat(ch.Y, 0, 100000, 0) / defaultRowPx))
	col = min(col, 16000)
	row = min(row, 1000000)
	name, err := excelize.CoordinatesToCellName(col+1, row+1)
	if err != nil {
		return "A1"
	}
	return name
}

func clampFloat(v, lo, hi, dflt float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return dflt
	}
	return math.Min(hi, math.Max(lo, v))
}

// chartDimension clamps w/h to the same bounds makeChart enforces.
func chartDimension(ch Chart) excelize.ChartDimension {
	w := clampFloat(ch.W, 160, 4000, 480)
	h := clampFloat(ch.H, 120, 4000, 300)
	if ch.W == 0 {
		w = 480
	}
	if ch.H == 0 {
		h = 300
	}
	return excelize.ChartDimension{Width: uint(w), Height: uint(h)}
}

// richTitle builds a chart title. excelize 2.11 replaced the bare
// []RichTextRun with a ChartTitle struct that carries the runs in Paragraph
// alongside fill/border/font settings; an empty struct is the "no title" value
// where nil used to be.
func richTitle(s string) excelize.ChartTitle {
	if s == "" {
		return excelize.ChartTitle{}
	}
	return excelize.ChartTitle{Paragraph: []excelize.RichTextRun{{Text: escapeChartText(s, 200)}}}
}

func axisTitle(s string) excelize.ChartAxis {
	ax := excelize.ChartAxis{}
	if s != "" {
		ax.Title = excelize.ChartTitle{Paragraph: []excelize.RichTextRun{{Text: escapeChartText(s, 120)}}}
	}
	return ax
}

// seriesName resolves the legend label for one series.
//
// IMPORTANT: excelize always emits a series name as `<c:tx><c:strRef><c:f>NAME`,
// i.e. as a FORMULA REFERENCE — never as a literal `<c:v>` (which is what the
// browser writer uses). So handing it the string "Series 1" would produce a
// dangling reference to a non-existent defined name. Every series name must
// therefore BE a cell reference: the range's header cell when it has one, and
// otherwise a label we write into the hidden data sheet ourselves.
func seriesName(s seriesRef, i int, aux *auxSheet) string {
	if s.nameRef != "" {
		return s.nameRef
	}
	ref, err := aux.putLabel(fmt.Sprintf("Series %d", i+1))
	if err != nil {
		return "" // excelize then defaults the legend to Series 1..n
	}
	return ref
}

func fillFor(i int) excelize.Fill {
	return excelize.Fill{Type: "pattern", Pattern: 1, Color: []string{paletteAt(i)}}
}

// buildSeries maps the resolved refs onto excelize series for the cartesian and
// part-to-whole families.
func buildSeries(refs chartRefs, aux *auxSheet) []excelize.ChartSeries {
	out := make([]excelize.ChartSeries, 0, len(refs.series))
	for i, s := range refs.series {
		out = append(out, excelize.ChartSeries{
			Name:       seriesName(s, i, aux),
			Categories: refs.catRef,
			Values:     s.valRef,
			Fill:       fillFor(i),
		})
	}
	return out
}

// ─── the hidden data sheet ──────────────────────────────────────────────────

// auxSheet is the lazily-created hidden worksheet that backs the values which are
// OURS rather than the user's: computed histogram bins, and the legend labels of a
// range that carries no header row. It exists because an OOXML chart written by
// excelize can only point at CELLS — so anything that is not already in a cell has
// to become one. Nothing is created unless a chart actually needs it.
type auxSheet struct {
	f       *excelize.File
	col     int
	created bool
}

func (a *auxSheet) ensure() error {
	if a.created {
		return nil
	}
	idx, err := a.f.GetSheetIndex(chartDataSheet)
	if err != nil {
		return err
	}
	if idx == -1 {
		if _, err := a.f.NewSheet(chartDataSheet); err != nil {
			return err
		}
		// Our bookkeeping, not the user's data.
		_ = a.f.SetSheetVisible(chartDataSheet, false)
	}
	a.created = true
	return nil
}

func (a *auxSheet) set(col, row int, v any) error {
	addr, err := excelize.CoordinatesToCellName(col+1, row+1)
	if err != nil {
		return err
	}
	return a.f.SetCellValue(chartDataSheet, addr, v)
}

// putLabel writes one literal label into its own column and returns its reference.
func (a *auxSheet) putLabel(text string) (string, error) {
	if err := a.ensure(); err != nil {
		return "", err
	}
	col := a.col
	a.col++
	if err := a.set(col, 0, escapeChartText(text, 200)); err != nil {
		return "", err
	}
	return absRef(chartDataSheet, col, 0, col, 0), nil
}

// putBins writes one histogram's bins as two columns (label, count) and returns
// the category / value / series-name references its series points at.
func (a *auxSheet) putBins(header string, bins []histBin) (catRef, valRef, nameRef string, err error) {
	if err = a.ensure(); err != nil {
		return "", "", "", err
	}
	labelCol := a.col
	valueCol := labelCol + 1
	a.col += 2

	if err = a.set(labelCol, 0, header+" (bin)"); err != nil {
		return "", "", "", err
	}
	if err = a.set(valueCol, 0, header+" (count)"); err != nil {
		return "", "", "", err
	}
	for i, b := range bins {
		if err = a.set(labelCol, i+1, b.label); err != nil {
			return "", "", "", err
		}
		if err = a.set(valueCol, i+1, b.count); err != nil {
			return "", "", "", err
		}
	}
	catRef = absRef(chartDataSheet, labelCol, 1, labelCol, len(bins))
	valRef = absRef(chartDataSheet, valueCol, 1, valueCol, len(bins))
	// The series' legend label IS the count column's header cell.
	nameRef = absRef(chartDataSheet, valueCol, 0, valueCol, 0)
	if catRef == "" || valRef == "" || nameRef == "" {
		return "", "", "", fmt.Errorf("bad histogram refs")
	}
	return catRef, valRef, nameRef, nil
}

// addCharts writes every chart of `sheet` into the workbook as a real chart part,
// and records in `rep` anything it could not carry.
func addCharts(f *excelize.File, sheetName string, sheet Sheet, idx cellIndex, rep *Report, aux *auxSheet) error {
	for _, ch := range sheet.Charts {
		typ, note, ok := nativeSupport(ch.Type)
		if !ok {
			rep.skip(ch, note)
			continue
		}
		refs, ok := resolveRefs(ch, sheetName)
		if !ok {
			rep.skip(ch, "its data range could not be resolved")
			continue
		}

		primary := &excelize.Chart{
			Type:      typ,
			Dimension: chartDimension(ch),
			Title:     richTitle(ch.Title),
			XAxis:     axisTitle(ch.Options.XAxisLabel),
			YAxis:     axisTitle(ch.Options.YAxisLabel),
			Legend:    excelize.ChartLegend{Position: "bottom"},
		}
		if !ch.Options.legend() {
			primary.Legend = excelize.ChartLegend{Position: "none"}
		}
		primary.YAxis.MajorGridLines = true

		var combo []*excelize.Chart

		switch ch.Type {
		case "pie", "donut":
			s := refs.series[0]
			primary.Series = []excelize.ChartSeries{{
				Name:       seriesName(s, 0, aux),
				Categories: refs.catRef,
				Values:     s.valRef,
			}}
			varyColors := true
			primary.VaryColors = &varyColors
			if ch.Type == "donut" {
				primary.HoleSize = 55
			}

		case "scatter", "bubble":
			// X/Y (+ size) — the series columns ARE the axes, so a scatter needs at
			// least two data columns and a bubble three. We do not invent a missing
			// one; the chart is skipped and reported.
			if len(refs.series) < 2 {
				rep.skip(ch, "a scatter chart needs an X column and a Y column in its range")
				continue
			}
			if ch.Type == "bubble" && len(refs.series) < 3 {
				rep.skip(ch, "a bubble chart needs X, Y and size columns in its range")
				continue
			}
			sx, sy := refs.series[0], refs.series[1]
			ser := excelize.ChartSeries{
				Name:       seriesName(sy, 1, aux),
				Categories: sx.valRef, // excelize maps Categories → c:xVal for X/Y charts
				Values:     sy.valRef,
				Fill:       fillFor(0),
			}
			if ch.Type == "bubble" {
				ser.Sizes = refs.series[2].valRef
			}
			primary.Series = []excelize.ChartSeries{ser}

		case "histogram":
			vals := histogramNumbers(refs, idx)
			bins := histogramBins(vals, ch.Options.Bins)
			if len(bins) == 0 {
				rep.skip(ch, "it has no numeric values to bin")
				continue
			}
			header := escapeChartText(ch.Title, 60)
			if header == "" {
				header = "Frequency"
			}
			catRef, valRef, nameRef, err := aux.putBins(header, bins)
			if err != nil {
				rep.skip(ch, "its bins could not be written")
				continue
			}
			primary.Series = []excelize.ChartSeries{{
				Name:       nameRef,
				Categories: catRef,
				Values:     valRef,
				Fill:       fillFor(0),
			}}
			gap := uint(0)
			primary.GapWidth = &gap
			if len(primary.YAxis.Title.Paragraph) == 0 {
				primary.YAxis = axisTitle("Frequency")
				primary.YAxis.MajorGridLines = true
			}

		case "combo":
			// series[0] as columns; series[1..] as lines, optionally on a secondary
			// (right-hand) value axis.
			primary.Series = []excelize.ChartSeries{{
				Name:       seriesName(refs.series[0], 0, aux),
				Categories: refs.catRef,
				Values:     refs.series[0].valRef,
				Fill:       fillFor(0),
			}}
			if len(refs.series) > 1 {
				lineSeries := make([]excelize.ChartSeries, 0, len(refs.series)-1)
				for i, s := range refs.series[1:] {
					lineSeries = append(lineSeries, excelize.ChartSeries{
						Name:       seriesName(s, i+1, aux),
						Categories: refs.catRef,
						Values:     s.valRef,
						Line:       excelize.LineOptions{Width: 2.25},
					})
				}
				lineChart := &excelize.Chart{
					Type:      excelize.Line,
					Dimension: chartDimension(ch),
					Series:    lineSeries,
					XAxis:     axisTitle(ch.Options.XAxisLabel),
					YAxis:     axisTitle(ch.Options.YAxisLabel),
					Legend:    primary.Legend,
				}
				if ch.Options.SecondaryAxis {
					lineChart.YAxis = axisTitle(ch.Options.Y2AxisLabel)
					lineChart.YAxis.Secondary = true
				}
				combo = append(combo, lineChart)
			}

		default: // column / bar family, incl. stacked + 100% stacked
			primary.Series = buildSeries(refs, aux)
		}

		if err := f.AddChart(sheetName, anchorCell(ch), primary, combo...); err != nil {
			rep.skip(ch, "Excel rejected the chart definition")
			continue
		}
		rep.ChartsEmbedded++
		if note != "" {
			rep.warn("Chart %q: %s", chartLabel(ch), note)
		}
	}
	return nil
}

func chartLabel(ch Chart) string {
	if t := escapeChartText(ch.Title, 60); t != "" {
		return t
	}
	return ch.Type
}

func (r *Report) skip(ch Chart, reason string) {
	r.ChartsSkipped = append(r.ChartsSkipped, SkippedChart{
		ID:     ch.ID,
		Type:   ch.Type,
		Title:  escapeChartText(ch.Title, 60),
		Reason: reason,
	})
	r.warn("Chart %q was NOT embedded in the .xlsx (%s); its definition is preserved in the hidden %q sheet, so re-importing this file into Vulos restores it.",
		chartLabel(ch), reason, chartMetaSheet)
}

// histogramNumbers collects the genuinely-numeric cells of the histogram's first
// data column. A BLANK is not a zero (charts.js makes the same point): counting
// empties as 0 would invent a spike at zero for every empty row in the range.
func histogramNumbers(refs chartRefs, idx cellIndex) []float64 {
	if len(refs.series) == 0 {
		return nil
	}
	col := refs.series[0].col
	var out []float64
	for r := refs.dataR0; r <= refs.r1; r++ {
		if dc, ok := idx[[2]int{r, col}]; ok && dc.isNum {
			out = append(out, dc.numVal)
		}
	}
	return out
}

// ─── The metadata carrier ───────────────────────────────────────────────────

// writeChartMetaSheet writes the chart DEFINITIONS as a hidden worksheet, in the
// exact schema src/apps/sheets/sheetsImport.js parses back. Excel's chart XML
// cannot express everything our descriptor holds (our type names, the histogram's
// bin count, the chart's pixel position over the grid), and no reader can read our
// chart parts back into descriptors — so this sheet is what makes the round trip
// LOSSLESS, including for the charts we had to skip.
//
// SECURITY: title / range / axis labels can originate from cell data (or a hostile
// CRDT peer), and these land in real cells — so every free-text field goes through
// escapeChartText. Otherwise a title like `=HYPERLINK("http://evil")` would be
// written as a LIVE FORMULA and evaluate when the workbook is opened.
func writeChartMetaSheet(f *excelize.File, charts []Chart) error {
	if len(charts) == 0 {
		return nil
	}
	if _, err := f.NewSheet(chartMetaSheet); err != nil {
		return err
	}
	set := func(col, row int, v any) error {
		addr, err := excelize.CoordinatesToCellName(col+1, row+1)
		if err != nil {
			return err
		}
		return f.SetCellValue(chartMetaSheet, addr, v)
	}
	for c, name := range chartMetaColumns {
		if err := set(c, 0, name); err != nil {
			return err
		}
	}
	for i, ch := range charts {
		bins := ch.Options.Bins
		if bins < histBinsMin || bins > histBinsMax {
			bins = histBinsDefault
		}
		row := []any{
			ch.Type,
			escapeChartText(ch.Range, 200),
			escapeChartText(ch.Title, 200),
			escapeChartText(ch.Options.XAxisLabel, 120),
			escapeChartText(ch.Options.YAxisLabel, 120),
			yesNo(ch.Options.legend()),
			yesNo(ch.Options.headerRow()),
			yesNo(ch.Options.headerCol()),
			escapeChartText(ch.Options.Y2AxisLabel, 120),
			yesNo(ch.Options.SecondaryAxis),
			bins,
			ch.X, ch.Y, ch.W, ch.H,
			escapeChartText(ch.ID, 64),
		}
		for c, v := range row {
			if err := set(c, i+1, v); err != nil {
				return err
			}
		}
	}
	// Our bookkeeping, not the user's data.
	return f.SetSheetVisible(chartMetaSheet, false)
}

// readChartMetaSheet parses the "Vulos Charts" sheet back into descriptors, so an
// xlsx this exporter wrote round-trips through the SERVER importer too (the sheet
// would otherwise reappear as a junk grid of rows). Mirrors chartsFromMetaSheet:
// a sheet whose header is not ours is ignored entirely, and the file is untrusted
// input — every field is coerced and clamped.
func readChartMetaSheet(f *excelize.File) []Chart {
	rows, err := f.GetRows(chartMetaSheet)
	if err != nil || len(rows) < 2 {
		return nil
	}
	header := rows[0]
	if len(header) < 2 || header[0] != "type" || header[1] != "range" {
		return nil // not our schema
	}
	colOf := map[string]int{}
	for i, h := range header {
		colOf[h] = i
	}
	get := func(row []string, name string) string {
		i, ok := colOf[name]
		if !ok || i >= len(row) {
			return ""
		}
		return row[i]
	}
	yes := func(v string, dflt bool) *bool {
		s := strings.ToLower(strings.TrimSpace(v))
		if s == "" {
			b := dflt
			return &b
		}
		b := s == "yes" || s == "true" || s == "1"
		return &b
	}
	num := func(v string) float64 {
		n, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
		if err != nil || math.IsNaN(n) || math.IsInf(n, 0) {
			return 0
		}
		return n
	}

	const maxMetaCharts = 200
	var out []Chart
	for _, row := range rows[1:] {
		if len(out) >= maxMetaCharts {
			break
		}
		typ := strings.TrimSpace(get(row, "type"))
		if typ == "" {
			continue
		}
		bins := int(num(get(row, "bins")))
		if bins < histBinsMin || bins > histBinsMax {
			bins = histBinsDefault
		}
		out = append(out, Chart{
			ID:    get(row, "id"),
			Type:  typ,
			Range: get(row, "range"),
			Title: get(row, "title"),
			X:     num(get(row, "x")),
			Y:     num(get(row, "y")),
			W:     num(get(row, "w")),
			H:     num(get(row, "h")),
			Options: ChartOptions{
				XAxisLabel:    get(row, "xAxisLabel"),
				YAxisLabel:    get(row, "yAxisLabel"),
				Y2AxisLabel:   get(row, "y2AxisLabel"),
				Legend:        yes(get(row, "legend"), true),
				HeaderRow:     yes(get(row, "headerRow"), true),
				HeaderCol:     yes(get(row, "headerCol"), true),
				SecondaryAxis: *yes(get(row, "secondaryAxis"), false),
				Bins:          bins,
			},
		})
	}
	return out
}

// ─── cell index (used by the histogram binner) ──────────────────────────────

type cellIndex map[[2]int]decodedCell

func indexCells(sheet Sheet) cellIndex {
	idx := make(cellIndex, len(sheet.CellData))
	for _, cd := range sheet.CellData {
		if cd.V == nil {
			continue
		}
		dc, err := decodeCell(cd.V)
		if err != nil {
			continue
		}
		idx[[2]int{cd.R, cd.C}] = dc
	}
	return idx
}

// pivotWarning reports the live pivot tables an export cannot carry. Excel has no
// equivalent of our live pivot descriptor, and (as the browser export dialog says)
// the user must materialise it with "Insert as static sheet" first. Saying so is
// the difference between a documented limit and silent data loss.
func pivotWarning(wb Workbook, rep *Report) {
	n := 0
	for _, s := range wb {
		n += len(s.Pivots)
	}
	if n == 0 {
		return
	}
	plural, verb := "s", "are"
	if n == 1 {
		plural, verb = "", "is"
	}
	rep.warn("%d live pivot table%s %s not exported. Use “Insert as static sheet” in the pivot panel to write the result into real cells first.", n, plural, verb)
}
