package storage

// postgres_optlock_test.go — exercises the P2 optimistic-concurrency (rev
// compare-and-swap) contract against a REAL Postgres instance, so the atomic
// `UPDATE ... WHERE rev = $old` guard is validated on the production backend and
// not only on the in-memory/local mirror. Skipped unless VULOS_TEST_POSTGRES_DSN
// points at a throwaway database (same gate as the storage contract test).

import (
	"errors"
	"os"
	"sync"
	"testing"

	"diwan/backend/config"
	"diwan/backend/models"
)

func newPostgresStoreForOptLock(t *testing.T) (Storage, func(id string)) {
	t.Helper()
	dsn := os.Getenv("VULOS_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("set VULOS_TEST_POSTGRES_DSN to run the Postgres rev-CAS test")
	}
	t.Setenv("DATABASE_URL", dsn)
	store, err := New(config.Default())
	if err != nil {
		t.Fatalf("New (postgres via DATABASE_URL): %v", err)
	}
	pg := store.(*PostgresStorage)
	cleanup := func(id string) { _, _ = pg.pool.Exec(t.Context(), `DELETE FROM files WHERE id = $1`, id) }
	return store, cleanup
}

// Mirror of TestLocalUpdateFileRevCAS, but against real Postgres.
func TestPostgresUpdateFileRevCAS(t *testing.T) {
	s, cleanup := newPostgresStoreForOptLock(t)
	const id = "pg-optlock-file-1"
	cleanup(id)
	t.Cleanup(func() { cleanup(id) })

	f := &models.File{ID: id, Name: "Doc", Type: models.FileTypeDoc, Content: "v1"}
	if err := s.CreateFile(f); err != nil {
		t.Fatalf("CreateFile: %v", err)
	}
	if f.Rev != 1 {
		t.Fatalf("CreateFile rev: expected 1, got %d", f.Rev)
	}

	e1, _ := s.GetFile(id)
	e2, _ := s.GetFile(id)
	if e1.Rev != 1 || e2.Rev != 1 {
		t.Fatalf("both reads should see rev 1, got %d/%d", e1.Rev, e2.Rev)
	}

	// Editor 1 commits against rev 1 → succeeds, rev → 2.
	up1 := &models.File{ID: id, Name: "Doc", Content: "editor1", Rev: e1.Rev}
	if err := s.UpdateFile(up1); err != nil {
		t.Fatalf("editor1 UpdateFile: %v", err)
	}
	if up1.Rev != 2 {
		t.Fatalf("rev after editor1: expected 2, got %d", up1.Rev)
	}

	// Editor 2 commits against the now-STALE rev 1 → ErrRevConflict (no clobber).
	up2 := &models.File{ID: id, Name: "Doc", Content: "editor2", Rev: e2.Rev}
	if err := s.UpdateFile(up2); !errors.Is(err, ErrRevConflict) {
		t.Fatalf("editor2 stale UpdateFile: expected ErrRevConflict, got %v", err)
	}
	cur, _ := s.GetFile(id)
	if cur.Content != "editor1" || cur.Rev != 2 {
		t.Fatalf("stored after conflict: expected editor1/rev2, got %v/rev%d", cur.Content, cur.Rev)
	}

	// Reconcile against current rev → succeeds, rev → 3.
	up2b := &models.File{ID: id, Name: "Doc", Content: "editor2", Rev: cur.Rev}
	if err := s.UpdateFile(up2b); err != nil {
		t.Fatalf("editor2 reconcile UpdateFile: %v", err)
	}
	if up2b.Rev != 3 {
		t.Fatalf("rev after reconcile: expected 3, got %d", up2b.Rev)
	}

	// rev-0 (legacy) write is unconditional and still advances the rev.
	up3 := &models.File{ID: id, Name: "Doc", Content: "legacy", Rev: 0}
	if err := s.UpdateFile(up3); err != nil {
		t.Fatalf("legacy unconditional UpdateFile: %v", err)
	}
	if up3.Rev != 4 {
		t.Fatalf("rev after legacy write: expected 4, got %d", up3.Rev)
	}
}

// The real payoff of validating on Postgres: prove the CAS is atomic under a
// genuine race. N goroutines all read rev 1 and all try to commit against rev 1
// concurrently; the atomic `UPDATE ... WHERE rev = $old` must let EXACTLY ONE
// win and reject the rest with ErrRevConflict — no lost update, no double-advance.
func TestPostgresUpdateFileRevCAS_ConcurrentRace(t *testing.T) {
	s, cleanup := newPostgresStoreForOptLock(t)
	const id = "pg-optlock-race-1"
	cleanup(id)
	t.Cleanup(func() { cleanup(id) })

	if err := s.CreateFile(&models.File{ID: id, Name: "Doc", Type: models.FileTypeDoc, Content: "v1"}); err != nil {
		t.Fatalf("CreateFile: %v", err)
	}
	base, _ := s.GetFile(id) // rev 1

	const racers = 16
	var wg sync.WaitGroup
	var mu sync.Mutex
	wins, conflicts, others := 0, 0, 0
	start := make(chan struct{})

	for i := 0; i < racers; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			<-start // maximise contention
			up := &models.File{ID: id, Name: "Doc", Content: "racer", Rev: base.Rev}
			err := s.UpdateFile(up)
			mu.Lock()
			switch {
			case err == nil:
				wins++
			case errors.Is(err, ErrRevConflict):
				conflicts++
			default:
				others++
				t.Errorf("racer %d unexpected error: %v", n, err)
			}
			mu.Unlock()
		}(i)
	}
	close(start)
	wg.Wait()

	if wins != 1 {
		t.Fatalf("expected exactly ONE winner, got %d (conflicts=%d, others=%d)", wins, conflicts, others)
	}
	if conflicts != racers-1 {
		t.Fatalf("expected %d conflicts, got %d", racers-1, conflicts)
	}
	// The winner advanced the rev exactly once: 1 → 2.
	final, _ := s.GetFile(id)
	if final.Rev != 2 {
		t.Fatalf("expected final rev 2 after one winning write, got %d", final.Rev)
	}
}
