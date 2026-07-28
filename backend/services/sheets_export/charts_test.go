package sheets_export_test

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"strings"
	"testing"

	"diwan/backend/services/sheets_export"
)

// These tests assert on the REAL EXPORTED BYTES: they unzip the .xlsx and read the
// OOXML parts. A test that only checked an intermediate struct would have passed
// for the entire lifetime of the bug it is here to prevent — the server exporter
// happily produced a well-formed workbook with every chart missing.

// ─── helpers ────────────────────────────────────────────────────────────────

// xlsxParts unzips an exported workbook into part-name → bytes.
func xlsxParts(t *testing.T, b []byte) map[string]string {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(b), int64(len(b)))
	if err != nil {
		t.Fatalf("exported bytes are not a valid ZIP: %v", err)
	}
	out := map[string]string{}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatalf("open %s: %v", f.Name, err)
		}
		data, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			t.Fatalf("read %s: %v", f.Name, err)
		}
		out[f.Name] = string(data)
	}
	return out
}

// exportWB exports a workbook and returns its parts + the fidelity report.
func exportWB(t *testing.T, wb any) (map[string]string, *sheets_export.Report) {
	t.Helper()
	var buf bytes.Buffer
	rep, err := sheets_export.ExportXLSX(mustMarshal(wb), &buf)
	if err != nil {
		t.Fatalf("ExportXLSX: %v", err)
	}
	if rep == nil {
		t.Fatal("ExportXLSX returned a nil report — the caller could never learn what was lost")
	}
	return xlsxParts(t, buf.Bytes()), rep
}

// salesSheet is a 4-column, 8-row table: labels in A, three numeric series B/C/D.
func salesSheet(charts []map[string]any) []map[string]any {
	cells := []map[string]any{
		{"r": 0, "c": 0, "v": map[string]any{"v": "Month", "m": "Month"}},
		{"r": 0, "c": 1, "v": map[string]any{"v": "Revenue", "m": "Revenue"}},
		{"r": 0, "c": 2, "v": map[string]any{"v": "Cost", "m": "Cost"}},
		{"r": 0, "c": 3, "v": map[string]any{"v": "Units", "m": "Units"}},
	}
	labels := []string{"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul"}
	for i, lbl := range labels {
		r := i + 1
		cells = append(cells,
			map[string]any{"r": r, "c": 0, "v": map[string]any{"v": lbl, "m": lbl}},
			map[string]any{"r": r, "c": 1, "v": map[string]any{"v": float64(100 + i*10), "m": "x"}},
			map[string]any{"r": r, "c": 2, "v": map[string]any{"v": float64(50 + i*3), "m": "x"}},
			map[string]any{"r": r, "c": 3, "v": map[string]any{"v": float64(5 + i), "m": "x"}},
		)
	}
	sheet := map[string]any{"name": "Sheet1", "celldata": cells, "config": map[string]any{}}
	if charts != nil {
		sheet["charts"] = charts
	}
	return []map[string]any{sheet}
}

func chart(id, typ, rng string, extra map[string]any) map[string]any {
	c := map[string]any{
		"id": id, "type": typ, "range": rng,
		"x": 320.0, "y": 40.0, "w": 480.0, "h": 300.0,
	}
	for k, v := range extra {
		c[k] = v
	}
	return c
}

// ─── 1. THE BUG: a chart must reach the exported bytes ──────────────────────

func TestExportXLSX_EmbedsRealChartPart(t *testing.T) {
	parts, rep := exportWB(t, salesSheet([]map[string]any{
		chart("c1", "column", "A1:D8", map[string]any{"title": "Sales"}),
	}))

	xml, ok := parts["xl/charts/chart1.xml"]
	if !ok {
		t.Fatalf("xl/charts/chart1.xml is MISSING — the chart was dropped from the export.\nparts: %v", partNames(parts))
	}
	if !strings.Contains(xml, "<barChart>") {
		t.Errorf("chart1.xml is not a bar/column chart:\n%s", head(xml))
	}
	// The series must point at REAL CELLS, so Excel recalculates the chart rather
	// than showing baked-in numbers. (excelize entity-escapes the quotes in a
	// reference, so compare against the decoded form.)
	refs := unescapeXML(xml)
	for _, want := range []string{"'Sheet1'!$B$2:$B$8", "'Sheet1'!$C$2:$C$8", "'Sheet1'!$A$2:$A$8"} {
		if !strings.Contains(refs, want) {
			t.Errorf("chart1.xml is missing the cell reference %q (series are not linked to the sheet)", want)
		}
	}
	if !strings.Contains(xml, "Sales") {
		t.Errorf("chart title 'Sales' is not in chart1.xml")
	}

	// A chart part alone is invisible: it must be anchored by a drawing, related
	// from the worksheet, and declared in [Content_Types].
	if _, ok := parts["xl/drawings/drawing1.xml"]; !ok {
		t.Errorf("xl/drawings/drawing1.xml is missing — the chart is not anchored on any sheet")
	}
	if !strings.Contains(parts["xl/worksheets/sheet1.xml"], "<drawing") {
		t.Errorf("worksheet does not reference the drawing — Excel would show no chart")
	}
	if !strings.Contains(parts["[Content_Types].xml"], "drawingml.chart+xml") {
		t.Errorf("[Content_Types].xml does not declare the chart part")
	}

	if rep.ChartsEmbedded != 1 {
		t.Errorf("report says %d charts embedded, want 1", rep.ChartsEmbedded)
	}
	if len(rep.Warnings) != 0 {
		t.Errorf("a fully-carried export must not warn; got %v", rep.Warnings)
	}
}

// ─── 2. Every supported type reaches the bytes with the right plot ──────────

func TestExportXLSX_EveryChartTypeEmbeds(t *testing.T) {
	cases := []struct {
		typ     string
		rng     string
		wantTag string
		extra   map[string]any
	}{
		{"column", "A1:C8", "<barChart>", nil},
		{"bar", "A1:C8", "<barChart>", nil},
		{"column-stacked", "A1:C8", "<barChart>", nil},
		{"bar-stacked", "A1:C8", "<barChart>", nil},
		{"column-100", "A1:C8", "<barChart>", nil},
		{"bar-100", "A1:C8", "<barChart>", nil},
		{"line", "A1:C8", "<lineChart>", nil},
		{"area", "A1:C8", "<areaChart>", nil},
		{"pie", "A1:B8", "<pieChart>", nil},
		{"donut", "A1:B8", "<doughnutChart>", nil},
		{"scatter", "A1:C8", "<scatterChart>", nil},
		{"bubble", "A1:D8", "<bubbleChart>", nil},
		{"histogram", "A1:B8", "<barChart>", nil},
		{"combo", "A1:D8", "<lineChart>", nil}, // bars + lines
	}
	for _, tc := range cases {
		t.Run(tc.typ, func(t *testing.T) {
			parts, rep := exportWB(t, salesSheet([]map[string]any{
				chart("c1", tc.typ, tc.rng, tc.extra),
			}))
			xml, ok := parts["xl/charts/chart1.xml"]
			if !ok {
				t.Fatalf("%s: no chart part in the exported file (skipped: %+v)", tc.typ, rep.ChartsSkipped)
			}
			if !strings.Contains(xml, tc.wantTag) {
				t.Errorf("%s: chart1.xml does not contain %s:\n%s", tc.typ, tc.wantTag, head(xml))
			}
			if rep.ChartsEmbedded != 1 {
				t.Errorf("%s: report says %d embedded, want 1 (skipped: %+v)", tc.typ, rep.ChartsEmbedded, rep.ChartsSkipped)
			}
		})
	}
}

// A combo chart must carry BOTH plots (columns + lines) in one chart part, and a
// secondary axis when asked — the whole point of the type.
func TestExportXLSX_ComboCarriesBothPlotsAndSecondaryAxis(t *testing.T) {
	parts, _ := exportWB(t, salesSheet([]map[string]any{
		chart("c1", "combo", "A1:D8", map[string]any{
			"title":   "Revenue vs margin",
			"options": map[string]any{"secondaryAxis": true, "y2AxisLabel": "Margin"},
		}),
	}))
	xml := parts["xl/charts/chart1.xml"]
	if !strings.Contains(xml, "<barChart>") || !strings.Contains(xml, "<lineChart>") {
		t.Fatalf("combo chart lost a plot — want both barChart and lineChart:\n%s", head(xml))
	}
	// A secondary axis is a SECOND value axis in the part.
	if n := strings.Count(xml, "<valAx>"); n < 2 {
		t.Errorf("secondaryAxis=true produced %d value axes, want >= 2", n)
	}
}

// ─── 3. Histogram: our bins, written to real cells ──────────────────────────

func TestExportXLSX_HistogramBinsRideAsCellsAndWarn(t *testing.T) {
	parts, rep := exportWB(t, salesSheet([]map[string]any{
		chart("h1", "histogram", "A1:B8", map[string]any{
			"title":   "Revenue spread",
			"options": map[string]any{"bins": 4},
		}),
	}))

	xml, ok := parts["xl/charts/chart1.xml"]
	if !ok {
		t.Fatal("histogram produced no chart part")
	}
	// Bins are OUR computation, so they live in the hidden data sheet and the
	// series points AT THOSE CELLS (a real, live chart — not a picture).
	// bins:4 ⇒ exactly 4 label rows + 4 count rows under the header (row 1).
	refs := unescapeXML(xml)
	for _, want := range []string{
		"'Vulos Chart Data'!$A$2:$A$5", // bin labels
		"'Vulos Chart Data'!$B$2:$B$5", // bin counts
	} {
		if !strings.Contains(refs, want) {
			t.Errorf("histogram series does not reference the bin cells %q:\n%s", want, head(refs))
		}
	}
	// The bin cells must really BE in the workbook (excelize keeps cell strings in
	// the shared-strings table, so look across the package).
	if !anyPartContains(parts, "Revenue spread (count)") {
		t.Error("the computed histogram bins were not written into the workbook")
	}
	// …on a sheet that is HIDDEN: it is our bookkeeping, not the user's data.
	if !strings.Contains(parts["xl/workbook.xml"], "Vulos Chart Data") {
		t.Error("the hidden bin sheet is not declared in the workbook")
	}
	if !strings.Contains(parts["xl/workbook.xml"], `state="hidden"`) {
		t.Errorf("the bin sheet is visible — bookkeeping leaked into the user's tabs:\n%s", head(parts["xl/workbook.xml"]))
	}
	if rep.ChartsEmbedded != 1 {
		t.Fatalf("histogram not embedded: %+v", rep.ChartsSkipped)
	}
	// HONESTY: a histogram cannot re-bin in Excel, and the caller is told so.
	if !hasWarning(rep, "re-bin") {
		t.Errorf("histogram embedded with no caveat reported; warnings=%v", rep.Warnings)
	}
}

// ─── 4. A chart that CANNOT be carried is reported, never dropped silently ──

func TestExportXLSX_UnsupportedChartTypeWarnsAndIsCarriedByMetaSheet(t *testing.T) {
	parts, rep := exportWB(t, salesSheet([]map[string]any{
		chart("c1", "radar-3d-hologram", "A1:C8", map[string]any{"title": "Exotic"}),
	}))

	if rep.ChartsEmbedded != 0 {
		t.Errorf("an unsupported type must not claim to be embedded")
	}
	if len(rep.ChartsSkipped) != 1 || rep.ChartsSkipped[0].ID != "c1" {
		t.Fatalf("skipped chart not reported: %+v", rep.ChartsSkipped)
	}
	if !rep.Degraded() || len(rep.Warnings) == 0 {
		t.Fatal("a dropped chart produced NO warning — this is exactly the silent data loss the fix exists to prevent")
	}
	// It still round-trips: the definition rides in the metadata sheet.
	if !anyPartContains(parts, "radar-3d-hologram") {
		t.Error("the skipped chart's definition is nowhere in the file — the data is simply gone")
	}
}

// A chart whose range cannot be resolved is skipped + reported, not emitted as a
// broken part that makes Excel refuse the whole workbook.
func TestExportXLSX_UnresolvableRangeIsReported(t *testing.T) {
	_, rep := exportWB(t, salesSheet([]map[string]any{
		// A single-cell range with header row+col consumes every row/column → no data.
		chart("c1", "column", "A1", map[string]any{"title": "Broken"}),
	}))
	if rep.ChartsEmbedded != 1 && len(rep.ChartsSkipped) == 0 {
		t.Errorf("a degenerate range neither embedded nor reported: %+v", rep)
	}
	// A scatter with only one column cannot exist — it must be reported.
	_, rep2 := exportWB(t, salesSheet([]map[string]any{
		chart("s1", "scatter", "A1:A8", nil),
	}))
	if len(rep2.ChartsSkipped) == 0 || !rep2.Degraded() {
		t.Errorf("a scatter with no Y column was accepted silently: %+v", rep2)
	}
}

// ─── 5. Round-trip: export → import restores the charts ─────────────────────

func TestExportXLSX_ChartsRoundTripThroughTheMetaSheet(t *testing.T) {
	in := salesSheet([]map[string]any{
		chart("c1", "donut", "A1:B8", map[string]any{
			"title":   "Split",
			"options": map[string]any{"legend": false, "bins": 7},
		}),
	})
	var buf bytes.Buffer
	if _, err := sheets_export.ExportXLSX(mustMarshal(in), &buf); err != nil {
		t.Fatalf("ExportXLSX: %v", err)
	}

	out, err := sheets_export.ImportXLSX(bytes.NewReader(buf.Bytes()))
	if err != nil {
		t.Fatalf("ImportXLSX: %v", err)
	}
	var wb []sheets_export.Sheet
	if err := json.Unmarshal(out, &wb); err != nil {
		t.Fatalf("unmarshal imported workbook: %v", err)
	}
	if len(wb) != 1 {
		t.Fatalf("import produced %d sheets, want 1 — our bookkeeping sheets leaked into the user's workbook: %+v", len(wb), sheetNames(wb))
	}
	if len(wb[0].Charts) != 1 {
		t.Fatalf("the chart did not survive the round trip: %+v", wb[0].Charts)
	}
	got := wb[0].Charts[0]
	if got.Type != "donut" || got.Range != "A1:B8" || got.Title != "Split" {
		t.Errorf("chart came back changed: %+v", got)
	}
	if got.Options.Legend == nil || *got.Options.Legend {
		t.Errorf("legend=false did not round-trip: %+v", got.Options.Legend)
	}
	if got.W != 480 || got.H != 300 || got.X != 320 {
		t.Errorf("geometry did not round-trip: x=%v y=%v w=%v h=%v", got.X, got.Y, got.W, got.H)
	}
}

// ─── 6. SECURITY: a hostile chart title must not become a live formula ──────

func TestExportXLSX_ChartTitleCannotBecomeALiveFormula(t *testing.T) {
	parts, _ := exportWB(t, salesSheet([]map[string]any{
		chart("c1", "column", "A1:C8", map[string]any{
			"title": `=HYPERLINK("http://evil.example","click")`,
		}),
	}))
	// The metadata sheet writes the title into a real cell. It must be neutralised
	// with a leading quote, and must never be written as a formula (<f> element).
	for name, body := range parts {
		if !strings.HasPrefix(name, "xl/worksheets/sheet") {
			continue
		}
		if strings.Contains(body, "<f>") && strings.Contains(body, "HYPERLINK") {
			t.Fatalf("%s carries a LIVE =HYPERLINK formula built from a chart title:\n%s", name, head(body))
		}
	}
	if !anyPartContains(parts, "&#39;=HYPERLINK") && !anyPartContains(parts, "'=HYPERLINK") {
		t.Error("the escaped (quote-prefixed) title is not present — expected escapeChartText to neutralise it")
	}
}

// ─── 7. Live pivots are not exportable — and the caller is told ─────────────

func TestExportXLSX_LivePivotsAreReported(t *testing.T) {
	wb := salesSheet(nil)
	wb[0]["pivots"] = []map[string]any{{"id": "p1"}, {"id": "p2"}}
	_, rep := exportWB(t, wb)
	if !hasWarning(rep, "pivot") {
		t.Fatalf("2 live pivots were dropped with no warning: %v", rep.Warnings)
	}
}

// ─── 8. Warnings must be safe to put on an HTTP response header ─────────────

func TestExportXLSX_WarningsAreHeaderSafe(t *testing.T) {
	_, rep := exportWB(t, salesSheet([]map[string]any{
		chart("c1", "spline\r\nX-Injected: yes", "A1:C8", map[string]any{"title": "a\r\nb"}),
	}))
	if len(rep.Warnings) == 0 {
		t.Fatal("expected a warning for an unsupported type")
	}
	for _, w := range rep.Warnings {
		if strings.ContainsAny(w, "\r\n") {
			t.Errorf("warning contains CR/LF — it could split an HTTP response header: %q", w)
		}
	}
}

// ─── helpers ────────────────────────────────────────────────────────────────

func hasWarning(rep *sheets_export.Report, substr string) bool {
	for _, w := range rep.Warnings {
		if strings.Contains(strings.ToLower(w), strings.ToLower(substr)) {
			return true
		}
	}
	return false
}

func anyPartContains(parts map[string]string, substr string) bool {
	for _, body := range parts {
		if strings.Contains(body, substr) {
			return true
		}
	}
	return false
}

func partNames(parts map[string]string) []string {
	out := make([]string, 0, len(parts))
	for n := range parts {
		out = append(out, n)
	}
	return out
}

func sheetNames(wb []sheets_export.Sheet) []string {
	out := make([]string, 0, len(wb))
	for _, s := range wb {
		out = append(out, s.Name)
	}
	return out
}

// unescapeXML decodes the entities excelize writes into a reference so an
// assertion can be spelled the way a human writes a cell reference.
func unescapeXML(s string) string {
	r := strings.NewReplacer("&#39;", "'", "&apos;", "'", "&quot;", `"`, "&amp;", "&")
	return r.Replace(s)
}

func head(s string) string {
	if len(s) > 1200 {
		return s[:1200] + "…"
	}
	return s
}
