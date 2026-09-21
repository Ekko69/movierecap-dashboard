# Pre-flight Duplicate Check by YouTube URL

**Date:** 2026-09-21
**Status:** Approved

## Problem

Duplicate detection exists but always fires too late to save any work.

The bulk YouTube import sets `item.wasDuplicate` in `enrichAndSave` (app.js:439)
by normalized title and year. That check runs at the save step — after the video
has been fetched, downloaded, uploaded to Firebase Storage, transcribed by
AssemblyAI, and enriched from OMDb. And it is advisory: the row still saves. The
flag surfaces only as a queue tag (bulk-youtube.js:210) and a count in the
completion toast (bulk-youtube.js:415).

So re-importing a spreadsheet, or pasting a URL already in the library, costs the
entire pipeline before anything is said about it.

Until yesterday a cheaper check was impossible: the title is not known until the
transcript exists, and nothing identified the *source*. The `sourceURL` field
added with the last-added panel changes that. A video id is known before a single
byte moves, and it identifies a recap far more reliably than an AI-extracted
title does.

## Goal

Detect the duplicate from the YouTube URL alone, before any fetch, download or
upload, and refuse to import it.

## Design

### 1. The index

`existingMoviesByVideoId: Map<videoId, movie>` is built in the same Firebase
`onValue` handler (app.js:2049) that already rebuilds `existingMoviesByKey`,
from each movie's stored `sourceURL`. Movies without one are simply absent.

Derived, not stored — the same choice the last-added panel made, for the same
reasons: no second source of truth, no cleanup on delete, correct on every
device, and free to keep current.

Alternatives rejected:

- **Query Firebase per check** (`orderByChild('sourceURL').equalTo(...)`).
  Requires a `.indexOn` rule and a network round-trip per keystroke, to answer
  something already in memory.
- **Reuse `existingMoviesByKey`** (title + year). Cannot work pre-flight: the
  title is not known until after transcription, which is precisely the cost this
  feature exists to avoid.

Two lookups wrap it, because the form and the bulk importer need different
contracts:

| Function | Contract |
|---|---|
| `findMovieByVideoId(videoId)` | Exempts the movie currently being edited, mirroring `findDuplicateMovie(title, year)`. Used by the three form entry points, so re-fetching a movie's own URL while editing it is not blocked |
| `findImportedMovieByVideoId(videoId)` | No exemption. Used by the bulk importer |

The split is load-bearing. The Bulk YouTube tab lives *inside* the movie form and
`setSourceMode` has no `editingMovieId` guard, so a bulk run can start with a
movie still open for editing. Sharing the exempting lookup would let that one
movie be re-imported in full — the exact outcome this feature exists to prevent,
on the most expensive path.

### 2. Where the check fires

| Path | Insertion point | Cost of a duplicate |
|---|---|---|
| Bulk Excel import | `processBulkItem` (bulk-youtube.js:358), before `withDownloadSlot` | zero |
| YouTube URL — Fetch Info | the `fetch-youtube-btn` click handler | zero |
| YouTube URL — Download Video | the `download-youtube-btn` click handler | zero |
| YouTube URL — Auto-run | inside the `#youtube-url` input debounce, before `runAutoPipeline` | zero |

The three single-form entry points share one guard so the rule cannot drift
between them. Local MP4 uploads are untouched: they have no URL to check.

`bulk-youtube.js` receives `findMovieByVideoId` through the existing
`initBulkYoutube` dependency object (bulk-youtube.js:25), the same way it already
receives `extractYouTubeVideoId`.

### 3. A second banner, deliberately

The existing `#duplicate-warning` banner is **not** reused. `refreshDuplicateWarning`
(app.js:1157) re-runs on every Firebase update and calls `hideDuplicateWarning()`
whenever the current title and year do not match anything. A URL-triggered warning
routed through it would be erased by the next unrelated `onValue` tick.

Rather than thread a second trigger reason through a state machine that already
juggles `warnedDuplicateKey`, `dismissedDuplicateKey` and
`duplicateWarningSuppressed`, this adds an independent `#source-duplicate-warning`
element with its own small state.

It is placed inside `#youtube-input-section` (index.html:103), directly under the
URL input — where the offending URL is — rather than down in the metadata section
where the title/year banner lives. It reuses the `.duplicate-warning` CSS family,
so it needs no new styling beyond a placement rule.

Contents: the existing movie's thumbnail, its title and year, when it was added,
and two actions.

| Action | Behaviour |
|---|---|
| Open existing | `openForm(match)`, behind `confirmLeavingFormForMovie()` — shared with the title/year banner, so neither can drift from the other's guards |
| Import anyway | Records the video id the banner was **raised for** in `overriddenVideoId` and hides the banner |

Two details the guards exist for:

- **The override remembers the id it warned about**, not whatever is in the URL
  field when the button is clicked. The field can be edited after the banner
  appears, and exempting an id the user was never warned about would let a
  different duplicate straight through. An `input` listener also hides the banner
  as soon as the URL changes, so a stale banner can never be acted on.
- **Opening the existing movie is guarded.** `openForm` runs `resetMediaInputs()`,
  which clears `currentSourceURL` and mutates `editingMovieId`. Doing that during
  an in-flight save would make the movie being saved land with no `sourceURL` —
  permanently invisible to this very index — so the shared guard refuses while
  `isSavingMovie`, and confirms before discarding a video already in the form.

The override exists because re-importing deliberately is legitimate — redoing a
botched import should not require deleting the existing record first. It cannot
silently disable the check: `overriddenVideoId` holds exactly one id, so
overriding a second video replaces the first, and `resetMediaInputs` clears it
when the form opens or closes. The form handles one video at a time, so a single
slot is sufficient and there is never a growing set of exemptions.

### 4. Bulk behaviour

A matching row never enters the pipeline. It takes a new `skipped` status, is
rendered with the reason and the colliding movie's title, and is counted
separately:

```
Bulk import complete: 12 imported, 0 failed, 3 skipped as duplicates.
```

No `movieId` is minted, nothing is written to Firebase or Storage, and no
download slot is consumed. `skipped` is distinct from `failed` — nothing went
wrong.

**`runQueue` has to cooperate.** It wraps each worker and, on resolve, sets
`item.status = 'completed'` unconditionally. A worker that settles its own status
and returns normally — which is exactly what the skip does — would have that
status overwritten, so a skipped row would render a green "Completed" badge above
its own "Already imported as ..." line, and the skipped count would always be
zero while `imported` overcounted. `runQueue` therefore only claims completion
when the worker has not already marked the item `skipped`. `runQueue` is shared
with the local-file batch path, which never sets that status, so the guard is
inert there.

The existing post-transcription `wasDuplicate` title/year flag stays exactly as
it is. It remains the only thing that can catch a collision with a movie that has
no `sourceURL`.

### 5. Known gap

Matching is by video id, which only exists on movies imported after `sourceURL`
shipped (2026-09-20). Older records have no `sourceURL` and cannot be matched
this way; the video id was never recorded, so no backfill is possible.

Those collisions still reach the existing title/year check, which fires after
transcription — the old behaviour, unchanged. The gap closes on its own as the
library turns over.

### 6. Testing

`videoIdFromSourceURL(sourceURL)` is extracted as a pure function in
`last-added.js` and covered by `node --test`. `youtubeThumbnailURL`
(last-added.js:21) currently parses the same id inline and is refactored to call
it, so the parsing rule lives in exactly one place.

The guard wiring, the banner and the bulk skip need a live Firebase connection
and are verified manually against `npm run dev`:

1. Import a YouTube URL. Paste the same URL again — the banner appears before any
   fetch or download, and the Download button does nothing.
2. Click **Import anyway** on that banner, then download — it proceeds normally.
3. Click **Open existing** — the existing movie opens in the form.
4. Paste a URL that is *not* in the library — no banner, normal flow.
5. With Auto-run enabled, paste a duplicate URL — the pipeline must not start.
6. Bulk-import a sheet containing one already-imported video and two new ones —
   the duplicate shows as skipped without downloading, the other two import, and
   the toast reads `2 imported, 0 failed, 1 skipped as duplicates`.
7. Bulk-import a sheet whose rows are all duplicates — nothing downloads at all.
8. Check a movie added *before* 2026-09-20 (no `sourceURL`): pasting its YouTube
   URL correctly shows no pre-flight banner, and the old title/year warning still
   appears once the title is known.
