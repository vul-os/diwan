package storage_test

import (
	"strings"
	"testing"

	"diwan/backend/storage"
)

// OrgScopedKey is the authoritative object-store key builder every handler that
// writes to the org/seam bucket goes through (see backend/handlers/bucket_store.go).
// Its security contract is that a caller-influenced accountID or name can NEVER
// inject a path separator or a ".." sequence and escape its own account segment —
// otherwise one account could read/overwrite another account's blobs at the
// object-store layer, an IDOR below the file-ACL. These tests pin that contract;
// they had no direct coverage before.

// TestOrgScopedKey_AccountsAreDisjoint: two distinct accounts must land under
// disjoint key prefixes so one can never collide with (or be enumerated into)
// another's namespace.
func TestOrgScopedKey_AccountsAreDisjoint(t *testing.T) {
	t.Setenv(storage.EnvOrgID, "")
	a := storage.OrgScopedKey("alice@vulos.org", "file/doc-1")
	b := storage.OrgScopedKey("bob@vulos.org", "file/doc-1")
	if a == b {
		t.Fatalf("VULN: two accounts produced the SAME key %q — no per-account isolation", a)
	}
	if !strings.HasPrefix(a, "alice@vulos.org/") {
		t.Fatalf("key %q not scoped under the account segment", a)
	}
	if !strings.HasPrefix(b, "bob@vulos.org/") {
		t.Fatalf("key %q not scoped under the account segment", b)
	}
}

// TestOrgScopedKey_AccountIDCannotTraverse: a hostile accountID containing path
// separators or ".." must be neutralised into a single flat segment — it must
// not produce a key that escapes into a sibling account's prefix.
func TestOrgScopedKey_AccountIDCannotTraverse(t *testing.T) {
	t.Setenv(storage.EnvOrgID, "")
	victim := storage.OrgScopedKey("victim", "file/secret")

	for _, evil := range []string{
		"../victim",
		"..%2fvictim",
		"a/../victim",
		"victim/..",
		`..\victim`,
		"/victim",
		"./victim",
	} {
		got := storage.OrgScopedKey(evil, "file/secret")
		if got == victim {
			t.Fatalf("VULN: accountID %q escaped into the victim's key %q", evil, victim)
		}
		// The account segment (everything before the first "/") must contain no
		// unescaped separator or "..": it is a single flattened segment.
		seg := got
		if i := strings.IndexByte(got, '/'); i >= 0 {
			seg = got[:i]
		}
		if strings.Contains(seg, "..") {
			t.Fatalf("accountID %q left a %q traversal token in the account segment %q", evil, "..", seg)
		}
	}
}

// TestOrgScopedKey_NameCannotInjectAccountSegment: the name is a single logical
// segment. A name carrying "/" must be flattened so it cannot forge an extra
// path layer that reads as another account's namespace.
func TestOrgScopedKey_NameCannotInjectAccountSegment(t *testing.T) {
	t.Setenv(storage.EnvOrgID, "")
	got := storage.OrgScopedKey("alice", "../bob/file/secret")
	// The key must still be rooted at alice's segment.
	if !strings.HasPrefix(got, "alice/") {
		t.Fatalf("key %q not rooted at the caller's account segment", got)
	}
	// Exactly one separator (account / name) — the name did not add layers.
	if n := strings.Count(got, "/"); n != 1 {
		t.Fatalf("name injected extra path layers: key=%q has %d separators, want 1", got, n)
	}
	if strings.Contains(got, "..") {
		t.Fatalf("key %q retained a traversal token", got)
	}
}

// TestOrgScopedKey_OrgPrefixLayering: with VULOS_ORG_ID set every key is nested
// under the org segment, and the org id is itself sanitised.
func TestOrgScopedKey_OrgPrefixLayering(t *testing.T) {
	t.Setenv(storage.EnvOrgID, "org-42")
	got := storage.OrgScopedKey("alice", "file/doc-1")
	if !strings.HasPrefix(got, "org-42/alice/") {
		t.Fatalf("key %q not nested under <org>/<account>/", got)
	}

	// A hostile org id cannot traverse either.
	t.Setenv(storage.EnvOrgID, "../root")
	evil := storage.OrgScopedKey("alice", "file/doc-1")
	if strings.HasPrefix(evil, "../") || strings.Contains(evil, "/../") {
		t.Fatalf("VULN: org id traversal survived into key %q", evil)
	}
}

// TestOrgScopedKey_EmptyAccountOmitsSegmentButStillSanitises: an empty account
// (shared org-level object) omits the account layer, but the name is still
// sanitised so it cannot traverse.
func TestOrgScopedKey_EmptyAccountOmitsSegmentButStillSanitises(t *testing.T) {
	t.Setenv(storage.EnvOrgID, "")
	got := storage.OrgScopedKey("", "../../etc/passwd")
	if strings.Contains(got, "..") || strings.HasPrefix(got, "/") {
		t.Fatalf("VULN: empty-account name traversal survived into key %q", got)
	}
}
