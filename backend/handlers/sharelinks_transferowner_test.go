package handlers

// sharelinks_transferowner_test.go — LOW regression guard: TransferOwner used
// to swallow (`_ = err`) a failure demoting the previous owner to editor. That
// is still intentionally non-fatal (ownership has already moved), but the
// error must now be logged instead of silently discarded so an operator can
// notice a previous owner was left with NO access record at all.

import (
	"bytes"
	"log"
	"net/http"
	"strings"
	"testing"

	"diwan/backend/fileacl"
	"diwan/backend/middleware"
	"diwan/backend/models"

	"github.com/gin-gonic/gin"
)

// shareWithRoleFailStore wraps a fileacl.Store and forces ShareWithRole to
// always fail, so TransferOwner's "demote previous owner" step exercises its
// (previously swallowed) error path.
type shareWithRoleFailStore struct {
	fileacl.Store
}

func (s shareWithRoleFailStore) ShareWithRole(fileID, accountID string, role fileacl.Role) error {
	return errFile("simulated demote failure")
}

func TestTransferOwner_DemoteFailure_LoggedNotSwallowed(t *testing.T) {
	st := newMemStorage()
	acl := shareWithRoleFailStore{fileacl.NewNullStore()}
	authz := NewFileAuthzWithAuth(acl, true)
	h := NewFileHandlerWithAuthz(st, authz)

	fileID := "doc1"
	st.files[fileID] = &models.File{ID: fileID, Name: "Doc", Type: models.FileTypeDoc, Rev: 1}
	_ = acl.SetOwner(fileID, "alice")

	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Set(middleware.CtxAuthenticated, true)
		c.Set(middleware.CtxUserID, "alice")
		c.Next()
	})
	r.POST("/files/:id/transfer-owner", h.TransferOwner)

	var logBuf bytes.Buffer
	prevOut := log.Writer()
	prevFlags := log.Flags()
	log.SetOutput(&logBuf)
	log.SetFlags(0)
	defer func() {
		log.SetOutput(prevOut)
		log.SetFlags(prevFlags)
	}()

	w := doReq(r, http.MethodPost, "/files/"+fileID+"/transfer-owner", models.TransferOwnerRequest{NewOwner: "bob"})

	// Non-fatal: ownership had already transferred before the demote step, so
	// the request must still succeed even though the demote failed.
	if w.Code != http.StatusOK {
		t.Fatalf("transfer-owner should still succeed despite a demote failure, got %d (%s)", w.Code, w.Body.String())
	}
	// Ownership actually moved.
	if role, ok, _ := acl.GetRole(fileID, "bob"); !ok || role != fileacl.RoleOwner {
		t.Fatalf("bob should be the new owner, got role=%q ok=%v", role, ok)
	}

	logged := logBuf.String()
	if !strings.Contains(logged, "demote previous owner") || !strings.Contains(logged, "simulated demote failure") {
		t.Fatalf("VULN: demote failure was not logged (swallowed) — log output: %q", logged)
	}
}
