package invites_test

import (
	"path/filepath"
	"testing"
	"time"

	"diwan/backend/invites"
)

func runContract(t *testing.T, s invites.Store) {
	t.Helper()

	// Mint a single-use token.
	raw, inv, err := s.Mint("admin@vulos.org", "alice@vulos.org", 1, time.Hour)
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	if raw == "" || inv.ID == "" {
		t.Fatal("mint returned empty token/id")
	}
	if inv.MaxUses != 1 || inv.UsedCount != 0 {
		t.Fatalf("unexpected mint metadata: %+v", inv)
	}

	// Consume once — succeeds.
	got, err := s.Consume(raw)
	if err != nil {
		t.Fatalf("first consume: %v", err)
	}
	if got.UsedCount != 1 {
		t.Fatalf("used_count after consume = %d (want 1)", got.UsedCount)
	}

	// Consume again — single-use, must fail.
	if _, err := s.Consume(raw); err != invites.ErrConsumed {
		t.Fatalf("second consume: got %v (want ErrConsumed)", err)
	}

	// Unknown token.
	if _, err := s.Consume("not-a-real-token"); err != invites.ErrNotFound {
		t.Fatalf("unknown consume: got %v (want ErrNotFound)", err)
	}

	// Expiry.
	rawExp, _, err := s.Mint("admin@vulos.org", "", 1, time.Millisecond)
	if err != nil {
		t.Fatalf("mint expiring: %v", err)
	}
	time.Sleep(5 * time.Millisecond)
	if _, err := s.Consume(rawExp); err != invites.ErrExpired {
		t.Fatalf("expired consume: got %v (want ErrExpired)", err)
	}

	// Revoke.
	rawRev, invRev, err := s.Mint("admin@vulos.org", "", 5, time.Hour)
	if err != nil {
		t.Fatalf("mint revokable: %v", err)
	}
	if err := s.Revoke(invRev.ID); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if _, err := s.Consume(rawRev); err != invites.ErrRevoked {
		t.Fatalf("revoked consume: got %v (want ErrRevoked)", err)
	}

	// List reflects all minted invites.
	all, err := s.List()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(all) < 3 {
		t.Fatalf("list returned %d invites (want >=3)", len(all))
	}

	// Multi-use token can be redeemed up to its cap.
	rawMulti, _, err := s.Mint("admin@vulos.org", "", 2, time.Hour)
	if err != nil {
		t.Fatalf("mint multi: %v", err)
	}
	if _, err := s.Consume(rawMulti); err != nil {
		t.Fatalf("multi consume 1: %v", err)
	}
	if _, err := s.Consume(rawMulti); err != nil {
		t.Fatalf("multi consume 2: %v", err)
	}
	if _, err := s.Consume(rawMulti); err != invites.ErrConsumed {
		t.Fatalf("multi consume 3: got %v (want ErrConsumed)", err)
	}
}

func TestSQLiteStoreContract(t *testing.T) {
	s, err := invites.NewSQLiteStore(filepath.Join(t.TempDir(), "invites.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer s.Close()
	runContract(t, s)
}

func TestNullStoreContract(t *testing.T) {
	runContract(t, invites.NewNullStore())
}

// TestSQLitePersistsAcrossReopen proves invites survive a restart.
func TestSQLitePersistsAcrossReopen(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "invites.db")
	s1, err := invites.NewSQLiteStore(dbPath)
	if err != nil {
		t.Fatalf("open1: %v", err)
	}
	raw, _, err := s1.Mint("admin@vulos.org", "x", 1, time.Hour)
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	_ = s1.Close()

	s2, err := invites.NewSQLiteStore(dbPath)
	if err != nil {
		t.Fatalf("open2: %v", err)
	}
	defer s2.Close()
	if _, err := s2.Consume(raw); err != nil {
		t.Fatalf("consume after reopen: %v", err)
	}
}
