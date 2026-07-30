package main

// docs_mirror_test.go — site/docs/ is a hand-maintained, lowercase-named MIRROR
// of docs/ (plus CHANGELOG.md and ROADMAP.md), served by site/docs.html for the
// static marketing bundle. There is no generator: the copies are made by hand,
// which means they drift by hand too — and they had. site/docs/changelog.md was
// 26 lines behind CHANGELOG.md, so the published changelog silently omitted a
// release note.
//
// This test is the generator's replacement: it fails, naming the file and the
// fix, whenever a mirrored pair stops being byte-identical.
//
// Two further guards, because a mirror check is easy to make vacuous:
//   - the expected pair count is asserted, so deleting entries from the table
//     below cannot make this pass by checking less;
//   - every entry in site/docs.html's page list must be covered by the table,
//     so adding a page to the published site without mirroring it fails here
//     rather than shipping a stale or orphaned document.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// docsMirror maps a source file to its site/docs/ copy. Extend it when a
// document is added to the published site — the coverage check below will tell
// you when that is needed.
var docsMirror = map[string]string{
	"docs/ADMIN-GUIDE.md":     "site/docs/admin-guide.md",
	"docs/API.md":             "site/docs/api.md",
	"docs/ARCHITECTURE.md":    "site/docs/architecture.md",
	"docs/COLLABORATION.md":   "site/docs/collaboration.md",
	"docs/CONFIGURATION.md":   "site/docs/configuration.md",
	"docs/DEPLOY.md":          "site/docs/deploy.md",
	"docs/GETTING-STARTED.md": "site/docs/getting-started.md",
	"docs/INSTALL.md":         "site/docs/install.md",
	"docs/SCREENSHOTS.md":     "site/docs/screenshots.md",
	"docs/SELFHOST.md":        "site/docs/self-hosting.md",
	"docs/THREAT-MODEL.md":    "site/docs/threat-model.md",
	"docs/TROUBLESHOOTING.md": "site/docs/troubleshooting.md",
	"docs/USER-GUIDE.md":      "site/docs/user-guide.md",
	"CHANGELOG.md":            "site/docs/changelog.md",
	"ROADMAP.md":              "site/docs/roadmap.md",
}

func TestSiteDocsMirrorIsInSync(t *testing.T) {
	if len(docsMirror) != 15 {
		t.Fatalf("docsMirror should cover 15 pairs, got %d — if the published site "+
			"gained or lost a page, update this count deliberately", len(docsMirror))
	}

	checked := 0
	for src, dst := range docsMirror {
		srcBytes, err := os.ReadFile(src)
		if err != nil {
			t.Errorf("%s: %v", src, err)
			continue
		}
		dstBytes, err := os.ReadFile(dst)
		if err != nil {
			t.Errorf("%s (mirror of %s): %v — create it with `cp %s %s`", dst, src, err, src, dst)
			continue
		}
		if string(srcBytes) != string(dstBytes) {
			t.Errorf("%s and %s have drifted (%d vs %d bytes). The site copy is a mirror, "+
				"not a fork: re-sync with `cp %s %s`.", src, dst, len(srcBytes), len(dstBytes), src, dst)
		}
		checked++
	}
	// A loop over an empty map would "pass". Assert it did the work.
	if checked != len(docsMirror) {
		t.Fatalf("only %d of %d mirrored pairs were compared", checked, len(docsMirror))
	}

	// No orphans: the checks above only ever look at the pairs docsMirror names,
	// so a file dropped directly into site/docs/ — never added to this table —
	// was invisible to both this test and TestSiteDocsPageListIsMirrored (which
	// only cross-checks site/docs.html's page list, not the directory on disk).
	// Walk the mirror directory itself and flag anything it does not know about.
	known := map[string]bool{}
	for _, dst := range docsMirror {
		known[filepath.Base(dst)] = true
	}
	entries, err := os.ReadDir("site/docs")
	if err != nil {
		t.Fatalf("read site/docs: %v — the orphan check verified NOTHING", err)
	}
	md := 0
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		md++
		if !known[e.Name()] {
			t.Errorf("site/docs/%s is not named by docsMirror — it is either a stale leftover "+
				"or a page nobody is tracking for drift; add it to docsMirror or delete it", e.Name())
		}
	}
	if md < len(docsMirror) {
		t.Fatalf("only %d markdown files found in site/docs (expected at least %d) — the orphan "+
			"scan verified almost nothing", md, len(docsMirror))
	}
}

// TestSiteDocsPageListIsMirrored proves the table above covers everything
// site/docs.html actually publishes, so a page cannot be added to the site and
// then quietly diverge from its docs/ source.
func TestSiteDocsPageListIsMirrored(t *testing.T) {
	page, err := os.ReadFile("site/docs.html")
	if err != nil {
		t.Fatalf("read site/docs.html: %v", err)
	}

	mirrored := map[string]bool{}
	for _, dst := range docsMirror {
		mirrored[filepath.Base(dst)] = true
	}

	// The page list is a JS array of {"slug":…,"path":"./docs/<file>.md"} entries.
	const marker = `"path":"./docs/`
	rest := string(page)
	found := 0
	for {
		i := strings.Index(rest, marker)
		if i < 0 {
			break
		}
		rest = rest[i+len(marker):]
		end := strings.IndexByte(rest, '"')
		if end < 0 {
			t.Fatal("malformed page entry in site/docs.html: unterminated path")
		}
		name := rest[:end]
		found++
		if !mirrored[name] {
			t.Errorf("site/docs.html publishes docs/%s, but docsMirror does not cover it — "+
				"add its docs/ source to the table so it cannot drift", name)
		}
	}
	if found == 0 {
		t.Fatal("found no published page entries in site/docs.html — the parser or the page format changed")
	}
	if found != len(docsMirror) {
		t.Errorf("site/docs.html publishes %d pages but docsMirror covers %d — "+
			"a mirrored file is not published, or a published file is not mirrored", found, len(docsMirror))
	}
}
