package rendezvous

// no-broker-dep:allow-file: below (in the CORS doc comment) cites Ephor's rendezvous role as
// prior art for this package's own no-auth-middleware argument — this file implements Diwan's
// OWN built-in discovery surface (the default path), not a dependency on Ephor.

import (
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

// Prefix is where the built-in surface is mounted, under Diwan's own /api. It is
// a CONSTANT rather than a config knob: the browser learns it from
// GET /api/reachability, so nothing is gained by letting two deployments disagree
// about it, and a fixed path is one less thing an operator can misconfigure into
// a silently-broken collab session.
const Prefix = "/api/rendezvous"

// MaxBodyBytes caps a request body before it is parsed. It has to exceed
// Limits.MaxPayloadBytes (a payload crosses as base64, ~4/3 of its decoded size)
// plus the envelope, with room to spare — but it must still be a hard ceiling, so
// an anonymous caller cannot make the process buffer an arbitrary stream just to
// have its signature rejected afterwards.
const MaxBodyBytes = 256 * 1024

// Mount registers the rendezvous protocol on r under Prefix.
//
// The routes are:
//
//	POST /announce                   signed presence publish
//	POST /withdraw                   signed presence delete
//	GET  /resolve/:key               unauthenticated presence read
//	POST /signal/:key                deposit a WebRTC signalling blob
//	POST /signal/:key/poll           long-poll that key's signal inbox
//	POST /signal/:key/ack            delete named blobs from it
//	POST /mailbox/:key               deposit a sealed relay-circuit blob
//	POST /mailbox/:key/poll          long-poll that key's mailbox
//	POST /mailbox/:key/ack           delete named blobs from it
//	GET  /healthz                    liveness for deploy tooling and tests
//
// CORS is whatever the app already applies process-wide (main.go: a wildcard
// WITHOUT credentials unless DIWAN_CORS_ORIGINS names an allowlist, in which case
// credentials are allowed for those origins). This surface adds nothing and
// removes nothing, and it is safe under either posture for one specific reason:
// the protocol never authenticates with ambient credentials. Authority comes
// exclusively from an Ed25519 signature inside the body, so a cookie a browser
// might attach to a cross-origin request buys an attacker nothing here — the same
// argument Ephor's rendezvous role makes for its own wildcard.
//
// NO AUTH MIDDLEWARE, and that is not an omission: anonymous invite-link
// collaboration is the feature, and the protocol authenticates every write with
// an Ed25519 signature over a nonce'd, timestamped canonical message. Attach a
// rate-limiting middleware from the caller (main.go does) for the volumetric half
// of the problem, which signatures do not address.
func Mount(r gin.IRouter, svc *Service) {
	g := r.Group(Prefix)

	g.GET("/healthz", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"ok": true, "service": "rendezvous"})
	})

	g.POST("/announce", func(c *gin.Context) {
		var req AnnounceRequest
		if !bindJSON(c, &req) {
			return
		}
		res, err := svc.Announce(req)
		if err != nil {
			fail(c, err)
			return
		}
		c.JSON(http.StatusOK, res)
	})

	g.POST("/withdraw", func(c *gin.Context) {
		var req WithdrawRequest
		if !bindJSON(c, &req) {
			return
		}
		if err := svc.Withdraw(req); err != nil {
			fail(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true, "key": req.Key})
	})

	g.GET("/resolve/:key", func(c *gin.Context) {
		p, err := svc.Resolve(c.Param("key"))
		if errors.Is(err, ErrNotFound) {
			// 404 WITH a JSON body carrying online:false. The JS client reads the
			// body on 404 precisely so "not present" is a normal answer rather
			// than an error it has to guess about.
			c.JSON(http.StatusNotFound, p)
			return
		}
		if err != nil {
			fail(c, err)
			return
		}
		c.JSON(http.StatusOK, p)
	})

	mountQueue(g, svc, "/signal", queueSignal)
	mountQueue(g, svc, "/mailbox", queueMailbox)
}

func mountQueue(g *gin.RouterGroup, svc *Service, base string, kind queueKind) {
	g.POST(base+"/:key", func(c *gin.Context) {
		var req DepositRequest
		if !bindJSON(c, &req) {
			return
		}
		res, err := svc.Deposit(kind, c.Param("key"), req)
		if err != nil {
			fail(c, err)
			return
		}
		c.JSON(http.StatusOK, res)
	})

	g.POST(base+"/:key/poll", func(c *gin.Context) {
		var req PollRequest
		if !bindJSON(c, &req) {
			return
		}
		key := c.Param("key")
		wait, err := svc.authPoll(kind, key, req)
		if err != nil {
			fail(c, err)
			return
		}
		// Verified first, blocked second. A caller without a valid signature can
		// never hold a connection open, which is what stops the long-poll from
		// being a free connection-exhaustion primitive.
		if wait > 0 {
			if ch := svc.park(kind, key); ch != nil {
				timer := time.NewTimer(wait)
				select {
				case <-ch:
					// A deposit arrived; fall through and read it.
				case <-timer.C:
					svc.unpark(kind, key, ch)
				case <-c.Request.Context().Done():
					// Client hung up. Unpark and answer nothing further.
					svc.unpark(kind, key, ch)
					timer.Stop()
					return
				}
				timer.Stop()
			}
		}
		c.JSON(http.StatusOK, svc.Read(kind, key))
	})

	g.POST(base+"/:key/ack", func(c *gin.Context) {
		var req AckRequest
		if !bindJSON(c, &req) {
			return
		}
		res, err := svc.Ack(kind, c.Param("key"), req)
		if err != nil {
			fail(c, err)
			return
		}
		c.JSON(http.StatusOK, res)
	})
}

// bindJSON reads a size-capped body and decodes it, answering 400/413 itself.
// Returns false when the request has already been answered.
func bindJSON(c *gin.Context, dst any) bool {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, MaxBodyBytes)
	if err := c.ShouldBindJSON(dst); err != nil {
		// MaxBytesReader surfaces an over-cap body as a read error, which is a
		// 413 rather than a 400: the difference matters to a client deciding
		// whether to retry with less.
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) || errors.Is(err, io.ErrUnexpectedEOF) {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": ErrTooLarge.Error()})
			return false
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": ErrBadRequest.Error()})
		return false
	}
	return true
}

// fail maps a service error to a status. Every mapping is a REFUSAL — there is no
// error here that results in the request being partially honoured, which is what
// "fail closed" means for this surface.
func fail(c *gin.Context, err error) {
	status := http.StatusBadRequest
	switch {
	case errors.Is(err, ErrBadSignature):
		// 403, not 401: there is no credential to go and get. The caller signed,
		// and the signature did not verify.
		status = http.StatusForbidden
	case errors.Is(err, ErrReplay), errors.Is(err, ErrStale):
		// 409 Conflict — the envelope is well-formed and correctly signed but not
		// FRESH. Distinguishable from a bad signature so a client with a skewed
		// clock can be told the real reason.
		status = http.StatusConflict
	case errors.Is(err, ErrTooLarge):
		status = http.StatusRequestEntityTooLarge
	case errors.Is(err, ErrCapacity):
		status = http.StatusServiceUnavailable
	case errors.Is(err, ErrNotFound):
		status = http.StatusNotFound
	}
	c.JSON(status, gin.H{"error": err.Error()})
}
