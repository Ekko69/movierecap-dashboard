# Pre-flight Duplicate Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recognise an already-imported YouTube video from its URL alone and refuse to import it again, before any fetch, download or upload happens.

**Architecture:** A `Map` from video id to movie is derived in the existing Firebase `onValue` handler from each movie's stored `sourceURL` — no new storage, no network per check. Four entry points consult it: the bulk import loop, and the form's Fetch Info / Download / Auto-run paths. Bulk rows skip outright; the form shows a blocking banner with a deliberate override.

**Tech Stack:** Vanilla ES modules in the browser, Firebase Realtime Database, Node's built-in test runner. No build step, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-21-preflight-duplicate-check-design.md`

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `last-added.js` | Modify | Gains `videoIdFromSourceURL`; `youtubeThumbnailURL` refactored onto it |
| `last-added.test.js` | Modify | Tests for the new pure function |
| `app.js` | Modify | The index, `findMovieByVideoId`, the form guard, the banner, the bulk dep |
| `index.html` | Modify | `#source-duplicate-warning` markup |
| `style.css` | Modify | Banner placement rule, `.status-badge.skipped` |
| `bulk-youtube.js` | Modify | Pre-flight skip, `skipped` status, summary and progress accounting |

### Gotchas found while planning — read before starting

1. **The progress bar will stick below 100% unless you fix it.** `renderQueue` computes `(completed + failed) / queue.length` (bulk-youtube.js:258-260). Skipped rows must be counted or a run containing any duplicate never shows as finished. Task 6 handles this; do not skip that step.
2. **`.status-badge.skipped` does not exist.** `style.css` defines only `queued`, `processing`, `completed`, `failed` (style.css:503-522). An unstyled badge renders as bare text. Task 7 adds it.
3. **`statusCategory` needs a `skipped` branch** (bulk-youtube.js:170) or skipped rows fall through to `processing` and show a blue "in progress" badge forever.
4. **Retry must not pick up skipped rows.** The retry handler filters `item.status !== 'failed'` (bulk-youtube.js:52), so skipped rows are already excluded. Do not "helpfully" widen it.
5. **Do not touch the existing `wasDuplicate` title/year check** (app.js:439). It is now the only thing covering movies added before `sourceURL` existed.
6. **Do not route the new warning through `refreshDuplicateWarning`.** It calls `hideDuplicateWarning()` whenever title/year do not match, and it re-runs on every Firebase update — it would erase a URL-triggered warning.

---

## Task 1: `videoIdFromSourceURL`

Extract the id-parsing rule into one tested place. `youtubeThumbnailURL` currently inlines the same regex.

**Files:**
- Modify: `last-added.js`
- Modify: `last-added.test.js`

- [ ] **Step 1: Write the failing test**

In `last-added.test.js`, add `videoIdFromSourceURL` to the existing import from `./last-added.js`, then append:

```js
test('videoIdFromSourceURL reads the id out of a stored source URL', () => {
    assert.equal(
        videoIdFromSourceURL('https://www.youtube.com/watch?v=trjp0T-eW6Q'),
        'trjp0T-eW6Q'
    );
});

test('videoIdFromSourceURL ignores trailing parameters', () => {
    assert.equal(
        videoIdFromSourceURL('https://www.youtube.com/watch?v=trjp0T-eW6Q&t=42s'),
        'trjp0T-eW6Q'
    );
});

test('videoIdFromSourceURL accepts the no-www form', () => {
    assert.equal(
        videoIdFromSourceURL('https://youtube.com/watch?v=trjp0T-eW6Q'),
        'trjp0T-eW6Q'
    );
});

test('videoIdFromSourceURL returns null for anything else', () => {
    assert.equal(videoIdFromSourceURL(null), null);
    assert.equal(videoIdFromSourceURL(''), null);
    assert.equal(videoIdFromSourceURL(undefined), null);
    assert.equal(videoIdFromSourceURL('https://firebasestorage.googleapis.com/x.mp4'), null);
    assert.equal(videoIdFromSourceURL('http://www.youtube.com/watch?v=trjp0T-eW6Q'), null);
});
```

The last assertion is deliberate: only `https` is accepted, matching what the write paths produce.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — no export named `videoIdFromSourceURL`.

- [ ] **Step 3: Add the function and refactor `youtubeThumbnailURL` onto it**

In `last-added.js`, replace this entire existing block:

```js
// The video's own thumbnail on YouTube, derived from a stored sourceURL.
//
// mqdefault rather than maxresdefault: maxres is absent for a great many videos
// and would 404 into a broken image, while mqdefault always exists and is
// natively 16:9 (hqdefault is 4:3 and arrives letterboxed). At 320x180 it is
// ample for the panel's 120x68 slot, even on a 2x display.
//
// Anchored to https so the result is safe to hand straight to an <img src>.
export function youtubeThumbnailURL(sourceURL) {
    if (!sourceURL) return null;
    const match = String(sourceURL).match(
        /^https:\/\/(?:www\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/
    );
    if (!match) return null;
    return `https://i.ytimg.com/vi/${match[1]}/mqdefault.jpg`;
}
```

with:

```js
// The video id inside a stored sourceURL, or null if there isn't one.
//
// Anchored to https and to the canonical watch shape the write paths produce.
// Everything downstream — an <img src>, an <a href>, a duplicate lookup key —
// trusts this to have rejected anything else.
export function videoIdFromSourceURL(sourceURL) {
    if (!sourceURL) return null;
    const match = String(sourceURL).match(
        /^https:\/\/(?:www\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/
    );
    return match ? match[1] : null;
}

// The video's own thumbnail on YouTube, derived from a stored sourceURL.
//
// mqdefault rather than maxresdefault: maxres is absent for a great many videos
// and would 404 into a broken image, while mqdefault always exists and is
// natively 16:9 (hqdefault is 4:3 and arrives letterboxed). At 320x180 it is
// ample for the panel's 120x68 slot, even on a 2x display.
export function youtubeThumbnailURL(sourceURL) {
    const videoId = videoIdFromSourceURL(sourceURL);
    if (!videoId) return null;
    return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS — 21 tests (17 existing + 4 new), 0 failing. The four pre-existing `youtubeThumbnailURL` tests must still pass; that is what proves the refactor is behaviour-preserving.

- [ ] **Step 5: Commit**

```bash
git add last-added.js last-added.test.js
git commit -m "refactor: extract videoIdFromSourceURL as one parsing rule"
```

---

## Task 2: The video id index

**Files:**
- Modify: `app.js`

- [ ] **Step 1: Import the new helper**

Change the existing import block:

```js
import {
    youtubeWatchURL,
    youtubeThumbnailURL,
    formatRelativeTime,
    pickLastAdded
} from './last-added.js';
```

to:

```js
import {
    youtubeWatchURL,
    youtubeThumbnailURL,
    videoIdFromSourceURL,
    formatRelativeTime,
    pickLastAdded
} from './last-added.js';
```

- [ ] **Step 2: Declare the index beside the existing one**

Find:

```js
let existingMoviesByKey = new Map();
```

Add directly below it:

```js
// Video id -> movie, for recognising an already-imported YouTube video before
// anything is fetched or downloaded. Only movies imported since sourceURL
// shipped appear here; older records have no source to key on.
let existingMoviesByVideoId = new Map();
```

- [ ] **Step 3: Populate it in the Firebase listener**

Find this block inside the `onValue(moviesRef, ...)` handler:

```js
    existingMoviesByKey = new Map(
        allMovies.map((movie) => [buildDuplicateKey(movie.title, movie.year), movie])
    );
```

Add directly below it:

```js
    existingMoviesByVideoId = new Map(
        allMovies
            .map((movie) => [videoIdFromSourceURL(movie.sourceURL), movie])
            .filter(([videoId]) => videoId)
    );
```

- [ ] **Step 4: Add the lookup**

Find the existing function:

```js
// Returns the existing movie that collides with this title/year, or null.
// Never returns the movie currently being edited, so editing a movie does not
// flag it against itself.
function findDuplicateMovie(title, year) {
```

Insert this ABOVE that comment block:

```js
// The already-imported movie for a YouTube video id, or null. Never returns the
// movie currently being edited, matching findDuplicateMovie's contract.
function findMovieByVideoId(videoId) {
    if (!videoId) return null;
    const match = existingMoviesByVideoId.get(videoId);
    if (!match) return null;
    if (editingMovieId && match.id === editingMovieId) return null;
    return match;
}
```

- [ ] **Step 5: Verify**

Run: `node --input-type=module --check < app.js` — expect exit 0.
Run: `npm test` — expect 21 passing.
Run: `grep -n "existingMoviesByVideoId\|findMovieByVideoId" app.js` — expect 4 sites (declaration, population, and the two inside the lookup).

- [ ] **Step 6: Commit**

```bash
git add app.js
git commit -m "feat: index existing movies by their YouTube video id"
```

---

## Task 3: The blocking banner markup and styles

**Files:**
- Modify: `index.html`
- Modify: `style.css`

- [ ] **Step 1: Add the markup**

In `index.html`, find:

```html
                                         <div class="youtube-url-group">
                                             <input type="text" id="youtube-url" placeholder="https://www.youtube.com/watch?v=..." class="youtube-url-input">
                                             <button type="button" id="fetch-youtube-btn" class="btn btn-secondary btn-sm">Fetch Info</button>
                                         </div>
```

Insert directly BELOW that closing `</div>`:

```html
                                         <!-- Fires on the URL alone, before any fetch or download.
                                              Deliberately separate from #duplicate-warning: that one is
                                              driven by title/year and hides itself whenever they stop
                                              matching, which would erase this one. -->
                                         <div id="source-duplicate-warning" class="duplicate-warning source-duplicate-warning hidden">
                                             <img id="source-duplicate-thumb" class="duplicate-warning-thumb" alt="">
                                             <div class="duplicate-warning-body">
                                                 <span class="duplicate-warning-label">⚠ Already imported</span>
                                                 <span id="source-duplicate-text"></span>
                                                 <div class="duplicate-warning-actions">
                                                     <button type="button" id="source-duplicate-open" class="btn btn-sm btn-secondary">Open existing</button>
                                                     <button type="button" id="source-duplicate-override" class="btn btn-sm btn-ghost">Import anyway</button>
                                                 </div>
                                             </div>
                                         </div>
```

- [ ] **Step 2: Add the styles**

Append to `style.css`:

```css
/* --- Pre-flight duplicate warning (YouTube URL) --- */
/* Inherits .duplicate-warning; only the placement differs, since this one sits
   under the URL input rather than in the metadata section. */

.source-duplicate-warning {
    margin-top: 12px;
}

/* Bulk rows skipped before download are not failures — nothing went wrong. */
.status-badge.skipped {
    background: rgba(241, 196, 15, 0.18);
    color: #ffd86b;
}
```

- [ ] **Step 3: Verify**

Run: `grep -n "source-duplicate" index.html` — expect the container plus 5 child elements.
Run: `grep -n "source-duplicate-warning\|status-badge.skipped" style.css` — expect both rules.
Run: `npm test` — expect 21 passing.

- [ ] **Step 4: Commit**

```bash
git add index.html style.css
git commit -m "feat: add pre-flight duplicate warning markup and styles"
```

---

## Task 4: The form guard

**Files:**
- Modify: `app.js`

- [ ] **Step 1: Add the banner state and the guard**

In `app.js`, find the end of the existing duplicate-banner section — the listener:

```js
duplicateWarningOpen?.addEventListener('click', () => {
```

Scroll to the end of that listener's closing `});` and insert the following block after it:

```js
// --- Pre-flight duplicate warning (YouTube URL) ---
// Separate from the title/year banner above on purpose: refreshDuplicateWarning
// hides that one whenever title/year stop matching and re-runs on every Firebase
// update, which would wipe a URL-triggered warning.
const sourceDuplicateWarning = document.getElementById('source-duplicate-warning');
const sourceDuplicateThumb = document.getElementById('source-duplicate-thumb');
const sourceDuplicateText = document.getElementById('source-duplicate-text');
const sourceDuplicateOpen = document.getElementById('source-duplicate-open');
const sourceDuplicateOverride = document.getElementById('source-duplicate-override');

// The movie the banner points at, so "Open existing" knows its target.
let sourceDuplicateMatch = null;
// One video id the user chose to import anyway. A single slot, not a set: the
// form handles one video at a time, so overriding a second replaces the first
// and the exemption can never accumulate.
let overriddenVideoId = null;

function hideSourceDuplicateWarning() {
    sourceDuplicateMatch = null;
    sourceDuplicateWarning?.classList.add('hidden');
}

// True when this video is already in the library and the user has not overridden
// it — in which case the caller must not fetch, download or import.
// Showing the banner is this function's job, so every caller behaves the same.
function blockedAsDuplicate(videoId) {
    if (!videoId || videoId === overriddenVideoId) {
        hideSourceDuplicateWarning();
        return false;
    }

    const match = findMovieByVideoId(videoId);
    if (!match) {
        hideSourceDuplicateWarning();
        return false;
    }

    sourceDuplicateMatch = match;
    sourceDuplicateText.textContent =
        `"${match.title}" (${match.year || 'no year'}) — added ${formatRelativeTime(match.updatedAt, Date.now())}`;

    const thumb = youtubeThumbnailURL(match.sourceURL);
    if (thumb) {
        sourceDuplicateThumb.src = thumb;
        sourceDuplicateThumb.classList.remove('hidden');
    } else {
        sourceDuplicateThumb.removeAttribute('src');
        sourceDuplicateThumb.classList.add('hidden');
    }

    sourceDuplicateWarning.classList.remove('hidden');
    return true;
}

sourceDuplicateOpen?.addEventListener('click', () => {
    if (sourceDuplicateMatch) openForm(sourceDuplicateMatch);
});

sourceDuplicateOverride?.addEventListener('click', () => {
    const videoId = extractYouTubeVideoId(
        document.getElementById('youtube-url')?.value?.trim() || ''
    );
    if (videoId) overriddenVideoId = videoId;
    hideSourceDuplicateWarning();
});
```

- [ ] **Step 2: Clear the banner state when the form resets**

Find in `function resetMediaInputs()`:

```js
    currentSourceURL = null;
```

Change it to:

```js
    currentSourceURL = null;
    overriddenVideoId = null;
    hideSourceDuplicateWarning();
```

- [ ] **Step 3: Guard Fetch Info**

Find:

```js
document.getElementById('fetch-youtube-btn')?.addEventListener('click', () => {
    const url = document.getElementById('youtube-url').value.trim();
    const videoId = extractYouTubeVideoId(url);
    if (!videoId) {
        alert('Please enter a valid YouTube URL.');
        return;
    }
    fetchYouTubeInfo(videoId);
});
```

Change it to:

```js
document.getElementById('fetch-youtube-btn')?.addEventListener('click', () => {
    const url = document.getElementById('youtube-url').value.trim();
    const videoId = extractYouTubeVideoId(url);
    if (!videoId) {
        alert('Please enter a valid YouTube URL.');
        return;
    }
    if (blockedAsDuplicate(videoId)) return;
    fetchYouTubeInfo(videoId);
});
```

- [ ] **Step 4: Guard Download Video**

Find:

```js
document.getElementById('download-youtube-btn')?.addEventListener('click', () => {
    const url = document.getElementById('youtube-url').value.trim();
    const videoId = extractYouTubeVideoId(url);
    if (!videoId) return;
    const quality = document.getElementById('youtube-quality')?.value || '360p';
    downloadYouTubeVideo(videoId, quality);
});
```

Change it to:

```js
document.getElementById('download-youtube-btn')?.addEventListener('click', () => {
    const url = document.getElementById('youtube-url').value.trim();
    const videoId = extractYouTubeVideoId(url);
    if (!videoId) return;
    if (blockedAsDuplicate(videoId)) return;
    const quality = document.getElementById('youtube-quality')?.value || '360p';
    downloadYouTubeVideo(videoId, quality);
});
```

- [ ] **Step 5: Guard Auto-run**

Find:

```js
    clearTimeout(autoRunDebounce);
    autoRunDebounce = setTimeout(() => {
        const url = document.getElementById('youtube-url').value.trim();
        const videoId = extractYouTubeVideoId(url);
        if (!videoId) return;
        const quality = document.getElementById('youtube-quality')?.value || '360p';
        runAutoPipeline(videoId, quality);
    }, 700);
```

Change it to:

```js
    clearTimeout(autoRunDebounce);
    autoRunDebounce = setTimeout(() => {
        const url = document.getElementById('youtube-url').value.trim();
        const videoId = extractYouTubeVideoId(url);
        if (!videoId) return;
        // Auto-run is the most expensive path and needs no click, so silently
        // starting it on a video already in the library is the worst case.
        if (blockedAsDuplicate(videoId)) return;
        const quality = document.getElementById('youtube-quality')?.value || '360p';
        runAutoPipeline(videoId, quality);
    }, 700);
```

- [ ] **Step 6: Verify**

Run: `node --input-type=module --check < app.js` — expect exit 0.
Run: `npm test` — expect 21 passing.
Run: `grep -c "blockedAsDuplicate" app.js` — expect `4` (one definition, three call sites).

- [ ] **Step 7: Commit**

```bash
git add app.js
git commit -m "feat: block importing a YouTube video already in the library"
```

---

## Task 5: Pass the lookup to the bulk module

**Files:**
- Modify: `app.js`

- [ ] **Step 1: Add the dependency**

Find the `initBulkYoutube({ ... })` call and add `findMovieByVideoId,` directly below `extractYouTubeVideoId,`:

```js
initBulkYoutube({
    extractYouTubeVideoId,
    findMovieByVideoId,
    uploadItemVideo,
```

Leave every other entry in that object untouched.

- [ ] **Step 2: Verify**

Run: `node --input-type=module --check < app.js` — expect exit 0.
Run: `grep -n "findMovieByVideoId," app.js` — expect the new dep line.

- [ ] **Step 3: Commit**

```bash
git add app.js
git commit -m "feat: give the bulk importer the video id lookup"
```

---

## Task 6: Skip duplicate rows in the bulk import

**Files:**
- Modify: `bulk-youtube.js`

- [ ] **Step 1: Add the status label**

**Careful — the wrong file will match.** `app.js` has a `STATUS_LABELS` map whose
last four lines are byte-identical to `BULK_STATUS_LABELS` in `bulk-youtube.js`.
Every edit in this task is in **`bulk-youtube.js`**. Confirm with
`grep -n "BULK_STATUS_LABELS" bulk-youtube.js` before editing, and do not leave
`app.js` modified — `git status` at the end of this task must show only
`bulk-youtube.js`.

Find in `BULK_STATUS_LABELS` (in `bulk-youtube.js`):

```js
    completed: 'Completed',
    failed: 'Failed'
};
```

Change it to:

```js
    completed: 'Completed',
    failed: 'Failed',
    skipped: 'Skipped'
};
```

- [ ] **Step 2: Add the status category**

Find:

```js
function statusCategory(status) {
    if (!status || status === 'queued') return 'queued';
    if (status === 'completed') return 'completed';
    if (status === 'failed') return 'failed';
    return 'processing';
}
```

Change it to:

```js
function statusCategory(status) {
    if (!status || status === 'queued') return 'queued';
    if (status === 'completed') return 'completed';
    if (status === 'failed') return 'failed';
    if (status === 'skipped') return 'skipped';
    return 'processing';
}
```

Without this branch a skipped row falls through to `processing` and shows a blue "in progress" badge forever.

- [ ] **Step 3: Skip before anything expensive**

Find the opening of `processBulkItem`:

```js
async function processBulkItem(item) {
    const quality = qualitySelect?.value || '360p';

    const file = await withDownloadSlot(async () => {
```

Change it to:

```js
async function processBulkItem(item) {
    // Before withDownloadSlot, so a duplicate costs nothing: no info fetch, no
    // download slot, no upload, no transcription, and no movieId is minted.
    const alreadyImported = deps.findMovieByVideoId(item.videoId);
    if (alreadyImported) {
        item.status = 'skipped';
        item.skipReason = `Already imported as "${alreadyImported.title}"`;
        renderQueue();
        return;
    }

    const quality = qualitySelect?.value || '360p';

    const file = await withDownloadSlot(async () => {
```

- [ ] **Step 4: Carry the reason on the queue item**

Find in `createQueueItem`:

```js
        wasDuplicate: false,
```

Change it to:

```js
        wasDuplicate: false,
        skipReason: null,
```

- [ ] **Step 5: Render the reason**

Find in `renderQueue`:

```js
            if (item.error) {
                const errorEl = document.createElement('span');
                errorEl.className = 'batch-item-error';
                errorEl.textContent = item.error;
                statusWrap.appendChild(errorEl);
            }
```

Insert directly BELOW that block:

```js
            if (item.skipReason) {
                const skipEl = document.createElement('span');
                skipEl.className = 'batch-item-error';
                skipEl.textContent = item.skipReason;
                statusWrap.appendChild(skipEl);
            }
```

- [ ] **Step 6: Count skipped rows in the progress bar**

Find in `renderQueue`:

```js
    const completed = queue.filter(i => i.status === 'completed').length;
    const failed = queue.filter(i => i.status === 'failed').length;
    const hasQueued = queue.some(i => i.status === 'queued');

    if (progressBar) {
        const pct = queue.length
            ? Math.round(((completed + failed) / queue.length) * 100)
            : 0;
        progressBar.style.width = `${pct}%`;
    }
```

Change it to:

```js
    const completed = queue.filter(i => i.status === 'completed').length;
    const failed = queue.filter(i => i.status === 'failed').length;
    const skipped = queue.filter(i => i.status === 'skipped').length;
    const hasQueued = queue.some(i => i.status === 'queued');

    if (progressBar) {
        // Skipped rows are settled too — leaving them out strands the bar below
        // 100% for any run containing a duplicate.
        const pct = queue.length
            ? Math.round(((completed + failed + skipped) / queue.length) * 100)
            : 0;
        progressBar.style.width = `${pct}%`;
    }
```

- [ ] **Step 7: Report skipped rows in the summary**

Find in `runBulkImport`:

```js
    const completed = queue.filter(i => i.status === 'completed').length;
    const failed = queue.filter(i => i.status === 'failed').length;
    const duplicates = queue.filter(i => i.status === 'completed' && i.wasDuplicate).length;

    let message = `Bulk import complete: ${completed} imported, ${failed} failed.`;
    if (duplicates) {
        message += ` (${duplicates} possible duplicate${duplicates === 1 ? '' : 's'})`;
    }
```

Change it to:

```js
    const completed = queue.filter(i => i.status === 'completed').length;
    const failed = queue.filter(i => i.status === 'failed').length;
    const skipped = queue.filter(i => i.status === 'skipped').length;
    const duplicates = queue.filter(i => i.status === 'completed' && i.wasDuplicate).length;

    let message = `Bulk import complete: ${completed} imported, ${failed} failed`;
    if (skipped) {
        message += `, ${skipped} skipped as duplicate${skipped === 1 ? '' : 's'}`;
    }
    message += '.';
    // A row that got all the way through and only then looked like a duplicate —
    // matched on title and year, the pre-flight check having found no sourceURL
    // to match on. Different thing from a skip, so reported separately.
    if (duplicates) {
        message += ` (${duplicates} possible duplicate${duplicates === 1 ? '' : 's'})`;
    }
```

- [ ] **Step 8: Verify**

Run: `node --input-type=module --check < bulk-youtube.js` — expect exit 0.
Run: `npm test` — expect 21 passing.
Run: `grep -n "skipped\|skipReason" bulk-youtube.js` — expect the label, the category branch, the skip block, the queue-item field, the render block, the progress count and the summary count.
Run: `grep -n "item.status !== 'failed'" bulk-youtube.js` — confirm the retry handler still filters on `failed` only, so skipped rows are not retried.
Run: `git status --short` — must list `bulk-youtube.js` and nothing else. If `app.js` appears, you edited the wrong status map; revert it with `git checkout -- app.js` and redo Step 1 in the right file.

- [ ] **Step 9: Commit**

```bash
git add bulk-youtube.js
git commit -m "feat: skip already-imported videos before downloading them"
```

---

## Task 7: Full verification pass

No code changes. Tasks 1–6 each verified only their own slice.

**Files:** none

- [ ] **Step 1: Run the unit tests**

Run: `npm test`
Expected: PASS — 21 tests, 0 failures.

- [ ] **Step 2: Work the checklist against `npm run dev`**

You need at least one movie in the library that was imported from YouTube *after* 2026-09-20, so it has a `sourceURL`. Check in the Firebase console if unsure.

| # | Action | Expected |
|---|---|---|
| 1 | Paste the URL of an already-imported video, click **Fetch Info** | Banner appears naming the existing movie; nothing is fetched |
| 2 | Same URL, click **Download Video** | Nothing downloads; banner stays |
| 3 | Click **Import anyway**, then **Download Video** | Downloads normally; banner gone |
| 4 | Click **Open existing** on the banner | That movie opens in the form |
| 5 | Paste a URL *not* in the library | No banner; Fetch Info and Download work as before |
| 6 | Enable **Auto-run**, paste a duplicate URL | Pipeline does not start; banner appears |
| 7 | Close and reopen the form, paste the same duplicate URL | Banner appears again — the override did not persist |
| 8 | Bulk-import a sheet with 1 duplicate and 2 new videos | Duplicate shows **Skipped** with its reason and never downloads; other 2 import; progress bar reaches 100%; toast reads `2 imported, 0 failed, 1 skipped as duplicate.` |
| 9 | Bulk-import a sheet where every row is a duplicate | Nothing downloads at all; bar reaches 100% |
| 10 | After a bulk run with skips, click **Retry failed** | Skipped rows are NOT retried |
| 11 | Paste the URL of a movie added *before* 2026-09-20 | No pre-flight banner (expected — no `sourceURL` to match); the old title/year warning still appears once the title is known |

Check 8 is the one most likely to regress, since it exercises the skip, the badge, the progress accounting and the summary together.

- [ ] **Step 3: Commit any fixes**

If a check fails, fix it, re-run `npm test`, and commit. If everything passes there is nothing to commit.

- [ ] **Step 4: Hand back**

Report the state of all 11 checks. Do not merge — the branch is `last-added-movie` and integration is the user's call.

---

## Out of scope

- The existing post-transcription `wasDuplicate` title/year check stays exactly as it is. It is the only cover for movies with no `sourceURL`.
- No backfill of `sourceURL` for older records is possible — the video id was never stored.
- No "import anyway" affordance for bulk rows. To re-import one deliberately, delete the existing movie first.
