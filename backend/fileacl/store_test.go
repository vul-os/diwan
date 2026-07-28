package fileacl_test

import (
	"path/filepath"
	"testing"

	"diwan/backend/fileacl"
)

func runStoreContract(t *testing.T, s fileacl.Store) {
	t.Helper()

	// Unknown file is unowned → accessible (fail-safe), not recorded.
	allowed, recorded, err := s.CanAccess("nope", "anyone")
	if err != nil {
		t.Fatalf("CanAccess unknown: %v", err)
	}
	if !allowed || recorded {
		t.Fatalf("unknown file should be allowed+unrecorded; got allowed=%v recorded=%v", allowed, recorded)
	}

	// Record an owner; owner has access, others do not.
	if err := s.SetOwner("f1", "alice"); err != nil {
		t.Fatalf("SetOwner: %v", err)
	}
	if a, rec, _ := s.CanAccess("f1", "alice"); !a || !rec {
		t.Fatalf("owner should have recorded access; got allowed=%v recorded=%v", a, rec)
	}
	if a, rec, _ := s.CanAccess("f1", "bob"); a || !rec {
		t.Fatalf("non-owner should be denied on a recorded file; got allowed=%v recorded=%v", a, rec)
	}

	// Share grants access.
	if err := s.Share("f1", "bob"); err != nil {
		t.Fatalf("Share: %v", err)
	}
	if a, _, _ := s.CanAccess("f1", "bob"); !a {
		t.Fatal("shared account should have access")
	}

	// AccessibleFileIDs reflects ownership + shares.
	ids, err := s.AccessibleFileIDs("alice")
	if err != nil {
		t.Fatalf("AccessibleFileIDs: %v", err)
	}
	if !ids["f1"] {
		t.Fatal("alice should own f1")
	}
	ids, _ = s.AccessibleFileIDs("bob")
	if !ids["f1"] {
		t.Fatal("bob should access f1 via share")
	}

	// Unshare revokes.
	if err := s.Unshare("f1", "bob"); err != nil {
		t.Fatalf("Unshare: %v", err)
	}
	if a, _, _ := s.CanAccess("f1", "bob"); a {
		t.Fatal("unshared account should lose access")
	}

	// Delete drops ACL → file becomes unowned again (fail-safe allow).
	if err := s.Delete("f1"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if a, rec, _ := s.CanAccess("f1", "bob"); !a || rec {
		t.Fatalf("deleted ACL should be unowned+allowed; got allowed=%v recorded=%v", a, rec)
	}
}

func TestSQLiteStoreContract(t *testing.T) {
	s, err := fileacl.NewSQLiteStore(filepath.Join(t.TempDir(), "acl.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer s.Close()
	runStoreContract(t, s)
}

func TestNullStoreContract(t *testing.T) {
	runStoreContract(t, fileacl.NewNullStore())
}

// TestSQLiteStorePersistsAcrossReopen proves ACLs survive a restart.
func TestSQLiteStorePersistsAcrossReopen(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "acl.db")
	s1, err := fileacl.NewSQLiteStore(dbPath)
	if err != nil {
		t.Fatalf("open1: %v", err)
	}
	_ = s1.SetOwner("doc", "alice")
	_ = s1.Share("doc", "bob")
	_ = s1.Close()

	s2, err := fileacl.NewSQLiteStore(dbPath)
	if err != nil {
		t.Fatalf("open2: %v", err)
	}
	defer s2.Close()
	if a, _, _ := s2.CanAccess("doc", "alice"); !a {
		t.Fatal("owner access did not survive restart")
	}
	if a, _, _ := s2.CanAccess("doc", "bob"); !a {
		t.Fatal("share did not survive restart")
	}
	if a, _, _ := s2.CanAccess("doc", "mallory"); a {
		t.Fatal("non-shared account should still be denied after restart")
	}
}
