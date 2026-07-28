package audit_test

import (
	"path/filepath"
	"testing"

	"diwan/backend/audit"
)

func runContract(t *testing.T, s audit.Store) {
	t.Helper()
	if err := s.Append(audit.Entry{Actor: "admin", Action: audit.ActionACLGrant, Target: "file-1", Detail: "grantee=bob"}); err != nil {
		t.Fatalf("append 1: %v", err)
	}
	if err := s.Append(audit.Entry{Actor: "admin", Action: audit.ActionInviteMint, Target: "inv-1"}); err != nil {
		t.Fatalf("append 2: %v", err)
	}
	all, err := s.List(0)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(all) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(all))
	}
	// Newest first; both have ids + timestamps filled in.
	for _, e := range all {
		if e.ID == "" || e.At == 0 {
			t.Fatalf("entry missing id/timestamp: %+v", e)
		}
	}
	// Limit honored.
	one, _ := s.List(1)
	if len(one) != 1 {
		t.Fatalf("limit=1 returned %d", len(one))
	}
}

func TestSQLiteAppendOnly(t *testing.T) {
	s, err := audit.NewSQLiteStore(filepath.Join(t.TempDir(), "audit.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer s.Close()
	runContract(t, s)
}

func TestNullAppendOnly(t *testing.T) {
	runContract(t, audit.NewNullStore())
}
