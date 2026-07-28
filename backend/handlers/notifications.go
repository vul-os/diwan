package handlers

// notifications.go — in-app notification surface for @-mentions (parity).
//
// SECURITY: identity is always the VERIFIED requester (requesterID). Every
// query/mutation is scoped to that account, so a caller can only ever read or
// mark-read their OWN notifications — there is no path to another account's rows.

import (
	"net/http"
	"os"
	"sync"

	"diwan/backend/models"
	"diwan/backend/notify"

	"github.com/gin-gonic/gin"
)

var (
	defaultNotifyStore notify.Store
	notifyOnce         sync.Once
)

// notifyDBPath resolves the notifications SQLite DSN from env, defaulting to a
// durable file under the data dir.
func notifyDBPath() string {
	if v := os.Getenv("VULOS_NOTIFY_DB"); v != "" {
		return v
	}
	return "./data/notify.db"
}

// SharedNotifyStore returns a process-wide notification store backed by durable
// SQLite, falling back to an in-memory NullStore if the DB cannot be opened
// (degraded: notifications don't persist) rather than crashing.
func SharedNotifyStore() notify.Store {
	notifyOnce.Do(func() {
		if st, err := notify.NewSQLiteStore(notifyDBPath()); err == nil {
			defaultNotifyStore = st
		} else {
			defaultNotifyStore = notify.NewNullStore()
		}
	})
	return defaultNotifyStore
}

// SetNotifyStoreForTest lets tests inject an in-memory store.
func SetNotifyStoreForTest(st notify.Store) {
	notifyOnce.Do(func() {}) // consume the once so Shared* won't override
	defaultNotifyStore = st
}

// NotificationHandler serves the per-account notification endpoints.
type NotificationHandler struct {
	store notify.Store
}

func NewNotificationHandler() *NotificationHandler {
	return &NotificationHandler{store: SharedNotifyStore()}
}

// NewNotificationHandlerWith builds a handler over a caller-supplied store (tests).
func NewNotificationHandlerWith(st notify.Store) *NotificationHandler {
	return &NotificationHandler{store: st}
}

// List returns the caller's notifications, newest-first. GET /api/notifications
func (h *NotificationHandler) List(c *gin.Context) {
	account := requesterID(c)
	rows, err := h.store.ListForAccount(account)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if rows == nil {
		rows = []*models.Notification{}
	}
	c.JSON(http.StatusOK, rows)
}

// MarkRead flips one notification to read. POST /api/notifications/:id/read
func (h *NotificationHandler) MarkRead(c *gin.Context) {
	account := requesterID(c)
	id := c.Param("id")
	ok, err := h.store.MarkRead(account, id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if !ok {
		// Either it doesn't exist or belongs to someone else — same 404 either
		// way (no existence leak across accounts).
		c.JSON(http.StatusNotFound, gin.H{"error": "notification not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// MarkAllRead marks every notification for the caller as read.
// POST /api/notifications/read-all
func (h *NotificationHandler) MarkAllRead(c *gin.Context) {
	account := requesterID(c)
	if err := h.store.MarkAllRead(account); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
