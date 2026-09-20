# Early Duplicate Warning for the Manual Movie Form

**Date:** 2026-09-20
**Status:** Approved

## Problem

Duplicate detection already exists, but in the manual form it fires too late.
`handleFormSubmit` (app.js:1592) raises a `confirm()` only when the user clicks
Save — by which point the video file has already been uploaded to Firebase
Storage, transcribed by AssemblyAI, enriched from OMDb, and possibly run through
AI thumbnail generation. The warning arrives after all the cost has been paid.

The goal is to surface the same information at the earliest moment it is
knowable, without blocking any workflow.

## Constraint: two different "earliest moments"

`syncMovieData` (app.js:1470) uploads the video as step 1 and only derives the
title in step 4, after transcription. A genuine pre-upload warning is therefore
impossible on the sync path.

| Path | Title known at | Earliest warning |
|---|---|---|
| User types title/year by hand | keystroke | before upload — true pre-upload warning |
| Sync derives title from transcript | after upload + transcription | immediately after metadata lands, still before Save |

Both are earlier than today's Save-time `confirm()`. The sync path still saves
the user from the AI thumbnail step and from the Save round-trip.

## Design

### 1. Data structure

`existingMovieKeys: Set<string>` (app.js:71) becomes
`existingMoviesByKey: Map<string, movie>`, populated in the same Firebase
`onValue` handler (app.js:1773). The key function `buildDuplicateKey`
(app.js:65) is unchanged — normalized title + year, exact match.

The Map, rather than the Set, is what allows the banner to name and link to the
colliding movie.

Call sites to update: app.js:339, app.js:1593, app.js:1773.

### 2. New functions

`findDuplicateMovie(title, year)` — returns the colliding movie object, or
`null`. Excludes the movie currently being edited by comparing against
`editingMovieId`, so editing a movie never flags it against itself.

`refreshDuplicateWarning()` — reads the current `#title` and `#year` input
values, calls `findDuplicateMovie`, and shows or hides the banner accordingly.
Idempotent and safe to call at any time, including when the form is closed.

### 3. Hook points

All of these call `refreshDuplicateWarning()`:

- `input` event on `#title` and `#year`, debounced 200ms — the pre-upload case
- end of `syncMovieData`, immediately after the OMDb block populates the fields
- `openForm()` and `closeForm()` — clears stale banner state between sessions
- the Firebase `onValue` listener, when the form is open — the library can
  change underneath an open form

### 4. Banner

New element `#duplicate-warning`, placed under the title field's `.form-group`
in index.html:239. Hidden by default via the existing `hidden` class.

Contents: the existing movie's thumbnail, its title and year, and two actions.

- **Open existing** — loads the colliding movie into the form via
  `openForm(movie)`. Because this discards any in-progress upload, it asks for
  confirmation first when a video file or uploaded video URL is present.
- **Dismiss** — hides the banner for the current collision. Dismissal is keyed
  to the duplicate key that was dismissed, so the banner stays hidden while the
  title and year are unchanged, and reappears if the user edits the fields into
  a different collision.

There is no *Save anyway* action: nothing is blocked, so saving is simply the
existing Save button.

Styling is new. There is no alert or banner CSS in style.css to reuse; the
banner is built on the existing `--color-warning` token (style.css:13) and
follows the surrounding form styling.

### 5. Save-time fallback

The `confirm()` at app.js:1592 is retained, but narrowed. A module-level
`warnedDuplicateKey` records the duplicate key the banner was last shown for,
set by `refreshDuplicateWarning()` and cleared by `openForm()` and
`closeForm()`. At Save, the `confirm()` fires only when the key being saved does
not match `warnedDuplicateKey` — that is, only when the banner never surfaced
this particular collision. In the normal flow the
user has already seen the banner, so Save proceeds without a second prompt. If a
title reaches the field through a path not covered by the hook points above, the
old guard still catches it rather than silently writing a duplicate.

### 6. Scope

In scope: the manual movie form only.

Out of scope, explicitly:
- the MP4 batch queue and the bulk YouTube queue keep their current behavior
- matching stays exact; no fuzzy or near-match title comparison
- no change to `buildDuplicateKey` or to how a blank year is handled (it
  normalizes to `N/A`, and two blank-year entries with the same title still
  collide, as today)

## Error handling

`refreshDuplicateWarning()` treats an empty title as "no duplicate" and hides
the banner. A missing `#duplicate-warning` element is a no-op rather than a
thrown error, matching the defensive `?.` style used elsewhere in app.js. The
Firebase listener already handles a null snapshot; the Map is rebuilt empty in
that case.

## Verification

This project has no test framework — package.json defines no test script — so
verification is by driving the running app at localhost:3000:

1. Type the title and year of a movie already in the library. The banner appears
   before any upload and names the correct movie.
2. Click **Open existing**. The colliding movie loads into the form for editing.
3. Open an existing movie for editing. No banner appears for its own title.
4. Clear the title field. The banner disappears.
5. Run the Sync path on a video whose movie already exists. The banner appears
   once metadata lands, before Save.
6. Save a movie that triggered the banner. No second `confirm()` appears.
