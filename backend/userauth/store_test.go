package userauth_test

import (
	"path/filepath"
	"testing"

	"diwan/backend/userauth"
)

func runUserAuthContract(t *testing.T, s userauth.Store) {
	t.Helper()

	if has, _ := s.HasUsers(); has {
		t.Fatal("fresh store should have no users")
	}

	if err := s.Register("Alice@Vulos.org", "correct-horse"); err != nil {
		t.Fatalf("register: %v", err)
	}
	if has, _ := s.HasUsers(); !has {
		t.Fatal("store should report users after register")
	}

	// Duplicate (case-insensitive) is rejected.
	if err := s.Register("alice@vulos.org", "other"); err != userauth.ErrUserExists {
		t.Fatalf("duplicate register: expected ErrUserExists, got %v", err)
	}

	// Correct password verifies and normalizes the account id.
	id, err := s.Verify("alice@VULOS.org", "correct-horse")
	if err != nil {
		t.Fatalf("verify correct: %v", err)
	}
	if id != "alice@vulos.org" {
		t.Fatalf("canonical id should be normalized; got %q", id)
	}

	// Wrong password fails.
	if _, err := s.Verify("alice@vulos.org", "guess"); err != userauth.ErrInvalidCredential {
		t.Fatalf("verify wrong: expected ErrInvalidCredential, got %v", err)
	}

	// Unknown account fails (no existence distinction).
	if _, err := s.Verify("nobody@vulos.org", "whatever"); err != userauth.ErrInvalidCredential {
		t.Fatalf("verify unknown: expected ErrInvalidCredential, got %v", err)
	}

	// Empty input rejected on register.
	if err := s.Register("", "pw"); err != userauth.ErrEmptyInput {
		t.Fatalf("empty register: expected ErrEmptyInput, got %v", err)
	}
}

func TestSQLiteUserAuthContract(t *testing.T) {
	s, err := userauth.NewSQLiteStore(filepath.Join(t.TempDir(), "users.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer s.Close()
	runUserAuthContract(t, s)
}

func TestNullUserAuthContract(t *testing.T) {
	runUserAuthContract(t, userauth.NewNullStore())
}

// TestSQLiteUserAuthPersistsAcrossReopen proves credentials survive a restart.
func TestSQLiteUserAuthPersistsAcrossReopen(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "users.db")
	s1, err := userauth.NewSQLiteStore(dbPath)
	if err != nil {
		t.Fatalf("open1: %v", err)
	}
	if err := s1.Register("bob@vulos.org", "longpassword"); err != nil {
		t.Fatalf("register: %v", err)
	}
	_ = s1.Close()

	s2, err := userauth.NewSQLiteStore(dbPath)
	if err != nil {
		t.Fatalf("open2: %v", err)
	}
	defer s2.Close()
	if id, err := s2.Verify("bob@vulos.org", "longpassword"); err != nil || id != "bob@vulos.org" {
		t.Fatalf("credential did not survive restart: id=%q err=%v", id, err)
	}
}

// TestMigrateSharedPassword proves the one-shot shared-password → per-user
// migration creates the first credential and is idempotent (no lockout, no
// double-create) on subsequent runs.
func TestMigrateSharedPassword(t *testing.T) {
	s := userauth.NewNullStore()

	// First run: creates the admin credential from the shared password.
	if err := userauth.MigrateSharedPassword(s, "admin@vulos.org", "shared-secret-123"); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	// Admin can now authenticate with the shared password.
	if id, err := s.Verify("admin@vulos.org", "shared-secret-123"); err != nil || id != "admin@vulos.org" {
		t.Fatalf("migrated credential cannot authenticate: id=%q err=%v", id, err)
	}

	// Second run: store already has users → no-op (idempotent).
	if err := userauth.MigrateSharedPassword(s, "admin@vulos.org", "shared-secret-123"); err != userauth.ErrAlreadyMigrated {
		t.Fatalf("second migrate: got %v (want ErrAlreadyMigrated)", err)
	}

	// Empty input rejected.
	fresh := userauth.NewNullStore()
	if err := userauth.MigrateSharedPassword(fresh, "", "pw"); err != userauth.ErrEmptyInput {
		t.Fatalf("empty admin: got %v (want ErrEmptyInput)", err)
	}
}

// TestUpdatePassword proves self-service password rotation works against both
// store backends: the new password authenticates, the old one no longer does,
// and unknown accounts / empty input are rejected.
func TestUpdatePassword(t *testing.T) {
	for _, tc := range []struct {
		name string
		make func(t *testing.T) userauth.Store
	}{
		{"null", func(t *testing.T) userauth.Store { return userauth.NewNullStore() }},
		{"sqlite", func(t *testing.T) userauth.Store {
			s, err := userauth.NewSQLiteStore(t.TempDir() + "/creds.db")
			if err != nil {
				t.Fatalf("open: %v", err)
			}
			t.Cleanup(func() { s.Close() })
			return s
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := tc.make(t)
			if err := s.Register("alice@vulos.org", "old-password-1"); err != nil {
				t.Fatalf("register: %v", err)
			}
			if err := s.UpdatePassword("alice@vulos.org", "new-password-2"); err != nil {
				t.Fatalf("update: %v", err)
			}
			if _, err := s.Verify("alice@vulos.org", "new-password-2"); err != nil {
				t.Fatalf("new password should authenticate: %v", err)
			}
			if _, err := s.Verify("alice@vulos.org", "old-password-1"); err == nil {
				t.Fatalf("old password must no longer authenticate")
			}
			if err := s.UpdatePassword("ghost@vulos.org", "whatever-99"); err != userauth.ErrUserNotFound {
				t.Fatalf("unknown account: got %v (want ErrUserNotFound)", err)
			}
			if err := s.UpdatePassword("alice@vulos.org", ""); err != userauth.ErrEmptyInput {
				t.Fatalf("empty password: got %v (want ErrEmptyInput)", err)
			}
		})
	}
}
