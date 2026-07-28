package main

// docs_links_test.go — every relative link in the repo's Markdown must resolve
// to a file that exists.
//
// This catches the class of rot that a reader hits and a build never does:
// README.md linked SELFHOST.md, THREAT-MODEL.md and SECURITY-TESTING.md at the
// repo root, where none of them live (they are under docs/), so three links on
// the project's front page 404'd.
//
// Scope is deliberately the SOURCE tree — README.md, SECURITY.md,
// CONTRIBUTING.md, docs/, and third_party/*/VENDOR.md. site/docs/ is excluded:
// it is a byte-identical mirror rendered by site/docs.html, which rewrites
// cross-document links to in-page slugs (and unpublished ones to the repo), so
// its links are correct in the context that renders them and wrong only when
// resolved as file paths.

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// mdLink matches an inline Markdown link/image target: [text](target).
var mdLink = regexp.MustCompile(`!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)`)

// markdownSources returns every Markdown file whose relative links must resolve
// on disk.
func markdownSources(t *testing.T) []string {
	t.Helper()
	var out []string
	for _, f := range []string{"README.md", "SECURITY.md", "CONTRIBUTING.md", "CHANGELOG.md", "ROADMAP.md"} {
		if _, err := os.Stat(f); err == nil {
			out = append(out, f)
		}
	}
	for _, dir := range []string{"docs", "third_party"} {
		err := filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if !d.IsDir() && strings.HasSuffix(path, ".md") {
				out = append(out, path)
			}
			return nil
		})
		if err != nil && !os.IsNotExist(err) {
			t.Fatalf("walk %s: %v", dir, err)
		}
	}
	return out
}

func TestMarkdownRelativeLinksResolve(t *testing.T) {
	files := markdownSources(t)
	// A walk that found nothing would pass silently. It must not.
	if len(files) < 15 {
		t.Fatalf("expected at least 15 Markdown sources to check, found %d — the walk is not "+
			"reaching docs/, so this test is verifying almost nothing", len(files))
	}

	checkedLinks := 0
	for _, f := range files {
		body, err := os.ReadFile(f)
		if err != nil {
			t.Errorf("read %s: %v", f, err)
			continue
		}
		base := filepath.Dir(f)
		for _, m := range mdLink.FindAllStringSubmatch(string(body), -1) {
			target := m[1]
			switch {
			case strings.HasPrefix(target, "http://"), strings.HasPrefix(target, "https://"),
				strings.HasPrefix(target, "mailto:"), strings.HasPrefix(target, "#"),
				strings.HasPrefix(target, "data:"):
				continue
			}
			path := target
			if i := strings.IndexByte(path, '#'); i >= 0 {
				path = path[:i]
			}
			if path == "" {
				continue // pure in-page anchor
			}
			checkedLinks++
			resolved := filepath.Clean(filepath.Join(base, path))
			if _, err := os.Stat(resolved); err != nil {
				t.Errorf("%s links to %q, which resolves to %q and does not exist",
					f, target, resolved)
			}
		}
	}
	// Guard against a regex change that silently matches nothing.
	if checkedLinks < 50 {
		t.Fatalf("only %d relative links were checked across %d files — the link regex is "+
			"matching almost nothing, so this test would not catch a broken link", checkedLinks, len(files))
	}
	t.Logf("checked %d relative links across %d Markdown files", checkedLinks, len(files))
}
