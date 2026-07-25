# Ofisi — User Guide

Ofisi is the documents product of VulOS: word-processor documents (**Docs**), spreadsheets (**Sheets**), presentations (**Slides**), infinite-canvas **Whiteboards** (built on Excalidraw), and PDF viewing/annotation/**Signing**, all served from a single self-hosted Go binary with the web app built in. This guide covers everyday use — creating and opening files, editing in each surface, collaborating live with other people, working offline, importing and exporting files, and keyboard shortcuts. If you run the server yourself, see the [Admin Guide](ADMIN-GUIDE.md); for how collaboration works under the hood, see [Collaboration](COLLABORATION.md).

---

## 1. Getting in

Open the app in your browser (by default `http://localhost:8080`, or wherever your admin deployed it).

- **Single-user mode** (the default): no login is required — you *are* the account. Everything below just works.
- **Multi-user mode** (when the admin has enabled auth): you log in with your account and password, or via your Vulos single sign-on session if the instance is attached to one. New accounts are created with an **invite token** minted by an admin.

Ofisi is a **PWA** — your browser can install it as a desktop or mobile app (look for "Install app" in the browser menu). The app shell keeps loading even when the network is down (see [Offline behavior](#7-offline-behavior)).

---

## 2. Creating, opening, and organizing files

### The Home screen

The Home screen (`/`) shows your workspace: recent files, plus per-surface home pages at `/docs`, `/sheets`, `/slides`, and `/pdf`.

### Creating a file

Click **New** to open the new-file dialog:

1. Pick a type — **Document**, **Spreadsheet**, or **Presentation**.
2. For Docs and Sheets, optionally pick a starter **template** (or Blank). Slides has its own template gallery inside the editor.
3. Name it and create. You land directly in the editor.

New files are **private to you** by default — the creator is the owner.

### Opening existing files

- Click any file on Home or a surface home page.
- **Open** a file from your computer (file picker or drag-and-drop). Ofisi detects the format by extension and routes it to the right editor — see [Import](#8-import--export) for the supported list.
- **Shared with me** lists documents other accounts on the instance have shared with you.

### Folders, moving, and deleting

- Files can be organized into **folders**; use *Move* on a file to place it.
- Folders can be trashed and deleted.
- Deleting a file removes it along with its sharing state.

### Renaming and ownership

- Rename from the editor's title field or the file's menu.
- The owner can **transfer ownership** of a file to another account.

---

## 3. Editing documents (Docs)

Docs is a rich-text editor (built on TipTap). The toolbar's primary row gives you:

- **Undo / Redo**
- **Font family** and **font size** (custom point sizes supported)
- **Bold, Italic, Underline, Strikethrough, Code**
- **Text color** and **highlight**
- **Links** (select text, insert a link)
- **Bullet, numbered, and checklist** lists
- **Decrease / increase indent**
- **Alignment** — left, center, right, justify — and **line spacing**
- **Insert image**, **insert table**, **clear formatting**

The insert/heading menu adds:

- **Headings** H1–H6, blockquote, code block, horizontal rule
- **Subscript / superscript** (also `Cmd/Ctrl+,` and `Cmd/Ctrl+.`)
- **Live table of contents** — a ToC node that refreshes itself as headings change
- **Footnotes**
- **Equations** (dedicated equation editor)
- **Page setup** (page size/margins) and **headers & footers** — the editor renders real page breaks against your page setup

### Tables

Insert a table by dragging out its size on the grid picker (up to the grid shown, e.g. "3 × 4"). When your caret is inside a table, a contextual table menu appears with row operations, column operations, header-row toggle, **merge/split cells**, and **delete table**. Header cells are marked up for screen readers.

### Images

- Insert images from the toolbar; uploaded images are capped at **10 MB** each and must be real raster images (PNG/JPEG/etc. — the server sniffs the actual content, so SVG or mislabeled files are rejected).
- Once placed, images can be **resized and aligned**, and given **alt text**.
- Images pasted or imported inside documents go through a strict sanitizer — scripts, iframes, and non-raster data URIs are stripped.

### Comments, suggestions, and history

- **Comments** anchor to a text selection. Open the comments panel, or press `Cmd/Ctrl+Alt+M` — if your caret is inside a commented span it focuses that comment, otherwise it opens the panel to add one. Comments support threaded **replies** and **@mentions**.
- **Suggestions** are track-changes-style proposals that can be **accepted or rejected**.
- **Version history** (history panel): every save creates version snapshots; you can create a **named snapshot**, **label** a version, view a **diff** against the current text (line-level for Docs), and **restore** any version. Restore asks for confirmation.

### Navigation and stats

- **Document outline** — a live sidebar of the heading structure.
- **Word count** — live counter with a detail modal.
- **Find** (`Cmd/Ctrl+F`) and **Find & Replace** (`Cmd/Ctrl+H`).
- **Print / print-to-PDF** — `Cmd/Ctrl+P` prints the paginated document.

---

## 4. Editing spreadsheets (Sheets)

Sheets is a full spreadsheet grid (built on Fortune Sheet):

- **Formulas** — a large built-in function library, with live recalculation.
- **Number formats** — general, currency, percent, dates, and more via the number-format menu.
- **Conditional formatting**, including **color scales**.
- **Data validation** rules per range (with a dedicated panel).
- **Charts** — column, bar, line, area, and pie, created through the chart wizard and rendered as an overlay layer on the grid. Charts survive export (chart metadata rides along in the workbook).
- **Filters** (filter panel), **pivot tables** (pivot panel + layer), **named ranges**, and **freeze panes**.
- **Find & replace** for cell contents.
- Multiple sheets per workbook.

Pasting: `Cmd/Ctrl+Shift+V` pastes **values only** — clipboard text is parsed as tab-separated rows/columns and inserted as plain values starting at the focused cell.

---

## 5. Editing presentations (Slides)

Slides is a positioned-object canvas editor:

- **Free placement** — drag, resize, and rotate text boxes, shapes, and images anywhere on the slide.
- **Themes** (theme gallery) and a **template gallery** for new decks.
- **Master slides** — edit the master to change every slide's layout.
- Per-element **animations** and per-slide **transitions**.
- An **arrange toolbar** for z-order and alignment of objects.
- **Presenter view** — speaker notes plus a timer in a second window while presenting.
- **Present** runs a full-screen slideshow (transitions are hosted by Reveal.js under the hood — the content is still your positioned objects).

---

## 5a. Whiteboards

Whiteboards are an infinite hand-drawn canvas, built on the open-source [Excalidraw](https://github.com/excalidraw/excalidraw) editor. Create one with **New → Whiteboard** (from Home, the app rail, or the file browser).

- **Draw anything** — rectangles, ellipses, diamonds, arrows and lines, freehand pen, text labels, and pasted/inserted raster images, all on a pannable, zoomable canvas.
- **Live collaboration is peer-to-peer**, exactly like Docs: share an invite link (`#vp2p=`) and co-editors connect directly over an end-to-end-encrypted room — every shape merges independently (a Yjs CRDT), and there is **no central whiteboard server**. On a plain standalone binary with no peering fabric AND no rendezvous URL configured, the board works **local-only** with autosave and shows an honest **Offline** pill rather than a fake "Live" (see §6.3 for how a standalone deployment can still get real P2P).
- Your whiteboard **autosaves** to its own file. A **view-only** invite lets someone watch live edits without being able to change the board.

---

## 6. Live collaboration

Every file has three complementary ways to bring other people in. (Full technical detail: [COLLABORATION.md](COLLABORATION.md).)

### 6.1 Share with an account (multi-user instances)

On an instance with accounts, use **Share** on a file to grant access to another account, choosing a role:

| Role | Can do |
|------|--------|
| **Viewer** | Read the document |
| **Commenter** | Read + add comments |
| **Editor** | Read + edit content |

Only the **owner** can grant, change, or revoke roles. Shared files appear in the recipient's *Shared with me*. Every grant/change/revoke is recorded in the instance's audit log.

Account sharing controls **who may open the document from your storage**. Live co-editing itself is **peer-to-peer** (see §6.3 and [COLLABORATION.md](COLLABORATION.md)): when collaborators have the same document open through a collaboration link, their edits sync **directly between browsers**, end-to-end encrypted, and a presence bar shows **who is in the document, with live remote cursors and selections**. There is no central document server in the live path.

### 6.2 Read-only share links

Create a **share link** for a file to let anyone with the link view it (no account needed) at `/view/<token>`:

- Links are unguessable (256-bit random tokens).
- Optional **password** — stored only as a hash; viewers must enter it before the document name or content is revealed.
- Optional **expiry**, capped at one year — links can't be eternal.
- Links are **read-only** and can be **revoked** at any time.

### 6.3 Collaborate via link (end-to-end encrypted, Docs)

For Docs, **Collaborate via link** starts an end-to-end encrypted peer session:

- You get two links: a **read-write** link and a **read-only** link. Send the right one to the right people.
- The secret key travels in the **URL fragment** (`#vp2p=…`) — it is never sent to any server. Anyone who has the link has the key, so share it over a channel you trust.
- Your edits go **only** to the encrypted peer channel — peers connect directly (WebRTC), and there is no server in the path that could read them.
- **Rotate** mints a brand-new room and links; the old links stop working. Use it to cut off previously shared links.
- Read-only peers see live edits but cannot make authoritative changes.
- A tampered or malformed invite link simply fails to join — the editor stays in normal local mode.

> Note: the peer-to-peer channel needs a peer-discovery transport to be reachable — either the Vulos peering fabric (provided when Ofisi runs inside a Vulos OS / Relay deployment), **or** a self-hosted `vulos-relayd` your admin pointed this deployment at (`collab.rendezvous_url`, no Vulos OS or account needed — see [CONFIGURATION.md](CONFIGURATION.md)). On a bare standalone server with **neither** configured, invite-link collaboration cannot connect peers — account-based live collaboration (6.1) is the path that always works regardless.

---

## 7. Offline behavior

Ofisi is deliberately resilient to bad networks:

- **App shell offline**: the service worker caches the application itself, so the app opens even with no network. API data is never cached — you see the app, and your locally cached work, not stale server state.
- **Crash-safe drafts**: before every save to the server, the document is written to a local IndexedDB draft. If the browser crashes or you go offline mid-edit, the editor offers to **restore the pending draft** on reload. Drafts are cleared after a successful save.
- **Save state**: the editor surfaces its save status (dirty / saving / saved / error) so you always know whether your work has reached the server.
- **Collaboration while offline**: edits keep applying locally and are buffered; when the connection returns, the session exchanges state with the server/peers and **converges without losing either side's edits** (the merge is CRDT-based — see [COLLABORATION.md](COLLABORATION.md)).
- **Conflict on save**: if the file changed on the server since you loaded it (e.g. a colleague saved from another device), the save is refused rather than silently overwriting, and the editor reconciles with the current server revision and retries.

---

## 8. Import & Export

### Opening (import) — supported formats

| Surface | Formats you can open |
|---------|----------------------|
| Docs | `.md`, `.txt`, `.docx`, `.rtf`, `.html`/`.htm`, `.odt` |
| Sheets | `.xlsx`, `.xls`, `.csv`, `.tsv`, `.ods` |
| Slides | `.pptx`, `.odp` |
| PDF | `.pdf` |

Legacy binary **`.doc` / `.xls` / `.ppt` are not supported** — re-save them as `.docx` / `.xlsx` / `.pptx` (or ODF) first; the Open dialog will tell you the same.

Notes on import fidelity:

- `.docx` import extracts embedded images as inline data — nothing is fetched from the network during import, and remote image references in the source file are dropped rather than fetched.
- All imported HTML passes through the sanitizer before it reaches the editor.
- Import size and archive bounds are enforced, so a hostile file can't hang the app.

### Exporting

| Surface | Export formats | Where it happens |
|---------|----------------|------------------|
| Docs | **PDF** (via print), **DOCX**, **ODT**, **Markdown**, **HTML** | PDF/DOCX also available server-side; ODT/MD/HTML in the browser |
| Sheets | **XLSX**, **CSV**, **ODS** | XLSX also available server-side |
| Slides | **PDF** (via print), **PPTX** | PPTX is generated in the browser |
| Signed PDFs | Sealed **PDF** + audit **manifest** download | Server-side |

Sheets exports neutralize spreadsheet formula injection: cells beginning with `=`, `+`, `-`, or `@` are escaped on the way out so a malicious sheet can't attack another spreadsheet program.

There is also a scripting-friendly REST API (`/v1/documents/...`) that can create, read, and export documents — see [API.md](API.md).

---

## 9. PDFs and signing

The PDF surface lets you:

- **View** PDFs, and **reorder** (drag thumbnails), **rotate**, and **delete** pages.
- **Annotate** — text, freehand drawing, shapes.
- **Fill forms** — interactive AcroForm fields are detected and can be filled.
- **Sign** — draw, type, or upload a signature.
- **Signing envelopes** — send a document to multiple signers, sequentially or in parallel, from the envelope dashboard (`/envelopes`). Each signer receives a link to a public signer page (`/sign/<token>`) — no account needed — and can sign or decline. You can track status and cancel.
- **Sealed output** — when an envelope completes, download the sealed PDF and its cryptographic **manifest**; anyone can check a signed document on the public **verify** page (`/verify`).

---

## 10. Keyboard shortcuts

`Mod` means `Cmd` on macOS, `Ctrl` elsewhere.

### Docs

| Shortcut | Action |
|----------|--------|
| `Mod+B` | Bold |
| `Mod+I` | Italic (standard editor binding) |
| `Mod+U` | Underline (standard editor binding) |
| `Mod+K` | Insert/edit link on selection |
| `Mod+,` | Subscript |
| `Mod+.` | Superscript |
| `Mod+F` | Find |
| `Mod+H` | Find & replace |
| `Mod+P` | Print / print-to-PDF |
| `Mod+Alt+M` | Focus comment at caret, or open the comments panel |
| `Mod+Z` / `Mod+Shift+Z` | Undo / redo (standard editor binding) |

Docs also supports typographic input shortcuts (e.g. straight quotes to smart quotes) and markdown-style input for lists and headings via the editor's input rules.

### Sheets

| Shortcut | Action |
|----------|--------|
| `Mod+/` | Show the shortcuts help overlay |
| `Mod+;` | Insert today's date in the focused cell |
| `Mod+Shift+;` | Insert the current time |
| `Mod+Shift+V` | Paste values only (plain TSV, no formatting) |

The in-app help overlay (`Mod+/` in Sheets) is always the authoritative list for your version.

---

## 11. Settings and notifications

- **Settings** (`/settings`) — account, storage and admin info; admins additionally get the **Admin** panel with invite management and the audit log.
- **Notifications** — the bell lists events like shares and comment mentions; mark items (or everything) read.

## 12. Where to go next

- Something not syncing or exporting? → [TROUBLESHOOTING.md](TROUBLESHOOTING.md)
- How collaboration and encryption actually work → [COLLABORATION.md](COLLABORATION.md)
- Running your own instance → [ADMIN-GUIDE.md](ADMIN-GUIDE.md)
