# Bulk YouTube Import via Excel — Design

**Date:** 2026-08-07
**Status:** Approved
**Branch:** thumbnail-generator

## Goal

Let the user import many movies at once by uploading an Excel (or CSV) file containing
YouTube URLs. Each video runs through the same processing pipeline the existing MP4 batch
upload uses. A failure on one video must not stop the rest.

## Constraint: local-only

`/api/youtube-info` and `/api/youtube-download` both return HTTP 501 when `process.env.VERCEL`
is set, because yt-dlp needs a local Python install. Bulk import therefore works only under
`npm run dev`. The UI states this inline; it is not a bug to fix here.

## User flow

1. Open **Add New Movie**.
2. Pick the third source tab, **📊 Bulk YouTube**.
3. Choose an `.xlsx` / `.xls` / `.csv` file. The panel reports `Found N URLs`.
4. Pick a download quality (applies to all rows).
5. Press **Start Import**. Rows process with live per-item status.
6. On finish, a toast and the existing batch-complete modal report counts.
7. **Retry Failed** re-queues only the failed rows.

Selecting the Bulk YouTube tab hides the video drop zone, the single-URL section, the Movie
Details fieldset, and the Save button — bulk rows write directly to the database, so those
controls would be misleading.

## Architecture

### New file: `bulk-youtube.js`

`app.js` is already 2203 lines. All bulk-specific logic lives in a new module: Excel parsing,
queue state, queue rendering, and the per-item worker. It never reaches into `app.js`
internals; `app.js` injects the pipeline stages it needs.

```js
// bulk-youtube.js
export function initBulkYoutube(deps);
```

`deps` — every function already exists in `app.js` or is extracted there by this change:

| Dep | Signature | Purpose |
|---|---|---|
| `extractYouTubeVideoId` | `(url) => string \| null` | existing, app.js:2035 |
| `uploadItemVideo` | `(movieId, file) => Promise<string>` | extracted (see below) |
| `uploadThumbnailBlob` | `(movieId, blob, name) => Promise<string>` | extracted |
| `enrichAndSave` | `(item) => Promise<void>` | extracted |
| `runQueue` | `(items, worker, concurrency, onUpdate) => Promise<void>` | extracted |
| `formatDuration` | `(seconds) => string` | existing, app.js:215 |
| `isDuplicate` | `(title, year) => boolean` | new thin wrapper over `buildDuplicateKey` + `existingMovieKeys` |
| `showToast` | `(message) => void` | existing, app.js:222 |
| `showBatchCompleteModal` | `(completed, failed) => void` | existing, app.js:236 |

### Refactor in `app.js`

`processBatchItem()` (app.js:316-438) currently inlines six stages. Extract the four reusable
ones. **Existing MP4 batch behavior must not change.**

| Extracted function | Body taken from | Used by |
|---|---|---|
| `uploadItemVideo(movieId, file)` | app.js:320-322 | MP4 batch, bulk |
| `uploadThumbnailBlob(movieId, blob, name)` | app.js:376-378 | MP4 batch, bulk |
| `enrichAndSave(item)` | app.js:384-437 (transcribe → AI metadata → OMDb → save) | MP4 batch, bulk |
| `runQueue(items, worker, concurrency, onUpdate)` | app.js:260-313 (the promise/slot runner inside `processBatch`) | MP4 batch, bulk |

After the refactor:

- `processBatchItem` = `uploadItemVideo` → capture random video frame → `uploadThumbnailBlob` → `enrichAndSave`
- `processBulkItem` = fetch info → download → `uploadItemVideo` → proxy YouTube thumb → `uploadThumbnailBlob` → `enrichAndSave`

`processBatch()` becomes a thin caller of `runQueue` that keeps its own `batchProcessing`
flag, finalize toast, and `updateBatchUI` callback.

`enrichAndSave` reads `item.duration`, `item.videoUrl`, `item.thumbnailURL`, `item.movieId`
and writes `item.metadata`, `item.omdb`, `item.posterUrl`. It saves this record shape,
unchanged from today:

```js
{ id, title, year, description, categories, duration,
  thumbnail, videoURL, featuredThumbnail, updatedAt }
```

## Per-item pipeline

```
[fetching-info]        GET /api/youtube-info?videoId=…
                       → title, duration (seconds), thumbnail URL
[downloading]          GET /api/youtube-download?videoId=…&quality=…
                       → stream chunks → Blob → File(`${title}.mp4`, video/mp4)
[uploading]            uploadItemVideo → videos/${movieId}.mp4
[uploading-thumbnail]  GET /api/proxy-image?url=<yt thumbnail>
                       → Blob → uploadThumbnailBlob → thumbnails/${movieId}/yt-thumb.jpg
[transcribing]         ─┐
[extracting-metadata]   ├ enrichAndSave
[omdb]                  │
[saving]               ─┘
[completed]
```

Duration comes from `youtube-info`'s `duration` field run through `formatDuration()`. Bulk
rows never create a `<video>` element to probe metadata — unlike the MP4 batch path, which
still must.

### Concurrency

Two items in flight, but a **download semaphore of size 1** wraps the `fetching-info` +
`downloading` stages, so only one yt-dlp process runs at a time. Item B downloads while item
A transcribes. This avoids YouTube throttling without halving throughput.

The semaphore is a local promise chain in `bulk-youtube.js`; no shared state with the MP4
batch queue.

## Excel parsing

SheetJS is loaded by dynamic `import()` on first file selection, so normal page loads pay
nothing for it. This matches the project's existing CDN-ESM style (Firebase is imported the
same way) and needs no build step.

```js
const XLSX = await import('https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs');
const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
```

Detection rules:

- Scan **every sheet** in the workbook.
- For each cell, test both the displayed text and the hyperlink target (`cell.l?.Target`), so
  a cell reading "Watch" that links to YouTube is picked up.
- Run the existing `extractYouTubeVideoId()` on each candidate string. Only full YouTube URL
  forms match — bare 11-character IDs are ignored, as they produce false positives on ordinary
  text.
- Dedupe by video ID; preserve first-seen order.

No header row and no particular column order are required.

`.csv` and `.xls` go through the identical code path — SheetJS reads all three.

## Failure handling

Per-item `try/catch` inside the worker. On throw: status `failed`, `item.error` set to the
message, queue continues — the same isolation `processBatch` already provides.

**Retry Failed** resets every `failed` row to `queued` and re-runs `runQueue`. Completed rows
are untouched.

### Duplicates

A row whose resolved title+year already exists in `existingMovieKeys` is **still imported**.
It is not skipped and not failed. The queue row gets a `⚠ duplicate` tag beside the title so
it can be found and removed afterward, and the completion toast appends
`(N possible duplicates)` when any were seen.

The check runs *after* metadata resolves — YouTube titles are too clickbait-laden to match
reliably before AI/OMDb normalization.

### Error messages surfaced to the user

| Condition | Message |
|---|---|
| SheetJS CDN import fails | `Could not load the Excel reader. Check your internet connection.` |
| File parsed, zero URLs | `No YouTube URLs found in that file.` |
| `youtube-info` / `youtube-download` returns 501 | The API's own text, which already says local-dev-only |
| Any other per-item throw | The error's `message` |

## New statuses

Added to `STATUS_LABELS` (app.js:133):

```js
'fetching-info': 'Fetching info',
downloading:     'Downloading',
```

`getStatusInfo()` categorizes both as `processing`, requiring no change to its logic.

## Markup — `index.html`

A third tab button beside the existing two (index.html:91-94):

```html
<button type="button" id="source-bulk-btn" class="source-tab">📊 Bulk YouTube</button>
```

And a sibling panel after `#youtube-input-section` (index.html:126):

```
#bulk-youtube-section          .hidden by default
  .bulk-hint                   local-dev-only notice
  input#bulk-excel-file        accept=".xlsx,.xls,.csv"
  select#bulk-quality          360p / 480p / 720p / 1080p
  #bulk-found-count            "Found 12 URLs"
  ul#bulk-queue                .batch-list
  #bulk-progress               .batch-progress > #bulk-progress-bar
  button#bulk-start-btn        "Start Import"
  button#bulk-retry-btn        "Retry Failed"   (disabled unless failures exist)
  button#bulk-clear-btn        "Clear"
```

Queue rows reuse the existing `.batch-item`, `.batch-item-thumb`, `.batch-item-details`,
`.batch-item-status`, `.status-badge`, and `.batch-item-error` classes from `style.css`, so
new CSS is limited to the panel's own layout and the `⚠ duplicate` tag.

## Tab switching and guards

The three source tabs become a single mutually-exclusive group. Selecting Bulk YouTube adds
`.hidden` to `#video-drop-zone`, `#youtube-input-section`, and `#metadata-section`; leaving it
restores them.

`div.form-section.metadata-section` (index.html:197) currently has no id — add
`id="metadata-section"`. It encloses `div.form-footer` (index.html:318-329), so hiding it also
hides Cancel and **Upload & Save**, which is intended: bulk rows save themselves. The modal's
top-right `×` remains the way out.

While `bulkProcessing` is true, block: the close button, the overlay click, the Escape key,
tab switching, Start, and Clear. `resetMediaInputs()` (app.js:1020) clears bulk queue state
and resets the tab group to Upload File.

## Verification

The project has no test framework, so verification is a manual run.

1. `npm run dev`
2. Generate a 3-row sample `.xlsx`: two valid YouTube URLs and one deliberately unavailable
   video ID, spread across different columns with an unrelated header row.
3. Import it. Expect: 2 completed, 1 failed with a readable message, and the queue visibly
   continuing past the failure.
4. Confirm both saved movies appear in the dashboard with a YouTube thumbnail, a duration,
   and OMDb-derived title/year.
5. Press **Retry Failed**; confirm it re-attempts only the failed row.
6. Re-import the same file; confirm the two rows import again and show the `⚠ duplicate` tag.

## Out of scope

- Making YouTube download work on Vercel (needs yt-dlp/Python on the server).
- Per-row title or quality overrides from extra Excel columns.
- AI thumbnail generation for bulk rows — bulk always uses the plain YouTube thumbnail,
  regardless of the ✨ Auto AI Thumbnail toggle.
- Subtitle generation and upload for bulk rows, matching the existing MP4 batch, which also
  skips it.
