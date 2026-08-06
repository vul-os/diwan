package docsgate

// site_version_test.go — the landing page's spine badge (site/index.html)
// must display the same version as web/package.json.
//
// This drifted once already: web/package.json was reset to 0.1.0 for the
// first real release and README's hardcoded version was replaced with a
// self-updating shields.io badge, but site/index.html:534 still read
// v0.3.0 — the exact kind of stale self-reference the README change was
// meant to remove, just relocated to the landing page instead of fixed.
//
// Chosen idiom: this is a static repo-hygiene comparison between two
// checked-in files (extract a string from HTML, extract a field from JSON,
// compare), the same shape as TestSiteDocsMirrorIsInSync above — not a
// runtime test-execution audit like web/scripts/assert-p2p-suite-ran.mjs
// (which reads a Playwright JSON *report*, not repo source) — so it belongs
// here as a Go test using repoPath(), not as a third gate mechanism.
//
// Moved-out-of-package-main rationale from docs_links_test.go applies
// equally: this checks repo-hygiene of the published site, not the diwan
// binary, and resolves all paths from the module root via repoRoot() so it
// runs the same regardless of the working directory `go test` is invoked
// from.
//
// The regex below MUST fail loudly (not silently pass by finding nothing)
// if the badge markup is ever restyled so the version string is no longer
// where this test expects it — so the match count is asserted to be
// exactly 1, both zero and more-than-one are treated as failures, and the
// error messages says so explicitly.

import (
	"encoding/json"
	"os"
	"regexp"
	"testing"
)

// siteVersionBadgeRe matches the landing page's spine badge, e.g.
// `<div class="eyebrow v">v0.1.0</div>`, capturing the version number
// without its leading "v". It is deliberately anchored to the badge's
// specific class and tag, not a bare "v\d+\.\d+\.\d+" scan of the whole
// file, so a coincidental version-looking string elsewhere in the page
// cannot be mistaken for the spine badge.
var siteVersionBadgeRe = regexp.MustCompile(`<div class="eyebrow v">v(\d+\.\d+\.\d+)</div>`)

func TestSiteLandingVersionMatchesPackageJSON(t *testing.T) {
	sitePath := repoPath("site", "index.html")
	siteBytes, err := os.ReadFile(sitePath)
	if err != nil {
		t.Fatalf("read %s: %v", sitePath, err)
	}

	matches := siteVersionBadgeRe.FindAllSubmatch(siteBytes, -1)
	if len(matches) == 0 {
		t.Fatalf(
			"found NO version badge in %s matching %s — either the badge was "+
				"deleted or its markup/class was changed and this test's regex "+
				"no longer sees it. That is a silent-pass risk, not a pass: fix "+
				"the regex to match the new markup, do not let this report success "+
				"having checked nothing.",
			sitePath, siteVersionBadgeRe.String(),
		)
	}
	if len(matches) != 1 {
		t.Fatalf(
			"found %d version badges in %s matching %s, expected exactly 1 — "+
				"an ambiguous match is not a verified match",
			len(matches), sitePath, siteVersionBadgeRe.String(),
		)
	}
	siteVersion := string(matches[0][1])

	pkgPath := repoPath("web", "package.json")
	pkgBytes, err := os.ReadFile(pkgPath)
	if err != nil {
		t.Fatalf("read %s: %v", pkgPath, err)
	}
	var pkg struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(pkgBytes, &pkg); err != nil {
		t.Fatalf("parse %s: %v", pkgPath, err)
	}
	if pkg.Version == "" {
		t.Fatalf("%s has no non-empty \"version\" field — nothing to compare against", pkgPath)
	}

	if siteVersion != pkg.Version {
		t.Fatalf(
			"version drift: %s spine badge says v%s, but %s says %s — "+
				"update the spine badge to match the release version",
			sitePath, siteVersion, pkgPath, pkg.Version,
		)
	}

	t.Logf("OK: %s badge (v%s) matches %s version (%s)", sitePath, siteVersion, pkgPath, pkg.Version)
}
