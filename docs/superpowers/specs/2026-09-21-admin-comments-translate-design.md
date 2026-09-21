# Admin Comments Section with Auto-Translate

**Date:** 2026-09-21
**Status:** Approved

## Problem

Users have been commenting on recaps since January and nobody has ever read them.

There is no comment surface in this dashboard at all — the only match for "comment"
in the entire codebase is a code comment at app.js:2063. The consumer app writes to
a `comments/` node in the same Realtime Database the dashboard already connects to,
and the dashboard has simply never looked at it.

A live read of that node shows 274 comments across 169 of the 468 movies, spanning
2026-01-14 to 2026-09-20, with 20 of them carrying replies. The data is clean: no
orphaned movie ids, no missing fields, no mismatch between a record's stored
`movieId` and its parent key.

Roughly a quarter of it is unreadable to an English-speaking admin:

| Script | Comments |
|---|---|
| Latin | 191 |
| Burmese | 65 |
| Arabic | 7 |
| Thai | 1 |
| Emoji/punctuation only | 10 |

Several are direct, answerable requests — "how can download this video?", and a
Burmese comment reading "please translate it". Users are asking questions into a
channel nobody monitors, in languages the admin cannot read.

## Goal

A Comments section in the dashboard where the admin can read every comment, understand
the ones written in other languages, reply in the commenter's language, and delete
what shouldn't be there.

## Non-goals

- Fixing database auth (see Known risks).
- Per-user identity, grouping or banning — the schema has no `userId` to hang it on.
- A Settings view. The router this introduces makes it trivial later, but it is not
  built here.
- Any change to the consumer app.

## The data

Confirmed against the live database, not assumed:

```
comments/{movieId}/{pushId}/
  movieId:   string        # redundant with the parent key, always matches
  text:      string
  timestamp: number        # ms epoch
  userName:  string        # display name only, e.g. "Fancy Lion"
  replies/{pushId}/
    text, timestamp, userName
```

Two properties drive the design:

- **No `userId`.** Names look auto-generated (adjective + animal) and are
  unauthenticated free text. Nothing can be reliably attributed to a person.
- **54KB total.** The whole tree loads in a single `onValue`, exactly like `movies/`.
  No pagination, no indexing, no query rules.

## Design

### 1. View routing

The dashboard has no view switching today; the `⚙️ Settings` nav button at
index.html:27 has no handler at all. A Comments section requires building that, so it
is built as small as it can be:

```
nav-dashboard → .content-body + #last-added   (existing Movies view)
nav-comments  → #comments-view                (new)
```

`showView(name)` toggles a `hidden` class and moves `.active` between nav items.
No hash routing, no history integration, no framework. The Movies view is untouched.

Rejected: rendering comments in a `.panel-overlay` like the movie form. Overlays suit
a focused task with a beginning and an end; reading and triaging a comment backlog is
a place you sit, and it is what "add sections" asked for.

### 2. Reading and shaping the data

One `onValue(ref(db, 'comments'))`, mirroring the movies listener at app.js:2169, kept
live so new comments appear without a reload.

The nested tree is flattened into a newest-first **inbox**, each row joined to its
movie title through a `moviesById` map built from the existing `allMovies` array.

Rejected: grouping by movie. With 169 commented movies, new activity is buried behind
168 collapsed rows. An inbox answers "what came in?", which is the reason to open the
section. A text search over comment text, user names, movie titles *and translations*
covers the "what did this movie get?" case — typing a title is faster than scrolling a
169-entry dropdown — and lets the admin search every language in English. A language
filter narrows to comments in other languages, or to those still awaiting translation.

Replies are flattened as child rows under their parent comment, never as top-level
inbox entries — a reply out of context is meaningless.

**No pagination**, unlike the movies grid. That grid paginates 468 cards each carrying a
thumbnail image; 274 text rows cost nothing to render at once, and paging a backlog you
are triaging only hides what you came to find. Revisit if comments reach the low thousands.

### 3. Translation

**Target language is English**, defined as a single constant in `comments.js`. Not a UI
selector: there is one admin, who reads English. A selector can be added when a second
reader exists who does not.

**New endpoint: `api/translate.js`**. No registration needed — dev-server.js resolves
handlers dynamically via `import('./api/' + name + '.js')`, so only its startup log line
needs the new route appended, which is cosmetic.

Not a reuse of `api/ai-service.js`: that endpoint is hardwired to a movie-metadata
system prompt and a one-prompt-one-completion shape. Translation needs batching,
language detection and strict JSON output. It does copy that file's proven structure —
OpenAI primary, Claude fallback, normalized response, request-id logging.

**What is sent, and what is not:**

| Text | Action |
|---|---|
| Non-Latin script (Burmese, Arabic, Thai, CJK) | Translate — detected locally, no API call to decide |
| Emoji / punctuation only | Skipped entirely, never sent |
| Latin script | Batched to the model, which returns detected language and passes English through unchanged |

The third row is the one that matters. Romanized Burmese and Tagalog are
indistinguishable from English by regex, so the model decides rather than a heuristic.
The cost is bounded by caching: every comment is classified once, ever.

Comments are batched ~25 per request. The 274-comment backlog is roughly a dozen calls,
once. Steady state is about one call per new foreign comment.

**Cache: a new top-level `commentTranslations/{pushId}` node.**

```
commentTranslations/
  -OwBXjT1dex8T91aqQbY/
    text: "Please translate it"
    lang: "my"
    at:   1758400000000
```

Keyed by Firebase push id, which is unique database-wide — so one flat node serves both
comments and replies with no nesting and no composite keys.

`comments/` is never written to by translation. The consumer app's data keeps exactly
the shape it has today.

Rejected:
- **Writing translations into `comments/`** — pollutes user data the consumer app reads,
  for the dashboard's convenience.
- **localStorage** — re-pays the cost on every device and loses everything on a cache
  clear, to save one node.
- **On-demand per comment** — 65 clicks to read the Burmese.

### 4. Replying

Compose in English, translate, **preview, then post**. The preview is not a nicety: it
is the only thing standing between a bad machine translation and a user reading it.

On confirm, written to `comments/{movieId}/{commentId}/replies/`:

```js
{
  text: "<translation>\n—\n<original English>",
  timestamp: Date.now(),
  userName: ADMIN_NAME,      // constant in comments.js, default "Movie Recap"
  isAdmin: true
}
```

Translation first so the reader sees their own language immediately; the original is
kept beneath it as a fallback when the translation reads oddly.

`isAdmin` is inert today — the consumer app ignores it — but it means a verified badge
can be added later without backfilling every old reply.

If translation fails, the dialog offers to post the English untranslated rather than
discarding what was typed.

### 5. Deleting

Uses a native `confirm()`, matching `confirmDelete` at app.js:2293 — the pattern the
codebase actually uses. The `#delete-modal` markup in index.html is dead: `app.js`
references it zero times. Wiring it up is a separate cleanup, not this feature's job.

Deleting a parent comment also removes its nested replies, and the modal says so
explicitly — that consequence is invisible in the UI otherwise. The cached translation
at `commentTranslations/{pushId}` is removed alongside, for the comment and for each
reply underneath it.

### 6. Code structure

`app.js` cannot be unit-tested: it imports Firebase over `https://` URLs and reads
`window.CONFIG` at module load. Following the last-added.js precedent, pure logic goes
in a new **`comments.js`** that imports nothing:

- `flattenComments(tree, moviesById)` — tree to sorted inbox rows
- `detectScript(text)` — script bucket for the local pre-filter
- `needsTranslation(text)` — false for empty, emoji-only, punctuation-only
- `formatAdminReply(translation, original)` — the posted body

`app.js` keeps the Firebase wiring, DOM rendering and event handling.

### 7. Failure behavior

Translation is strictly additive. If the API key is absent, the network fails, or the
model returns unparseable output, **every comment still renders with its original text**
plus a retry control. The section is fully usable with translation completely broken.

A failed Firebase write surfaces through the existing `showToast` and leaves the draft
in place.

## Testing

`comments.test.js` under `node --test`, following last-added.test.js:

- `flattenComments` — newest-first ordering, ties on equal timestamps, replies attached
  to the right parent, a comment whose movie is missing from `moviesById`, an empty tree
- `needsTranslation` — emoji-only, punctuation-only, empty string, whitespace, ordinary text
- `detectScript` — Burmese, Arabic, Thai, CJK, Latin, mixed-script text
- `formatAdminReply` — separator placement, empty translation

Manual verification through `npm run dev` against the live database: backlog translates,
a reply posts and appears in the consumer app, a delete removes replies and cached
translations.

## Known risks

**`isAdmin` compatibility — verify before relying on it.** The consumer app must tolerate
an unknown field on a reply. Most clients ignore extra keys, but a strict deserializer
(a Kotlin data class without `@JsonIgnoreProperties`, a Flutter model with a strict
`fromJson`) could throw on it. Confirm against the app's source, or post one test reply
and open the app, before depending on the flag.

**Translation quality is unverifiable by the admin.** Nothing in the dashboard can tell a
good Burmese translation from a bad one. The preview-before-post step and keeping the
English original in the posted body are the mitigations; neither is a guarantee.

**Cross-comment prompt injection is reduced, not eliminated.** Translation batches up to 25
comments into one request, so text in one comment can try to steer the model's answer for
another — making an innocent comment appear to say something it doesn't. Replies are checked
against the request (only requested ids, each exactly once), and the prompt marks comment text
as untrusted. But if a hostile comment gets the model to translate a *requested* id wrongly,
nothing downstream can detect it: the admin can't read the original, which is why they need the
translation in the first place. Translating one comment per request would remove the risk at
about 25× the request count. For now the translation is shown as secondary to the original and
labelled as machine output, and it should be treated as a hint, not evidence, before deleting
anything.

## Out of scope

The database is world-readable without authentication — all 274 comments are retrievable
with a plain unauthenticated request. `userName` is unauthenticated free text, so anyone
can post as "Movie Recap" with `isAdmin: true` regardless of what this dashboard does.

This design neither worsens nor fixes that. It is separate work and should be scheduled
as such.
