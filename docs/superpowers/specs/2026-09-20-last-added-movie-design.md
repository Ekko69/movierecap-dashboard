# Last Added Movie Panel

**Date:** 2026-09-20
**Status:** Approved

## Problem

The dashboard gives no stable answer to "which movie did I finish last?". The
information exists — sorting by "Latest Added" puts it first — but that view is
destroyed by any search, category filter, alternate sort, or page change. The
user works through a source list of recaps across sessions and needs a fixed
marker for where the previous upload ended, so the next one can start from the
right place.

A second gap compounds it: the YouTube link a recap came from is never
persisted. `extractYouTubeVideoId` (app.js:2230) derives a videoId, the import
pipeline consumes it, and it is discarded at save time. The movie record keeps
`videoURL` — the Firebase Storage copy of the uploaded file — which says nothing
about where the recap originated. So even finding the last movie does not tell
the user where in the source list they stopped.

## Scope

In scope: a pinned last-added panel on the dashboard, and a new `sourceURL`
field written on every add path that has one.

Explicitly out of scope: a pre-flight duplicate check for the bulk YouTube
import. See "Follow-on work".

## Design

### 1. Determining "last added"

Derived from existing data. No new pointer, no new storage for this.

`updatedAt` is stamped only when a movie is created, never on edit — app.js:1789
makes this deliberate:

```js
if (!editingMovieId) {
    movieData.updatedAt = Date.now();
}
```

Therefore `max(updatedAt)` over `allMovies` *is* the most recently added movie.
The `onValue` listener at app.js:1882 already holds the full list in memory, so
the panel is a pure render over state that is already there.

Alternatives rejected:

- **An explicit `lastAdded` node in Firebase.** Creates a second source of
  truth, needs writes in three code paths, and needs cleanup in `confirmDelete`
  or it pins a card to a deleted movie. Its only advantage — surviving deletion
  of the movie — is a liability here.
- **A localStorage snapshot.** Per-browser. Wrong on a second device and lost
  when site data is cleared.

Deriving self-heals: deleting the last added movie makes the panel fall back to
the one before it with no extra code.

### 2. Schema change: `sourceURL`

One new optional field on `movies/{id}`:

```
sourceURL: "https://www.youtube.com/watch?v=abc123"
```

Omitted when there is no source. Firebase RTDB drops null values on write, so
assigning `null` simply leaves the key absent — consistent with how
`featuredThumbnail: item.posterUrl || null` already behaves in `enrichAndSave`.

Written on each add path:

| Path | Value | Location |
|---|---|---|
| Single form / auto-run | `#youtube-url` input, normalized | `handleFormSubmit`, app.js:1694 |
| Bulk YouTube (Excel) | canonical URL built from `item.videoId` | `bulk-youtube.js` sets `item.sourceURL`; `enrichAndSave` writes it |
| Batch upload (local MP4s) | none — field omitted | `enrichAndSave`, app.js:360 |

`enrichAndSave` is shared by the batch-upload and bulk-YouTube paths, so it
reads `item.sourceURL || null` and only the bulk path populates it. That is a
single-line change covering both.

Normalization goes through the existing `extractYouTubeVideoId` (app.js:2230)
and rebuilds a canonical `https://www.youtube.com/watch?v=<id>` URL, so a pasted
link carrying playlist or timestamp parameters is stored clean. A pasted string
that yields no videoId stores no `sourceURL`.

**Existing movies cannot be backfilled** — the source link was never recorded
and is not recoverable. The panel treats a missing `sourceURL` as a normal
state, not an error.

### 3. Panel markup

Mirrors the duplicate-warning banner (index.html:240-250) so it inherits the
established visual language: thumb, body, label, actions.

```html
<!-- between the form panel </section> and <section class="content-body"> -->
<section id="last-added" class="last-added hidden">
  <img id="last-added-thumb" class="last-added-thumb" alt="">
  <div class="last-added-body">
    <span class="last-added-label">&#9201; Last added</span>
    <span id="last-added-title"></span>
    <span id="last-added-meta"></span>
    <p id="last-added-desc" class="last-added-desc"></p>
    <a id="last-added-source" class="last-added-source" target="_blank" rel="noopener"></a>
    <div class="last-added-actions">
      <button type="button" id="last-added-edit" class="btn btn-sm btn-secondary">Edit</button>
      <button type="button" id="last-added-copy" class="btn btn-sm btn-ghost">Copy link</button>
    </div>
  </div>
</section>
```

It sits outside `.content-body`, above `.filter-bar`, so no search, filter, sort
or pagination state can affect it.

Rendered fields: thumbnail, title, year, duration, relative added-time,
description, source link.

The meta line reads `<year> \u00b7 <duration> \u00b7 added <relative time>`, reusing the
existing `formatDuration` (app.js:223) for duration. Relative time is rendered
by a small new helper with a fixed vocabulary: `just now` (< 60s), `N min ago`
(< 60m), `N hr ago` (< 24h), `N days ago` (< 7d), and the absolute date beyond
that. It is derived from `updatedAt` at render time, so it refreshes whenever
the listener refires.

Two deliberate choices:

- **`textContent`, never `innerHTML`.** `createMovieCard` (app.js:1960)
  interpolates movie fields directly into an `innerHTML` template, so
  AI-extracted titles and descriptions land unescaped. The duplicate banner
  already avoids this. The new panel follows the banner, not the card.
- **Thumbnail passes through `isSafeThumbnailSrc`** (app.js:127), matching
  every other thumbnail render in the app.

Buttons use `btn btn-sm btn-secondary` and `btn btn-ghost` — both confirmed
present in style.css. (A prior commit, 4d16316, had to fix a banner button that
referenced an undefined class; this spec avoids repeating that.)

### 4. Data flow

One new function, `renderLastAdded()`, called from the existing `onValue`
listener at app.js:1882, immediately after `existingMoviesByKey` is rebuilt —
the same point at which the duplicate banner already refreshes.

```
onValue(moviesRef) -> allMovies
                   -> existingMoviesByKey rebuild   (existing)
                   -> applyFiltersAndRender()       (existing)
                   -> renderLastAdded()             (new)
```

No new listener and no new subscription. Because it hangs off the realtime
listener, the panel updates the moment any save lands — including saves made by
the batch and bulk pipelines — with no wiring in either of those paths.

Actions:

- **Edit** calls the existing `openForm(movie)` with the resolved movie object.
- **Copy link** writes `sourceURL` to the clipboard and reports via the existing
  `showToast`.

`renderLastAdded` is the only unit that needs to know the panel exists. It takes
`allMovies` from module state and writes to fixed DOM nodes; nothing else reads
or writes the panel.

### 5. Edge cases

| Case | Behavior |
|---|---|
| No movies at all | Panel stays `.hidden`; dashboard is unchanged from today |
| Every movie predates `updatedAt` (all `0`) | Reduce still returns one movie; it renders. Acceptable — those records are genuinely old |
| Winner has no `sourceURL` | Source link and Copy button hidden; the rest renders |
| Winner has no `thumbnail` | Falls back to `assets/img/app-icon.png`, matching the cards |
| Last added movie is deleted | `onValue` refires; panel falls back to the previous movie |
| Long AI description | Clamped to two lines in CSS |
| Clipboard API unavailable or denied | Toast reports the failure; the visible link remains selectable |

### 6. Testing

This repo has no test infrastructure — `package.json` defines no test script and
there are no test files. Introducing a runner is a decision larger than this
feature, so it is not bundled in. Verification is manual against `npm run dev`,
and these checks belong in the implementation plan:

1. Add a movie through the form with a YouTube URL. Panel appears with a working
   source link; the link opens the right video.
2. Paste a URL carrying `&list=` and `&t=` parameters. Stored `sourceURL` is the
   canonical watch URL.
3. Run a two-file batch upload of local MP4s. Panel shows the later of the two,
   with no source link and no Copy button.
4. Run a bulk YouTube import. Panel shows the last imported row, with its source
   link.
5. Edit an existing movie. Panel does **not** change — editing is not adding,
   and `updatedAt` is untouched.
6. Delete the last added movie. Panel falls back to the previous one.
7. Load against an empty database. Panel is hidden.
8. Search, change category, change sort, page forward. Panel is unaffected
   throughout.

## Follow-on work

Once `sourceURL` has been written for a while, the bulk YouTube import can check
a row's videoId against the library **at queue time**, before any download,
upload, transcription or OMDb call.

Today that path only sets `item.wasDuplicate` in `enrichAndSave` (app.js:430),
by normalized title and year, at the save step — after the entire pipeline has
run. It is advisory: the row still saves, and the flag surfaces only as a queue
tag (bulk-youtube.js:208) and a count in the completion toast
(bulk-youtube.js:411). Matching on videoId up front would turn that into a real
skip, and would also catch re-imports whose AI-extracted title differs from the
stored one.

This needs its own spec. It is worthless until `sourceURL` exists on a
meaningful number of records.
