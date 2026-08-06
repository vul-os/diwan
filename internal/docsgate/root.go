// Package docsgate holds the repo-hygiene gates for diwan's documentation:
// that every relative Markdown link resolves, and that site/docs/ stays a
// byte-identical mirror of docs/ (plus CHANGELOG.md and ROADMAP.md). Neither
// test exercises the diwan binary itself, so they live in their own package
// rather than in package main.
package docsgate

import (
	"os"
	"path/filepath"
	"runtime"
)

// repoRoot locates the diwan module root by walking up from this source
// file's own directory until a go.mod is found. It resolves from the module
// root rather than a relative "../.." so these paths stay correct regardless
// of where this package lives in the tree or what directory `go test` is
// invoked from.
func repoRoot() string {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		panic("docsgate: runtime.Caller failed to report this file's path")
	}
	dir := filepath.Dir(file)
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			panic("docsgate: no go.mod found above " + file)
		}
		dir = parent
	}
}

// repoPath joins path elements onto the module root.
func repoPath(elem ...string) string {
	return filepath.Join(append([]string{repoRoot()}, elem...)...)
}
