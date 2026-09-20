# Last Added Movie Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin the most recently added movie to the dashboard — thumbnail, title, year, duration, description and the YouTube link it came from — so the user can see where the previous upload session ended.

**Architecture:** "Last added" is derived, not stored: `updatedAt` is stamped only on creation, so the movie with the greatest `updatedAt` is the last one added. The panel renders off the existing Firebase `onValue` listener, so batch and bulk saves update it with no wiring in those pipelines. One new persisted field, `sourceURL`, captures the YouTube link that is currently discarded after import. Three pure functions move into a new dependency-free module so they can be unit tested.

**Tech Stack:** Vanilla ES modules in the browser, Firebase Realtime Database + Storage (CDN imports), Node's built-in test runner (`node --test`). No build step, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-20-last-added-movie-design.md`

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `last-added.js` | Create | Three pure functions: `youtubeWatchURL`, `buildSourceURL`, `formatRelativeTime`, `pickLastAdded`. No imports, no DOM, no Firebase — importable by Node |
| `last-added.test.js` | Create | `node --test` coverage for the above |
| `package.json` | Modify | Add the `test` script |
| `index.html` | Modify | Panel markup above the filter bar |
| `style.css` | Modify | Panel styles |
| `app.js` | Modify | Import the helpers; write `sourceURL` on two save paths; `renderLastAdded` + listeners |

`bulk-youtube.js` is **not** modified. Its queue items already carry `videoId`, and `enrichAndSave` (shared by the batch and bulk paths) derives the URL from that. Batch-upload items have no `videoId`, which is exactly the "no source" case.

### Important gotchas discovered while writing this plan

1. **Use `isDisplayableImageSrc` (app.js:145) for the thumbnail, never `isSafeThumbnailSrc` (app.js:130).** The latter is a canvas-taint test that only accepts same-origin URLs. Every persisted thumbnail is cross-origin (`firebasestorage.googleapis.com`, `i.ytimg.com`), so using it would reject all of them and the panel would permanently show the fallback icon. The comment at app.js:140 spells this out.
2. **`.btn-sm` sets `flex: 1`.** The duplicate banner needed an explicit `flex: 0 0 auto` override (style.css:1561) to stop its buttons stretching. The new panel needs the same override.
3. **`duration` is already a display string** (`"14m 20s"` from the form, `"12:43"` from `formatDuration` in the batch path). Render it verbatim; do not call `formatDuration`.
4. **Firebase drops `null` values on write**, so `sourceURL: null` simply leaves the key absent. That is the intended behaviour for local batch uploads.
5. **`update()` only writes the keys you give it**, so editing a movie will not erase an existing `sourceURL` even though the YouTube input is cleared by `resetMediaInputs`.

---

## Task 1: Create the helper module and test harness

**Files:**
- Create: `last-added.js`
- Create: `last-added.test.js`
- Modify: `package.json`

- [ ] **Step 1: Add the test script to `package.json`**

Change the `scripts` block to:

```json
  "scripts": {
    "dev": "node dev-server.js",
    "test": "node --test",
    "setup:ytdlp": "uv venv --python 3.12 .venv && VIRTUAL_ENV=.venv uv pip install yt-dlp",
    "update:ytdlp": "VIRTUAL_ENV=.venv uv pip install --upgrade yt-dlp"
  },
```

**Careful:** copy the existing `setup:ytdlp` and `update:ytdlp` lines exactly as they already are in the file — do not retype them from this plan. Only the `"test"` line is new.

- [ ] **Step 2: Write the failing test**

Create `last-added.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { youtubeWatchURL } from './last-added.js';

test('youtubeWatchURL builds a canonical watch URL', () => {
    assert.equal(
        youtubeWatchURL('dQw4w9WgXcQ'),
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    );
});

test('youtubeWatchURL returns null for a missing id', () => {
    assert.equal(youtubeWatchURL(null), null);
    assert.equal(youtubeWatchURL(''), null);
    assert.equal(youtubeWatchURL(undefined), null);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module` / `ERR_MODULE_NOT_FOUND` for `./last-added.js`.

- [ ] **Step 4: Write the minimal implementation**

Create `last-added.js`:

```js
// Pure helpers for the "last added movie" panel.
//
// This module deliberately imports nothing. app.js cannot be loaded by Node —
// it imports Firebase over https:// URLs and reads window.CONFIG at module
// load — so any logic that deserves a unit test lives here instead.

// Canonical watch URL for a YouTube video id, or null when there is no id.
export function youtubeWatchURL(videoId) {
    if (!videoId) return null;
    return `https://www.youtube.com/watch?v=${videoId}`;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — 2 tests passing.

- [ ] **Step 6: Commit**

```bash
git add package.json last-added.js last-added.test.js
git commit -m "feat: add last-added helper module with youtubeWatchURL"
```

---

## Task 2: `buildSourceURL`

Normalizes a pasted string into a canonical watch URL. The video-id extractor is passed in as a parameter so this module stays free of any `app.js` import.

**Files:**
- Modify: `last-added.js`
- Modify: `last-added.test.js`

- [ ] **Step 1: Write the failing test**

Append to `last-added.test.js` (and add `buildSourceURL` to the existing import at the top of the file, so it reads `import { youtubeWatchURL, buildSourceURL } from './last-added.js';`):

```js
// A stand-in for app.js's extractYouTubeVideoId, with the same contract:
// returns an 11-character id or null.
const fakeExtract = (url) => {
    const m = String(url).match(/[?&]v=([a-zA-Z0-9_-]{11})/);
    return m ? m[1] : null;
};

test('buildSourceURL strips playlist and timestamp parameters', () => {
    assert.equal(
        buildSourceURL(
            'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&t=42s',
            fakeExtract
        ),
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    );
});

test('buildSourceURL tolerates surrounding whitespace', () => {
    assert.equal(
        buildSourceURL('  https://www.youtube.com/watch?v=dQw4w9WgXcQ  ', fakeExtract),
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    );
});

test('buildSourceURL returns null when there is no video id', () => {
    assert.equal(buildSourceURL('https://example.com/nope', fakeExtract), null);
    assert.equal(buildSourceURL('', fakeExtract), null);
    assert.equal(buildSourceURL(null, fakeExtract), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `buildSourceURL is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Append to `last-added.js`:

```js
// Canonical watch URL for a pasted string, or null when it holds no video id.
// extractVideoId is injected (app.js owns the real one) to keep this module
// import-free.
export function buildSourceURL(input, extractVideoId) {
    if (!input) return null;
    const trimmed = String(input).trim();
    if (!trimmed) return null;
    return youtubeWatchURL(extractVideoId(trimmed));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — 5 tests passing.

- [ ] **Step 5: Commit**

```bash
git add last-added.js last-added.test.js
git commit -m "feat: normalize a pasted YouTube URL to a canonical watch URL"
```

---

## Task 3: `formatRelativeTime`

**Files:**
- Modify: `last-added.js`
- Modify: `last-added.test.js`

- [ ] **Step 1: Write the failing test**

Append to `last-added.test.js` (and add `formatRelativeTime` to the import at the top of the file):

```js
// Fixed reference point so these assertions never depend on the wall clock.
const NOW = Date.UTC(2026, 8, 20, 12, 0, 0); // 2026-09-20T12:00:00Z
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test('formatRelativeTime describes the recent past', () => {
    assert.equal(formatRelativeTime(NOW - 5 * SEC, NOW), 'just now');
    assert.equal(formatRelativeTime(NOW - 59 * SEC, NOW), 'just now');
    assert.equal(formatRelativeTime(NOW - 1 * MIN, NOW), '1 min ago');
    assert.equal(formatRelativeTime(NOW - 59 * MIN, NOW), '59 min ago');
    assert.equal(formatRelativeTime(NOW - 1 * HOUR, NOW), '1 hr ago');
    assert.equal(formatRelativeTime(NOW - 23 * HOUR, NOW), '23 hr ago');
    assert.equal(formatRelativeTime(NOW - 1 * DAY, NOW), '1 day ago');
    assert.equal(formatRelativeTime(NOW - 6 * DAY, NOW), '6 days ago');
});

test('formatRelativeTime falls back to an absolute date past a week', () => {
    assert.equal(formatRelativeTime(NOW - 7 * DAY, NOW), 'Sep 13, 2026');
});

test('formatRelativeTime treats a future timestamp as just now', () => {
    // Clock skew between the browser and Firebase must not render "-3 min ago".
    assert.equal(formatRelativeTime(NOW + 3 * MIN, NOW), 'just now');
});

test('formatRelativeTime handles a missing timestamp', () => {
    assert.equal(formatRelativeTime(0, NOW), 'unknown');
    assert.equal(formatRelativeTime(null, NOW), 'unknown');
    assert.equal(formatRelativeTime(undefined, NOW), 'unknown');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `formatRelativeTime is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Append to `last-added.js`:

```js
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// Human-readable age of a timestamp. `now` is a parameter, not Date.now(), so
// this stays deterministic under test.
export function formatRelativeTime(timestamp, now) {
    if (!timestamp) return 'unknown';

    const elapsed = now - timestamp;

    // A timestamp in the future means clock skew between this browser and
    // whichever client wrote the record. "just now" is the honest reading;
    // a negative duration is not.
    if (elapsed < MINUTE_MS) return 'just now';

    if (elapsed < HOUR_MS) {
        return `${Math.floor(elapsed / MINUTE_MS)} min ago`;
    }
    if (elapsed < DAY_MS) {
        return `${Math.floor(elapsed / HOUR_MS)} hr ago`;
    }
    if (elapsed < 7 * DAY_MS) {
        const days = Math.floor(elapsed / DAY_MS);
        return `${days} day${days === 1 ? '' : 's'} ago`;
    }

    return new Date(timestamp).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — 9 tests passing.

If the absolute-date assertion fails with a different format, the Node build lacks full ICU. Check with `node -e "console.log(new Date(0).toLocaleDateString('en-US',{year:'numeric',month:'short',day:'numeric'}))"` — it must print `Jan 1, 1970`. Node 22 ships full ICU by default, so this should not happen.

- [ ] **Step 5: Commit**

```bash
git add last-added.js last-added.test.js
git commit -m "feat: render the age of the last added movie"
```

---

## Task 4: `pickLastAdded`

**Files:**
- Modify: `last-added.js`
- Modify: `last-added.test.js`

- [ ] **Step 1: Write the failing test**

Append to `last-added.test.js` (and add `pickLastAdded` to the import at the top of the file):

```js
test('pickLastAdded returns the movie with the greatest updatedAt', () => {
    const movies = [
        { id: 'a', title: 'Alpha', updatedAt: 100 },
        { id: 'c', title: 'Gamma', updatedAt: 300 },
        { id: 'b', title: 'Beta', updatedAt: 200 }
    ];
    assert.equal(pickLastAdded(movies).id, 'c');
});

test('pickLastAdded treats a missing updatedAt as oldest', () => {
    const movies = [
        { id: 'legacy', title: 'No timestamp' },
        { id: 'fresh', title: 'Timestamped', updatedAt: 1 }
    ];
    assert.equal(pickLastAdded(movies).id, 'fresh');
});

test('pickLastAdded still returns a movie when every record predates updatedAt', () => {
    const movies = [{ id: 'x', title: 'X' }, { id: 'y', title: 'Y' }];
    assert.equal(pickLastAdded(movies).id, 'x');
});

test('pickLastAdded returns null for nothing to pick', () => {
    assert.equal(pickLastAdded([]), null);
    assert.equal(pickLastAdded(null), null);
    assert.equal(pickLastAdded(undefined), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `pickLastAdded is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Append to `last-added.js`:

```js
// The most recently added movie. updatedAt is stamped only on creation (never
// on edit), so the greatest value is genuinely the last one added.
export function pickLastAdded(movies) {
    if (!Array.isArray(movies) || movies.length === 0) return null;

    return movies.reduce((best, movie) => (
        (movie.updatedAt || 0) > (best.updatedAt || 0) ? movie : best
    ));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — 13 tests passing.

- [ ] **Step 5: Commit**

```bash
git add last-added.js last-added.test.js
git commit -m "feat: select the most recently added movie"
```

---

## Task 5: Persist `sourceURL` on the manual form path

**Files:**
- Modify: `app.js` (import block near line 19; `handleFormSubmit` near line 1722)

- [ ] **Step 1: Import the helpers**

In `app.js`, directly below the existing bulk-youtube import (app.js:19):

```js
import { initBulkYoutube, isBulkProcessing, resetBulkYoutube } from './bulk-youtube.js';
```

add:

```js
import {
    youtubeWatchURL,
    buildSourceURL,
    formatRelativeTime,
    pickLastAdded
} from './last-added.js';
```

- [ ] **Step 2: Write `sourceURL` in `handleFormSubmit`**

Find this run of lines in `handleFormSubmit` (app.js, just after `movieData` is built). Note the duplicated `videoURL` line is already in the file:

```js
        if (videoUrl) movieData.videoURL = videoUrl;
        if (videoUrl) movieData.videoURL = videoUrl;
        if (thumbnailUrl) movieData.thumbnail = thumbnailUrl;
        if (featuredThumbnailUrl) movieData.featuredThumbnail = featuredThumbnailUrl;
```

Replace it with:

```js
        if (videoUrl) movieData.videoURL = videoUrl;
        if (thumbnailUrl) movieData.thumbnail = thumbnailUrl;
        if (featuredThumbnailUrl) movieData.featuredThumbnail = featuredThumbnailUrl;

        // Where this recap came from. videoURL points at our Storage copy, which
        // says nothing about the source. Absent when the video was uploaded from
        // disk rather than pulled from YouTube. On an edit the input is blank
        // (resetMediaInputs clears it) and update() only writes the keys it is
        // given, so an existing sourceURL survives.
        const sourceURL = buildSourceURL(
            document.getElementById('youtube-url')?.value,
            extractYouTubeVideoId
        );
        if (sourceURL) movieData.sourceURL = sourceURL;
```

This also removes the accidental duplicate `videoURL` assignment.

- [ ] **Step 3: Verify in the browser**

Run: `npm run dev`, open `http://localhost:3000`.

1. Click **Add New Movie**, switch to the **YouTube URL** tab.
2. Paste `https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&t=42s`.
3. Complete the flow and save.
4. In the Firebase console, open the new `movies/<id>` record.

Expected: `sourceURL` is exactly `https://www.youtube.com/watch?v=dQw4w9WgXcQ` — no `list` or `t` parameter.

- [ ] **Step 4: Commit**

```bash
git add app.js
git commit -m "feat: save the YouTube source URL from the movie form"
```

---

## Task 6: Persist `sourceURL` on the bulk import path

`enrichAndSave` is shared by the batch (local MP4) and bulk (YouTube) pipelines. Bulk queue items carry `videoId`; batch items do not. That difference is exactly the "has a source / has no source" distinction, so one line covers both and `bulk-youtube.js` needs no change at all.

**Files:**
- Modify: `app.js` (`enrichAndSave`, near line 373)

- [ ] **Step 1: Add the field to the saved record**

In `enrichAndSave`, find the `movieData` literal:

```js
    const movieData = {
        id: item.movieId,
        title: metadata.title,
        year: item.metadata.year,
        description: metadata.description,
        categories,
        duration: item.duration,
        thumbnail: item.thumbnailURL,
        videoURL: item.videoUrl,
        featuredThumbnail: item.posterUrl || null,
        updatedAt: Date.now()
    };
```

and add one line before the closing brace:

```js
    const movieData = {
        id: item.movieId,
        title: metadata.title,
        year: item.metadata.year,
        description: metadata.description,
        categories,
        duration: item.duration,
        thumbnail: item.thumbnailURL,
        videoURL: item.videoUrl,
        featuredThumbnail: item.posterUrl || null,
        // Bulk YouTube rows carry a videoId; batch rows from local files do not,
        // and Firebase drops null on write, so the key is simply absent for them.
        sourceURL: item.videoId ? youtubeWatchURL(item.videoId) : null,
        updatedAt: Date.now()
    };
```

- [ ] **Step 2: Verify the bulk path in the browser**

Run: `npm run dev`. Open **Add New Movie → Bulk YouTube**, upload a spreadsheet holding one YouTube link, and run the import.

Expected: the saved `movies/<id>` record has `sourceURL` set to the canonical watch URL for that video.

- [ ] **Step 3: Verify the batch path in the browser**

Click **Batch Upload**, add one local MP4, and run it.

Expected: the saved record has **no** `sourceURL` key at all (not an empty string, not null).

- [ ] **Step 4: Commit**

```bash
git add app.js
git commit -m "feat: save the source URL for bulk YouTube imports"
```

---

## Task 7: Panel markup and styles

**Files:**
- Modify: `index.html` (between the form panel `</section>` and `<section class="content-body">`, near line 380)
- Modify: `style.css` (append)

- [ ] **Step 1: Add the markup**

In `index.html`, find:

```html
            <!-- Movie Grid -->
            <section class="content-body">
```

and insert immediately **above** the `<!-- Movie Grid -->` comment:

```html
            <!-- Last added movie. Deliberately outside .content-body so no
                 search, filter, sort or pagination state can affect it. -->
            <section id="last-added" class="last-added hidden">
                <img id="last-added-thumb" class="last-added-thumb" alt="">
                <div class="last-added-body">
                    <span class="last-added-label">⏱ Last added</span>
                    <span id="last-added-title" class="last-added-title"></span>
                    <span id="last-added-meta" class="last-added-meta"></span>
                    <p id="last-added-desc" class="last-added-desc"></p>
                    <a id="last-added-source" class="last-added-source" target="_blank" rel="noopener"></a>
                    <div class="last-added-actions">
                        <button type="button" id="last-added-edit" class="btn btn-sm btn-secondary">Edit</button>
                        <button type="button" id="last-added-copy" class="btn btn-sm btn-ghost">Copy link</button>
                    </div>
                </div>
            </section>

```

- [ ] **Step 2: Add the styles**

Append to `style.css`:

```css
/* --- Last Added Movie Panel --- */
/* Structure mirrors .duplicate-warning so the two read as one family. */

.last-added {
    display: flex;
    gap: 14px;
    align-items: flex-start;
    margin: 0 0 18px;
    padding: 14px 16px;
    border-radius: var(--border-radius);
    border: 1px solid var(--color-accent);
    background: rgba(189, 54, 158, 0.12);
}

.last-added-thumb {
    width: 120px;
    height: 68px;
    object-fit: cover;
    border-radius: 6px;
    flex-shrink: 0;
    background: var(--bg-card);
}

.last-added-body {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    color: var(--text-primary);
}

.last-added-label {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-accent-light);
}

.last-added-title {
    font-size: 1.05rem;
    font-weight: 600;
}

.last-added-meta {
    font-size: 0.85rem;
    color: var(--text-secondary);
}

.last-added-desc {
    margin: 2px 0 0;
    font-size: 0.85rem;
    color: var(--text-secondary);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
}

.last-added-source {
    font-size: 0.8rem;
    color: var(--color-accent-light);
    text-decoration: none;
    overflow-wrap: anywhere;
}

.last-added-source:hover {
    text-decoration: underline;
}

.last-added-actions {
    display: flex;
    gap: 8px;
    margin-top: 8px;
}

/* .btn-sm sets flex: 1; these buttons should hug their text instead. */
.last-added-actions .btn {
    flex: 0 0 auto;
}
```

- [ ] **Step 3: Verify the panel is hidden**

Run: `npm run dev` and load the dashboard.

Expected: no visual change yet — the panel carries `hidden` and nothing has removed it. The movie grid renders exactly as before.

- [ ] **Step 4: Commit**

```bash
git add index.html style.css
git commit -m "feat: add last added movie panel markup and styles"
```

---

## Task 8: Render the panel

**Files:**
- Modify: `app.js` (element lookups and `renderLastAdded` near the pagination elements around line 1877; listener call near line 1916)

- [ ] **Step 1: Add element references and the render function**

In `app.js`, find the pagination element block:

```js
const paginationControls = document.getElementById('pagination-controls');
const prevPageBtn = document.getElementById('prev-page');
const nextPageBtn = document.getElementById('next-page');
const pageInfo = document.getElementById('page-info');
```

and insert directly **below** it:

```js
// Last added movie panel
const lastAddedPanel = document.getElementById('last-added');
const lastAddedThumb = document.getElementById('last-added-thumb');
const lastAddedTitle = document.getElementById('last-added-title');
const lastAddedMeta = document.getElementById('last-added-meta');
const lastAddedDesc = document.getElementById('last-added-desc');
const lastAddedSource = document.getElementById('last-added-source');
const lastAddedEditBtn = document.getElementById('last-added-edit');
const lastAddedCopyBtn = document.getElementById('last-added-copy');

// The movie currently on the panel, so the Edit and Copy buttons act on it
// without re-deriving it.
let lastAddedMovie = null;

// Renders the most recently added movie. Every field goes in via textContent —
// titles and descriptions come from AI extraction and OMDb, and createMovieCard's
// innerHTML template is not a pattern to copy here.
function renderLastAdded() {
    lastAddedMovie = pickLastAdded(allMovies);

    if (!lastAddedMovie) {
        lastAddedPanel.classList.add('hidden');
        return;
    }

    const movie = lastAddedMovie;

    // isDisplayableImageSrc, not isSafeThumbnailSrc: the latter is a canvas-taint
    // test that only passes same-origin URLs, and every stored thumbnail is
    // cross-origin. See the comment above both functions.
    lastAddedThumb.src = isDisplayableImageSrc(movie.thumbnail)
        ? movie.thumbnail
        : 'assets/img/app-icon.png';
    lastAddedThumb.alt = movie.title || '';

    lastAddedTitle.textContent = movie.title || 'Untitled';

    // duration is already a display string ("14m 20s" from the form, "12:43"
    // from formatDuration in the batch path), so it needs no formatting.
    const metaParts = [];
    if (movie.year) metaParts.push(String(movie.year));
    if (movie.duration) metaParts.push(movie.duration);
    metaParts.push(`added ${formatRelativeTime(movie.updatedAt, Date.now())}`);
    lastAddedMeta.textContent = metaParts.join(' · ');

    lastAddedDesc.textContent = movie.description || '';

    // Movies added before sourceURL existed, and anything uploaded from disk,
    // have no source to show.
    if (movie.sourceURL) {
        lastAddedSource.href = movie.sourceURL;
        lastAddedSource.textContent = movie.sourceURL;
        lastAddedSource.classList.remove('hidden');
        lastAddedCopyBtn.classList.remove('hidden');
    } else {
        lastAddedSource.removeAttribute('href');
        lastAddedSource.textContent = '';
        lastAddedSource.classList.add('hidden');
        lastAddedCopyBtn.classList.add('hidden');
    }

    lastAddedPanel.classList.remove('hidden');
}
```

- [ ] **Step 2: Call it from the existing Firebase listener**

Find the `onValue` handler and add the final call:

```js
onValue(moviesRef, (snapshot) => {
    const data = snapshot.val();
    if (!data) {
        allMovies = [];
    } else {
        allMovies = Object.values(data);
    }
    existingMoviesByKey = new Map(
        allMovies.map((movie) => [buildDuplicateKey(movie.title, movie.year), movie])
    );
    applyFiltersAndRender();
    if (!movieFormPanel.classList.contains('hidden')) refreshDuplicateWarning();
    renderLastAdded();
});
```

Only the `renderLastAdded();` line is new — hanging it off the existing listener is what makes batch and bulk saves update the panel with no changes to either pipeline.

- [ ] **Step 3: Verify the panel renders**

Run: `npm run dev` and load the dashboard against a database that already has movies.

Expected: the panel appears above the search bar, showing one movie with its thumbnail, title, `<year> · <duration> · added <time>`, and a two-line description. Existing movies have no `sourceURL`, so the link and the **Copy link** button are hidden while **Edit** is visible.

Then: type in the search box, change the category, change the sort, and page forward. The panel must not change at any point.

- [ ] **Step 4: Commit**

```bash
git add app.js
git commit -m "feat: render the last added movie above the grid"
```

---

## Task 9: Wire the Edit and Copy actions

**Files:**
- Modify: `app.js` (below `renderLastAdded`)

- [ ] **Step 1: Add the listeners**

Directly below `renderLastAdded`, add:

```js
lastAddedEditBtn?.addEventListener('click', () => {
    if (lastAddedMovie) openForm(lastAddedMovie);
});

lastAddedCopyBtn?.addEventListener('click', async () => {
    if (!lastAddedMovie?.sourceURL) return;
    try {
        await navigator.clipboard.writeText(lastAddedMovie.sourceURL);
        showToast('Source link copied');
    } catch (error) {
        // Denied permission, or a non-secure context. The link is on screen and
        // selectable, so this is a degraded path rather than a dead end.
        console.error('[last added] clipboard', error);
        showToast('Could not copy — select the link to copy it manually');
    }
});
```

- [ ] **Step 2: Verify Edit**

Run: `npm run dev`. Click **Edit** on the panel.

Expected: the movie form opens pre-filled with that movie, identical to clicking Edit on its grid card. Close the form without saving; the panel is unchanged.

- [ ] **Step 3: Verify Copy**

Add a movie through the YouTube path so the panel has a `sourceURL`, then click **Copy link**.

Expected: the toast reads "Source link copied", and pasting into the address bar yields the canonical watch URL.

- [ ] **Step 4: Commit**

```bash
git add app.js
git commit -m "feat: add edit and copy link actions to the last added panel"
```

---

## Task 10: Full verification pass

No code changes. This walks the spec's acceptance checks end to end, because Tasks 5–9 each verified only their own slice.

**Files:** none

- [ ] **Step 1: Run the unit tests**

Run: `npm test`
Expected: PASS — 13 tests, 0 failures.

- [ ] **Step 2: Work the checklist against `npm run dev`**

| # | Action | Expected |
|---|---|---|
| 1 | Add a movie via the form with a YouTube URL | Panel shows it; source link opens the right video |
| 2 | Paste a URL with `&list=` and `&t=` | Stored `sourceURL` is the canonical watch URL |
| 3 | Batch-upload two local MP4s | Panel shows the later one; no source link, no Copy button |
| 4 | Run a bulk YouTube import | Panel shows the last imported row, with its source link |
| 5 | Edit an existing movie and save | Panel does **not** change — editing is not adding |
| 6 | Delete the movie on the panel | Panel falls back to the previous movie |
| 7 | Load against an empty database | Panel is hidden entirely |
| 8 | Search, change category, change sort, page forward | Panel is unaffected throughout |

Check 5 is the one most likely to regress: it depends on `handleFormSubmit` leaving `updatedAt` alone when `editingMovieId` is set.

- [ ] **Step 3: Commit any fixes**

If a check fails, fix it, re-run `npm test`, and commit. If everything passes, there is nothing to commit — go to Step 4.

- [ ] **Step 4: Hand back for review**

Report the state of all 8 checks. Do not merge; the branch is `last-added-movie` and integration is the user's call.

---

## Out of scope

A pre-flight duplicate check for the bulk YouTube import — matching a row's `videoId` against the library at queue time, before any download or transcription — is recorded in the spec's "Follow-on work" section and needs its own spec. Do not build it here.
