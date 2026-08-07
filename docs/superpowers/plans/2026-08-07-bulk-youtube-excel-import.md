# Bulk YouTube Import via Excel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user upload an Excel/CSV file of YouTube URLs from the Add New Movie modal and import every video as a movie, continuing past any row that fails.

**Architecture:** A new `bulk-youtube.js` module owns Excel parsing, queue state, queue rendering, and the per-item worker. `app.js` extracts four reusable pipeline stages out of its existing MP4 batch code and injects them into that module, so the two batch flows share one pipeline and `app.js` does not grow.

**Tech Stack:** Vanilla ES modules loaded directly in the browser (no bundler, no npm build). Firebase Realtime DB + Storage from the gstatic CDN. SheetJS loaded on demand from `cdn.sheetjs.com`. Local Express dev server (`npm run dev`) proxying yt-dlp.

**Spec:** `docs/superpowers/specs/2026-08-07-bulk-youtube-excel-import-design.md`

---

## Testing note — read before starting

This project has **no test framework, no test files, and no build step**. `app.js` is a plain
ES module loaded by `<script type="module">`. Introducing Vitest/Jest plus a DOM harness would
be a larger change than the feature itself and is explicitly out of scope.

Every task therefore ends with a **manual browser verification** with exact steps and exact
expected output, followed by a commit. Treat the verification step as the test: if the
expected output does not appear, the task is not done.

Run the app for every verification with:

```bash
npm run dev
```

Then open http://localhost:3000 (the port `dev-server.js` prints on startup). Keep the browser
devtools Console open for the whole exercise — an uncaught module error there means a task
failed even if the page looks fine.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `bulk-youtube.js` | **Create** | Excel parsing, bulk queue state, bulk queue rendering, per-item worker, download semaphore. Knows nothing about Firebase — receives pipeline stages via injection. |
| `app.js` | Modify | Extracts four shared pipeline stages; populates `existingMovieKeys`; owns the three-way source tab switching and modal guards; injects deps into `bulk-youtube.js`. |
| `index.html` | Modify | Third source tab button and the bulk panel markup; adds `id="metadata-section"`. |
| `style.css` | Modify | Bulk panel layout, bulk progress-bar fill, duplicate tag. |

---

## Task 1: Populate `existingMovieKeys` (prerequisite bug fix)

`existingMovieKeys` is declared at `app.js:70` and read at `app.js:1529`, but **nothing ever
adds to it** — so the existing duplicate-confirm on single movie save never fires. The spec
requires duplicate flagging on bulk rows, which needs this Set to be real.

**Files:**
- Modify: `app.js:1702-1710`

- [ ] **Step 1: Populate the Set inside the movies listener**

Replace `app.js:1702-1710` with:

```js
onValue(moviesRef, (snapshot) => {
    const data = snapshot.val();
    if (!data) {
        allMovies = [];
    } else {
        allMovies = Object.values(data);
    }
    existingMovieKeys = new Set(
        allMovies.map((movie) => buildDuplicateKey(movie.title, movie.year))
    );
    applyFiltersAndRender();
});
```

- [ ] **Step 2: Verify in the browser**

1. `npm run dev`, open the dashboard, note the title and year of any existing movie.
2. In the devtools Console, run:

```js
// existingMovieKeys is module-scoped, so check via the behavior instead:
// open Add New Movie, type the exact title + year of an existing movie
```

3. Open **Add New Movie**, type the exact title and year of an existing movie into Title and
   Year, attach any MP4, press **Upload & Save**.

Expected: a `confirm()` dialog reading `A movie with the same title and year already exists.
Save anyway?`. Before this fix that dialog never appeared. Press Cancel.

- [ ] **Step 3: Commit**

```bash
git add app.js
git commit -m "fix: populate existingMovieKeys so duplicate detection actually runs"
```

---

## Task 2: Add the Bulk YouTube markup

**Files:**
- Modify: `index.html:91-94` (tab group), `index.html:126` (new panel), `index.html:197` (add id)

- [ ] **Step 1: Add the third tab button**

Replace `index.html:91-94`:

```html
                                     <div class="source-toggle">
                                         <button type="button" id="source-file-btn" class="source-tab active">Upload File</button>
                                         <button type="button" id="source-youtube-btn" class="source-tab">YouTube URL</button>
                                     </div>
```

with:

```html
                                     <div class="source-toggle">
                                         <button type="button" id="source-file-btn" class="source-tab active">Upload File</button>
                                         <button type="button" id="source-youtube-btn" class="source-tab">YouTube URL</button>
                                         <button type="button" id="source-bulk-btn" class="source-tab">📊 Bulk YouTube</button>
                                     </div>
```

- [ ] **Step 2: Add the bulk panel**

Insert immediately after the closing `</div>` of `#youtube-input-section` (after
`index.html:126`, before the `<div class="upload-grid">` line):

```html
                                     <!-- Bulk YouTube import section -->
                                     <div id="bulk-youtube-section" class="hidden">
                                         <p class="bulk-hint">
                                             Upload an Excel or CSV file containing YouTube links. Every link is
                                             imported as its own movie; a link that fails is skipped and the rest
                                             continue. Requires the local dev server — YouTube download is not
                                             available on the deployed site.
                                         </p>
                                         <div class="bulk-controls">
                                             <input type="file" id="bulk-excel-file" accept=".xlsx,.xls,.csv">
                                             <select id="bulk-quality" class="youtube-quality-select">
                                                 <option value="360p">360p</option>
                                                 <option value="480p">480p</option>
                                                 <option value="720p">720p</option>
                                                 <option value="1080p">1080p</option>
                                             </select>
                                         </div>
                                         <div id="bulk-found-count" class="bulk-found-count">No file selected.</div>
                                         <ul id="bulk-queue" class="batch-list"></ul>
                                         <div class="batch-progress">
                                             <div id="bulk-progress-bar"></div>
                                         </div>
                                         <div class="bulk-actions">
                                             <button type="button" id="bulk-start-btn" class="btn btn-primary btn-sm" disabled>Start Import</button>
                                             <button type="button" id="bulk-retry-btn" class="btn btn-secondary btn-sm" disabled>Retry Failed</button>
                                             <button type="button" id="bulk-clear-btn" class="btn btn-ghost btn-sm" disabled>Clear</button>
                                         </div>
                                     </div>
```

- [ ] **Step 3: Give the Movie Details section an id**

At `index.html:197`, replace:

```html
                        <div class="form-section metadata-section">
```

with:

```html
                        <div class="form-section metadata-section" id="metadata-section">
```

- [ ] **Step 4: Verify in the browser**

Reload, open **Add New Movie**.

Expected: a third tab reading `📊 Bulk YouTube` sits beside the other two. Clicking it does
nothing yet — that is correct; wiring lands in Task 4. In the devtools Console run
`document.getElementById('bulk-youtube-section')` and confirm it returns the element, not
`null`.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat: add Bulk YouTube tab and panel markup"
```

---

## Task 3: Add the Bulk YouTube styles

**Files:**
- Modify: `style.css` (append after `.batch-item-error`, which ends at `style.css:526`)

- [ ] **Step 1: Append the styles**

Insert after `style.css:526` (the closing brace of `.batch-item-error`) and before the
`/* Forms */` comment:

```css
/* Bulk YouTube import */
#bulk-youtube-section {
    display: flex;
    flex-direction: column;
    gap: 14px;
    margin-bottom: 18px;
}

.bulk-hint {
    font-size: 0.8rem;
    line-height: 1.5;
    color: var(--text-muted);
    margin: 0;
    padding: 10px 12px;
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.08);
}

.bulk-controls {
    display: flex;
    gap: 12px;
    align-items: center;
    flex-wrap: wrap;
}

.bulk-found-count {
    font-size: 0.85rem;
    color: var(--text-muted);
}

.batch-progress #bulk-progress-bar {
    height: 100%;
    width: 0%;
    background: var(--color-accent);
    transition: width 0.3s ease;
}

.bulk-actions {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
}

.batch-item-tag {
    display: inline-block;
    margin-left: 8px;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 0.7rem;
    font-weight: 600;
    background: rgba(241, 196, 15, 0.18);
    color: #ffd86b;
}
```

- [ ] **Step 2: Verify in the browser**

Reload with a hard refresh (Cmd+Shift+R). In the devtools Console run:

```js
const el = document.getElementById('bulk-youtube-section');
el.classList.remove('hidden');
getComputedStyle(el).flexDirection;
```

Expected: `"column"`, and the panel is visible in the modal with the hint text in a bordered
box, a file input, a quality dropdown, and three buttons. Then run `el.classList.add('hidden')`
to put it back.

- [ ] **Step 3: Commit**

```bash
git add style.css
git commit -m "feat: add Bulk YouTube panel styles"
```

---

## Task 4: Three-way source tab switching

**Files:**
- Modify: `app.js:2170-2183` (replace the two tab handlers)

- [ ] **Step 1: Replace the source toggle handlers**

Replace `app.js:2170-2183`:

```js
// Source toggle
document.getElementById('source-file-btn')?.addEventListener('click', () => {
    document.getElementById('source-file-btn').classList.add('active');
    document.getElementById('source-youtube-btn').classList.remove('active');
    document.getElementById('youtube-input-section').classList.add('hidden');
    document.getElementById('video-drop-zone').classList.remove('hidden');
});

document.getElementById('source-youtube-btn')?.addEventListener('click', () => {
    document.getElementById('source-youtube-btn').classList.add('active');
    document.getElementById('source-file-btn').classList.remove('active');
    document.getElementById('youtube-input-section').classList.remove('hidden');
    document.getElementById('video-drop-zone').classList.add('hidden');
});
```

with:

```js
// Source toggle — Upload File / YouTube URL / Bulk YouTube
const SOURCE_TABS = [
    { btnId: 'source-file-btn', panelId: 'video-drop-zone' },
    { btnId: 'source-youtube-btn', panelId: 'youtube-input-section' },
    { btnId: 'source-bulk-btn', panelId: 'bulk-youtube-section' }
];

function setSourceMode(activeBtnId) {
    SOURCE_TABS.forEach(({ btnId, panelId }) => {
        const isActive = btnId === activeBtnId;
        document.getElementById(btnId)?.classList.toggle('active', isActive);
        document.getElementById(panelId)?.classList.toggle('hidden', !isActive);
    });
    // Bulk rows write themselves to the database, so the manual details form
    // and its Save button would be misleading while that tab is open.
    document.getElementById('metadata-section')
        ?.classList.toggle('hidden', activeBtnId === 'source-bulk-btn');
}

SOURCE_TABS.forEach(({ btnId }) => {
    document.getElementById(btnId)?.addEventListener('click', () => setSourceMode(btnId));
});
```

- [ ] **Step 2: Verify in the browser**

Reload, open **Add New Movie**, and click each of the three tabs in turn.

Expected:
- `Upload File` → drop zone visible, YouTube and bulk panels hidden, Movie Details visible.
- `YouTube URL` → URL input visible, drop zone and bulk panel hidden, Movie Details visible.
- `📊 Bulk YouTube` → bulk panel visible; drop zone, URL input, **Movie Details, Cancel and
  Upload & Save all hidden**. The modal's top-right `×` is still visible.

- [ ] **Step 3: Commit**

```bash
git add app.js
git commit -m "feat: three-way source tab switching with bulk mode"
```

---

## Task 5: Extract the shared pipeline stages in `app.js`

Pure refactor. The MP4 batch upload must behave **exactly** as before.

**Files:**
- Modify: `app.js:252-438` (`processBatch` and `processBatchItem`)
- Modify: `app.js:133-148` (`STATUS_LABELS`)

- [ ] **Step 1: Add the two new status labels**

In `STATUS_LABELS` (`app.js:133`), add these two entries after `queued: 'Queued',`:

```js
    'fetching-info': 'Fetching info',
    downloading: 'Downloading',
```

`getStatusInfo()` needs no change — anything that is not `queued`/`completed`/`failed` already
falls into the `processing` category.

- [ ] **Step 2: Replace `processBatch` with a `runQueue` caller**

Replace `app.js:252-314` (the whole `async function processBatch`) with:

```js
// Generic concurrent queue runner. Each item is isolated: a worker that throws
// marks only that item failed and the queue continues with the next one.
function runQueue(items, worker, concurrency, onUpdate) {
    return new Promise((resolve) => {
        let index = 0;
        let active = 0;
        let finished = false;

        const finalize = () => {
            if (finished) return;
            finished = true;
            resolve();
        };

        const launchNext = () => {
            if (index >= items.length) {
                if (active === 0) finalize();
                return;
            }
            const item = items[index++];
            item.error = null;
            active++;
            Promise.resolve()
                .then(() => worker(item))
                .then(() => {
                    item.status = 'completed';
                    onUpdate();
                })
                .catch((error) => {
                    item.status = 'failed';
                    item.error = error?.message || 'Item failed';
                    onUpdate();
                })
                .finally(() => {
                    active--;
                    if (index < items.length) {
                        launchNext();
                    } else if (active === 0) {
                        finalize();
                    }
                });
        };

        const slots = Math.min(concurrency, items.length);
        for (let i = 0; i < slots; i++) {
            launchNext();
        }
    });
}

async function processBatch(concurrency = 2) {
    if (batchProcessing) return;
    const runnable = batchQueue.filter(item => item.status === 'queued');
    if (!runnable.length) return;

    batchProcessing = true;
    updateBatchUI();

    await runQueue(runnable, processBatchItem, concurrency, updateBatchUI);

    batchProcessing = false;
    updateBatchUI();
    const completedCount = batchQueue.filter(i => i.status === 'completed').length;
    const failedCount = batchQueue.filter(i => i.status === 'failed').length;
    if (completedCount + failedCount > 0) {
        showToast(`Batch upload complete: ${completedCount} finished, ${failedCount} failed.`);
        showBatchCompleteModal(completedCount, failedCount);
    }
}
```

- [ ] **Step 3: Extract the three pipeline stages**

Replace `app.js:316-438` (the whole `async function processBatchItem`) with:

```js
async function uploadItemVideo(movieId, file) {
    const videoRef = storageRef(storage, `videos/${movieId}.mp4`);
    await uploadBytesResumable(videoRef, file);
    return getDownloadURL(videoRef);
}

async function uploadThumbnailBlob(movieId, blob, name = 'batch-thumb.jpg') {
    const thumbRef = storageRef(storage, `thumbnails/${movieId}/${name}`);
    await uploadBytesResumable(thumbRef, blob);
    return getDownloadURL(thumbRef);
}

function isDuplicateMovie(title, year) {
    return existingMovieKeys.has(buildDuplicateKey(title, year));
}

// Transcribe -> AI metadata -> OMDb enrichment -> save. Shared by the MP4 batch
// queue and the bulk YouTube queue. Expects item.movieId, item.videoUrl,
// item.duration and item.thumbnailURL to already be set.
async function enrichAndSave(item, onUpdate = updateBatchUI) {
    item.status = 'transcribing';
    onUpdate();
    const transcriptId = await transcribeAudio(item.videoUrl);
    const transcript = await pollTranscription(transcriptId, () => { });
    item.transcriptText = transcript.text;
    item.status = 'transcribed';
    onUpdate();

    item.status = 'extracting-metadata';
    onUpdate();
    const sample = item.transcriptText.substring(0, 5000);
    const metadata = await extractMovieMetadata(sample);
    item.metadata = metadata;
    item.status = 'metadata-extracted';
    onUpdate();

    item.status = 'omdb';
    onUpdate();
    const { title, year } = metadata;
    let omdbYear = year;
    if (!omdbYear || omdbYear === 'N/A') {
        omdbYear = String(1998 + Math.floor(Math.random() * 26));
        item.metadata.year = omdbYear;
    }
    const omdb = await fetchMovieFromOMDB(title, omdbYear);
    if (omdb) {
        item.omdb = omdb;
        if (omdb.Poster && omdb.Poster !== 'N/A') {
            item.posterUrl = omdb.Poster;
        }
    }
    item.status = 'omdb-done';
    onUpdate();

    item.status = 'saving';
    onUpdate();
    const movieData = {
        id: item.movieId,
        title: metadata.title,
        year: item.metadata.year,
        description: metadata.description,
        categories: metadata.genres || [],
        duration: item.duration,
        thumbnail: item.thumbnailURL,
        videoURL: item.videoUrl,
        featuredThumbnail: item.posterUrl || null,
        updatedAt: Date.now()
    };
    // Checked before the write so this movie is not compared against itself.
    item.wasDuplicate = isDuplicateMovie(movieData.title, movieData.year);
    const movieRef = ref(db, 'movies/' + item.movieId);
    await set(movieRef, movieData);
}

async function processBatchItem(item) {
    item.status = 'uploading';
    updateBatchUI();

    const movieId = crypto.randomUUID();
    item.movieId = movieId;
    item.videoUrl = await uploadItemVideo(movieId, item.file);
    item.status = 'uploaded';
    updateBatchUI();

    // Extract duration and thumbnail from video file
    item.status = 'processing-video';
    updateBatchUI();
    const videoFile = item.file;
    let objectUrl = null;
    try {
        objectUrl = URL.createObjectURL(videoFile);
        const durationSeconds = await new Promise((resolve, reject) => {
            const v = document.createElement('video');
            v.preload = 'metadata';
            v.muted = true;
            v.src = objectUrl;
            v.onloadedmetadata = () => resolve(v.duration || 0);
            v.onerror = () => reject(new Error('Unable to read video metadata'));
        });
        item.duration = formatDuration(durationSeconds);
        updateBatchUI();

        const thumbnailBlob = await new Promise((resolve, reject) => {
            const v = document.createElement('video');
            v.preload = 'auto';
            v.muted = true;
            v.src = objectUrl;
            v.onloadedmetadata = () => {
                const safeDuration = v.duration || durationSeconds || 1;
                let targetTime = safeDuration * (0.1 + Math.random() * 0.7);
                if (!Number.isFinite(targetTime)) targetTime = Math.min(1, safeDuration);
                targetTime = Math.min(Math.max(targetTime, 0.2), Math.max(safeDuration - 0.2, 0.2));
                v.currentTime = targetTime;
            };
            v.onseeked = () => {
                const canvas = document.createElement('canvas');
                const width = 480;
                const height = 270;
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(v, 0, 0, width, height);
                canvas.toBlob((blob) => {
                    if (blob) resolve(blob);
                    else reject(new Error('Failed to capture thumbnail'));
                }, 'image/jpeg', 0.8);
            };
            v.onerror = () => reject(new Error('Failed to capture thumbnail'));
        });

        item.status = 'uploading-thumbnail';
        updateBatchUI();
        item.thumbnailURL = await uploadThumbnailBlob(movieId, thumbnailBlob);
        updateBatchUI();
    } finally {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
    }

    await enrichAndSave(item, updateBatchUI);
}
```

- [ ] **Step 4: Verify the MP4 batch flow is unchanged**

1. `npm run dev`, hard-refresh the dashboard.
2. Click **📦 Batch Upload** in the header, pick one small MP4 (`terra_nova.srt` is a subtitle,
   not a video — use any real MP4 you have), press **Start Batch Upload**.

Expected: the status badge walks through `Uploading video → Video uploaded → Processing video
→ Uploading thumbnail → Transcribing → Transcript ready → Extracting metadata → Metadata ready
→ Fetching OMDb data → Details enhanced → Saving → Completed`, then the completion modal shows
`Batch upload finished: 1 completed, 0 failed.` and the movie appears on the dashboard with a
captured frame thumbnail.

Console must be free of errors. This is a refactor — any behavior difference is a bug.

- [ ] **Step 5: Commit**

```bash
git add app.js
git commit -m "refactor: extract runQueue, uploadItemVideo, uploadThumbnailBlob, enrichAndSave"
```

---

## Task 6: Create `bulk-youtube.js` — Excel parsing and URL detection

**Files:**
- Create: `bulk-youtube.js`
- Modify: `app.js` (import and init)

- [ ] **Step 1: Create the module with parsing only**

Create `bulk-youtube.js`:

```js
// Bulk YouTube import.
//
// Parses an Excel/CSV file for YouTube links and runs each video through the
// movie pipeline that app.js injects. Knows nothing about Firebase directly.

const SHEETJS_URL = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs';

let deps = null;
let queue = [];
let processing = false;

let fileInput = null;
let qualitySelect = null;
let foundCountEl = null;
let queueEl = null;
let progressBar = null;
let startBtn = null;
let retryBtn = null;
let clearBtn = null;

export function isBulkProcessing() {
    return processing;
}

export function initBulkYoutube(injected) {
    deps = injected;

    fileInput = document.getElementById('bulk-excel-file');
    qualitySelect = document.getElementById('bulk-quality');
    foundCountEl = document.getElementById('bulk-found-count');
    queueEl = document.getElementById('bulk-queue');
    progressBar = document.getElementById('bulk-progress-bar');
    startBtn = document.getElementById('bulk-start-btn');
    retryBtn = document.getElementById('bulk-retry-btn');
    clearBtn = document.getElementById('bulk-clear-btn');

    fileInput?.addEventListener('change', handleFileSelected);
}

async function handleFileSelected(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    setFoundText('Reading file…');
    try {
        const videoIds = await parseWorkbookForVideoIds(file);
        if (!videoIds.length) {
            queue = [];
            setFoundText('No YouTube URLs found in that file.');
            return;
        }
        queue = videoIds.map((videoId) => createQueueItem(videoId));
        setFoundText(`Found ${queue.length} URL${queue.length === 1 ? '' : 's'}.`);
    } catch (error) {
        queue = [];
        setFoundText(error.message);
    }
}

function createQueueItem(videoId) {
    return {
        id: crypto.randomUUID(),
        videoId,
        status: 'queued',
        error: null,
        title: null,
        duration: null,
        thumbnailURL: null,
        youtubeThumbnail: null,
        downloadedMb: null,
        wasDuplicate: false,
        movieId: null,
        videoUrl: null,
        metadata: null
    };
}

function setFoundText(text) {
    if (foundCountEl) foundCountEl.textContent = text;
}

// Scans every cell of every sheet, checking both the displayed text and any
// hyperlink target, so a cell reading "Watch" that links to YouTube still counts.
async function parseWorkbookForVideoIds(file) {
    let XLSX;
    try {
        XLSX = await import(SHEETJS_URL);
    } catch (error) {
        throw new Error('Could not load the Excel reader. Check your internet connection.');
    }

    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: 'array' });

    const seen = new Set();
    const found = [];

    workbook.SheetNames.forEach((sheetName) => {
        const sheet = workbook.Sheets[sheetName];
        if (!sheet || !sheet['!ref']) return;
        const range = XLSX.utils.decode_range(sheet['!ref']);
        for (let r = range.s.r; r <= range.e.r; r++) {
            for (let c = range.s.c; c <= range.e.c; c++) {
                const cell = sheet[XLSX.utils.encode_cell({ r, c })];
                if (!cell) continue;
                const candidates = [cell.w, cell.v, cell.l?.Target];
                for (const candidate of candidates) {
                    if (typeof candidate !== 'string') continue;
                    const videoId = deps.extractYouTubeVideoId(candidate);
                    if (!videoId || seen.has(videoId)) continue;
                    seen.add(videoId);
                    found.push(videoId);
                }
            }
        }
    });

    return found;
}
```

- [ ] **Step 2: Import and initialise it from `app.js`**

Add to the top of `app.js`, immediately after the Firebase storage import block
(after `app.js:17`):

```js
import { initBulkYoutube, isBulkProcessing } from './bulk-youtube.js';
```

Then add near the bottom of `app.js`, after the
`document.getElementById('generate-ai-thumbnail-btn')?.addEventListener(...)` line
(`app.js:2203`):

```js
initBulkYoutube({
    extractYouTubeVideoId,
    uploadItemVideo,
    uploadThumbnailBlob,
    enrichAndSave,
    formatDuration,
    showToast,
    showBatchCompleteModal,
    runQueue
});
```

- [ ] **Step 3: Build a test fixture**

Write this to the scratchpad and run it. It builds a real `.xlsx` with Python's stdlib only —
no new dependencies, and it deliberately spreads the links across columns with a header row
and includes one duplicate and one bad video ID.

```bash
cat > /tmp/make_fixture.py <<'PY'
import zipfile

ROWS = [
    ["Movie", "Link", "Notes"],
    ["Inception", "https://www.youtube.com/watch?v=YoHD9XEInc0", "valid"],
    ["Broken", "https://youtu.be/aaaaaaaaaaa", "should fail"],
    ["Interstellar", "https://www.youtube.com/watch?v=zSWdZVtXT7E", "valid"],
    ["Dupe", "https://www.youtube.com/watch?v=YoHD9XEInc0", "duplicate row"],
]

def esc(v):
    return v.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

rows_xml = []
for r, row in enumerate(ROWS, start=1):
    cells = ""
    for c, value in enumerate(row):
        if not value:
            continue
        ref = f"{chr(65 + c)}{r}"
        cells += f'<c r="{ref}" t="inlineStr"><is><t>{esc(value)}</t></is></c>'
    rows_xml.append(f'<row r="{r}">{cells}</row>')

sheet = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
         '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
         f'<sheetData>{"".join(rows_xml)}</sheetData></worksheet>')

content_types = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    '<Default Extension="xml" ContentType="application/xml"/>'
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
    '</Types>')

rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    '</Relationships>')

workbook = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>')

wb_rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
    '</Relationships>')

out = "/tmp/bulk-youtube-sample.xlsx"
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml", content_types)
    z.writestr("_rels/.rels", rels)
    z.writestr("xl/workbook.xml", workbook)
    z.writestr("xl/_rels/workbook.xml.rels", wb_rels)
    z.writestr("xl/worksheets/sheet1.xml", sheet)
print("wrote", out)
PY
python3 /tmp/make_fixture.py
```

Expected output: `wrote /tmp/bulk-youtube-sample.xlsx`

- [ ] **Step 4: Verify parsing in the browser**

1. Hard-refresh, open **Add New Movie**, click **📊 Bulk YouTube**.
2. Choose `/tmp/bulk-youtube-sample.xlsx`.

Expected: the line under the controls reads **`Found 3 URLs.`** — three, not four, because the
duplicate `YoHD9XEInc0` row is deduped, and the header row contributes nothing.

3. Build a link-free file and select it:

```bash
printf 'Movie,Notes\nInception,no link here\nTenet,also nothing\n' > /tmp/no-links.csv
```

Expected: `No YouTube URLs found in that file.`

Console must have no errors. If you see a CORS or module error for `cdn.sheetjs.com`, the CDN
import failed — check the network tab.

- [ ] **Step 5: Commit**

```bash
git add bulk-youtube.js app.js
git commit -m "feat: parse Excel/CSV files for YouTube URLs"
```

---

## Task 7: Render the bulk queue

**Files:**
- Modify: `bulk-youtube.js`

- [ ] **Step 1: Add the renderer**

Append to `bulk-youtube.js`:

```js
const BULK_STATUS_LABELS = {
    queued: 'Queued',
    'fetching-info': 'Fetching info',
    downloading: 'Downloading',
    uploading: 'Uploading video',
    'uploading-thumbnail': 'Uploading thumbnail',
    transcribing: 'Transcribing',
    transcribed: 'Transcript ready',
    'extracting-metadata': 'Extracting metadata',
    'metadata-extracted': 'Metadata ready',
    omdb: 'Fetching OMDb data',
    'omdb-done': 'Details enhanced',
    saving: 'Saving',
    completed: 'Completed',
    failed: 'Failed'
};

function statusCategory(status) {
    if (!status || status === 'queued') return 'queued';
    if (status === 'completed') return 'completed';
    if (status === 'failed') return 'failed';
    return 'processing';
}

function renderQueue() {
    if (!queueEl) return;
    queueEl.innerHTML = '';

    if (!queue.length) {
        const empty = document.createElement('li');
        empty.className = 'batch-item-empty';
        empty.textContent = 'No URLs loaded yet.';
        queueEl.appendChild(empty);
    } else {
        queue.forEach((item) => {
            const li = document.createElement('li');
            li.className = 'batch-item';

            const thumb = document.createElement('div');
            thumb.className = 'batch-item-thumb';
            if (item.thumbnailURL || item.youtubeThumbnail) {
                const img = document.createElement('img');
                img.src = item.thumbnailURL || item.youtubeThumbnail;
                img.alt = item.title || item.videoId;
                thumb.appendChild(img);
            } else {
                thumb.textContent = 'Preview';
            }

            const details = document.createElement('div');
            details.className = 'batch-item-details';

            const title = document.createElement('div');
            title.className = 'title';
            title.textContent = item.metadata?.title || item.title || item.videoId;
            if (item.wasDuplicate) {
                const tag = document.createElement('span');
                tag.className = 'batch-item-tag';
                tag.textContent = '⚠ duplicate';
                title.appendChild(tag);
            }

            const meta = document.createElement('div');
            meta.className = 'meta';
            const parts = [`youtube.com/watch?v=${item.videoId}`];
            if (item.duration) parts.push(`Duration: ${item.duration}`);
            if (item.status === 'downloading' && item.downloadedMb) {
                parts.push(`${item.downloadedMb} MB`);
            }
            meta.textContent = parts.join(' · ');

            details.append(title, meta);

            const statusWrap = document.createElement('div');
            statusWrap.className = 'batch-item-status';
            const badge = document.createElement('span');
            const category = statusCategory(item.status);
            badge.className = `status-badge ${category}`;
            badge.textContent = BULK_STATUS_LABELS[item.status] || item.status;
            statusWrap.appendChild(badge);

            if (item.error) {
                const errorEl = document.createElement('span');
                errorEl.className = 'batch-item-error';
                errorEl.textContent = item.error;
                statusWrap.appendChild(errorEl);
            }

            li.append(thumb, details, statusWrap);
            queueEl.appendChild(li);
        });
    }

    const completed = queue.filter(i => i.status === 'completed').length;
    const failed = queue.filter(i => i.status === 'failed').length;
    const hasQueued = queue.some(i => i.status === 'queued');

    if (progressBar) {
        const pct = queue.length
            ? Math.round(((completed + failed) / queue.length) * 100)
            : 0;
        progressBar.style.width = `${pct}%`;
    }

    if (startBtn) startBtn.disabled = processing || !hasQueued;
    if (retryBtn) retryBtn.disabled = processing || failed === 0;
    if (clearBtn) clearBtn.disabled = processing || !queue.length;
    if (fileInput) fileInput.disabled = processing;
    if (qualitySelect) qualitySelect.disabled = processing;
}
```

- [ ] **Step 2: Call the renderer from the existing handlers**

In `initBulkYoutube`, add `renderQueue();` as the last line of the function body (after the
`fileInput?.addEventListener(...)` line).

In `handleFileSelected`, add `renderQueue();` at the end of **each** of the three exit paths —
after `setFoundText('No YouTube URLs found in that file.');`, after the
`setFoundText(\`Found ${queue.length} URL...\`)` line, and after
`setFoundText(error.message);` in the `catch`.

- [ ] **Step 3: Add the Clear handler**

In `initBulkYoutube`, after the `fileInput?.addEventListener` line, add:

```js
    clearBtn?.addEventListener('click', () => {
        if (processing) return;
        queue = [];
        if (fileInput) fileInput.value = '';
        setFoundText('No file selected.');
        renderQueue();
    });
```

- [ ] **Step 4: Verify in the browser**

1. Hard-refresh, open **Add New Movie → 📊 Bulk YouTube**.

Expected on open: the queue area shows the dashed empty box reading `No URLs loaded yet.`, and
all three buttons are disabled.

2. Choose `/tmp/bulk-youtube-sample.xlsx`.

Expected: `Found 3 URLs.` plus three rows, each showing `Preview` in the thumb box, the text
`youtube.com/watch?v=<id>`, and a grey `Queued` badge. **Start Import** and **Clear** become
enabled; **Retry Failed** stays disabled.

3. Press **Clear**.

Expected: the list returns to `No URLs loaded yet.`, the text returns to `No file selected.`,
and all three buttons disable again.

- [ ] **Step 5: Commit**

```bash
git add bulk-youtube.js
git commit -m "feat: render the bulk YouTube queue"
```

---

## Task 8: The per-item worker and the import run

**Files:**
- Modify: `bulk-youtube.js`

- [ ] **Step 1: Add the download semaphore and network helpers**

Append to `bulk-youtube.js`:

```js
// Only one yt-dlp download runs at a time — two concurrent downloads invite
// throttling from YouTube. Item B downloads while item A transcribes.
let downloadChain = Promise.resolve();

function withDownloadSlot(task) {
    const result = downloadChain.then(task, task);
    downloadChain = result.catch(() => { });
    return result;
}

async function fetchVideoInfo(videoId) {
    const res = await fetch(`/api/youtube-info?videoId=${encodeURIComponent(videoId)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to fetch video info');
    return data;
}

async function fetchThumbnailBlob(url) {
    try {
        const res = await fetch(`/api/proxy-image?url=${encodeURIComponent(url)}`);
        if (!res.ok) return null;
        return await res.blob();
    } catch (error) {
        return null;
    }
}

async function downloadVideoFile(item, quality) {
    const res = await fetch(
        `/api/youtube-download?videoId=${encodeURIComponent(item.videoId)}` +
        `&quality=${encodeURIComponent(quality)}`
    );
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || 'Download failed');
    }

    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    let lastReportedMb = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        const mb = received / (1024 * 1024);
        // Re-render at most once per megabyte — the queue is rebuilt on every call.
        if (mb - lastReportedMb >= 1) {
            lastReportedMb = mb;
            item.downloadedMb = mb.toFixed(1);
            renderQueue();
        }
    }

    if (!received) throw new Error('Download returned no data');

    const blob = new Blob(chunks, { type: 'video/mp4' });
    const name = (item.title || item.videoId).replace(/[^a-zA-Z0-9_\-. ]/g, '').trim();
    return new File([blob], `${name || item.videoId}.mp4`, { type: 'video/mp4' });
}
```

- [ ] **Step 2: Add the worker**

Append to `bulk-youtube.js`:

```js
async function processBulkItem(item) {
    const quality = qualitySelect?.value || '360p';

    const file = await withDownloadSlot(async () => {
        item.status = 'fetching-info';
        renderQueue();
        const info = await fetchVideoInfo(item.videoId);
        item.title = info.title || item.videoId;
        item.duration = info.duration ? deps.formatDuration(info.duration) : null;
        item.youtubeThumbnail = info.thumbnail || null;

        item.status = 'downloading';
        renderQueue();
        return downloadVideoFile(item, quality);
    });

    item.movieId = crypto.randomUUID();
    item.status = 'uploading';
    renderQueue();
    item.videoUrl = await deps.uploadItemVideo(item.movieId, file);

    item.status = 'uploading-thumbnail';
    renderQueue();
    if (item.youtubeThumbnail) {
        const blob = await fetchThumbnailBlob(item.youtubeThumbnail);
        if (blob) {
            item.thumbnailURL = await deps.uploadThumbnailBlob(item.movieId, blob, 'yt-thumb.jpg');
        }
    }
    renderQueue();

    await deps.enrichAndSave(item, renderQueue);
}
```

- [ ] **Step 3: Add the run driver and the Start handler**

Append to `bulk-youtube.js`:

```js
async function runBulkImport() {
    if (processing) return;
    const runnable = queue.filter(item => item.status === 'queued');
    if (!runnable.length) return;

    processing = true;
    renderQueue();

    await deps.runQueue(runnable, processBulkItem, 2, renderQueue);

    processing = false;
    renderQueue();

    const completed = queue.filter(i => i.status === 'completed').length;
    const failed = queue.filter(i => i.status === 'failed').length;
    const duplicates = queue.filter(i => i.status === 'completed' && i.wasDuplicate).length;

    let message = `Bulk import complete: ${completed} imported, ${failed} failed.`;
    if (duplicates) {
        message += ` (${duplicates} possible duplicate${duplicates === 1 ? '' : 's'})`;
    }
    deps.showToast(message);
    deps.showBatchCompleteModal(completed, failed);
}
```

In `initBulkYoutube`, add after the `clearBtn` listener:

```js
    startBtn?.addEventListener('click', runBulkImport);
```

- [ ] **Step 4: Verify end to end**

1. `npm run dev`, hard-refresh, open **Add New Movie → 📊 Bulk YouTube**.
2. Choose `/tmp/bulk-youtube-sample.xlsx`, leave quality at 360p, press **Start Import**.

Expected, in order:
- Rows move through `Fetching info → Downloading → Uploading video → Uploading thumbnail →
  Transcribing → … → Saving → Completed`.
- The `Downloading` row shows a growing megabyte count in its meta line.
- **Only one row is ever in `Fetching info` or `Downloading` at a time** — this proves the
  semaphore works. Two rows may show later stages simultaneously.
- The bad row `aaaaaaaaaaa` ends as a red `Failed` badge with a yt-dlp error message beneath
  it, **and the other two rows keep going**. This is the core requirement.
- Each successful row's thumbnail box fills with the YouTube thumbnail.
- On finish: a toast reading `Bulk import complete: 2 imported, 1 failed.` and the completion
  modal.
- Both imported movies appear on the dashboard with a real title, year, poster and duration.

- [ ] **Step 5: Commit**

```bash
git add bulk-youtube.js
git commit -m "feat: run bulk YouTube imports with per-item failure isolation"
```

---

## Task 9: Retry Failed, and guards while importing

**Files:**
- Modify: `bulk-youtube.js`
- Modify: `app.js:1015-1018` (`closeForm`), `app.js:1060-1075` (`resetMediaInputs`), `app.js` (`setSourceMode`)

- [ ] **Step 1: Add Retry Failed and the reset export**

Append to `bulk-youtube.js`:

```js
export function resetBulkYoutube() {
    if (processing) return;
    queue = [];
    if (fileInput) fileInput.value = '';
    setFoundText('No file selected.');
    renderQueue();
}
```

In `initBulkYoutube`, add after the `startBtn` listener:

```js
    retryBtn?.addEventListener('click', () => {
        if (processing) return;
        queue.forEach((item) => {
            if (item.status !== 'failed') return;
            item.status = 'queued';
            item.error = null;
            item.downloadedMb = null;
        });
        renderQueue();
        runBulkImport();
    });
```

- [ ] **Step 2: Import `resetBulkYoutube` in `app.js`**

Change the import line added in Task 6 to:

```js
import { initBulkYoutube, isBulkProcessing, resetBulkYoutube } from './bulk-youtube.js';
```

- [ ] **Step 3: Guard `closeForm`**

Replace `app.js:1015-1018`:

```js
function closeForm() {
    movieFormPanel.classList.add('hidden');
    videoPreview.pause();
}
```

with:

```js
function closeForm() {
    if (isBulkProcessing()) {
        alert('Bulk import is still running. Please wait for it to finish.');
        return;
    }
    movieFormPanel.classList.add('hidden');
    videoPreview.pause();
}
```

- [ ] **Step 4: Guard tab switching**

In `setSourceMode` (added in Task 4), add as the first line of the function body:

```js
    if (isBulkProcessing()) return;
```

- [ ] **Step 5: Reset bulk state with the rest of the form**

In `resetMediaInputs`, replace the YouTube reset block at `app.js:1060-1075`:

```js
    // Reset YouTube section
    const youtubeUrl = document.getElementById('youtube-url');
    const youtubePreview = document.getElementById('youtube-preview');
    const youtubeProgress = document.getElementById('youtube-download-progress');
    const youtubeSection = document.getElementById('youtube-input-section');
    const dropZoneEl = document.getElementById('video-drop-zone');
    if (youtubeUrl) youtubeUrl.value = '';
    if (youtubePreview) youtubePreview.classList.add('hidden');
    if (youtubeProgress) youtubeProgress.classList.add('hidden');
    // Reset to "Upload File" mode
    document.getElementById('source-file-btn')?.classList.add('active');
    document.getElementById('source-youtube-btn')?.classList.remove('active');
    if (youtubeSection) youtubeSection.classList.add('hidden');
    if (dropZoneEl) dropZoneEl.classList.remove('hidden');
```

with:

```js
    // Reset YouTube section
    const youtubeUrl = document.getElementById('youtube-url');
    const youtubePreview = document.getElementById('youtube-preview');
    const youtubeProgress = document.getElementById('youtube-download-progress');
    if (youtubeUrl) youtubeUrl.value = '';
    if (youtubePreview) youtubePreview.classList.add('hidden');
    if (youtubeProgress) youtubeProgress.classList.add('hidden');

    // Reset bulk section and return to "Upload File" mode
    resetBulkYoutube();
    setSourceMode('source-file-btn');
```

`setSourceMode` is declared with `function`, so it is hoisted and safe to call from
`resetMediaInputs` even though it appears later in the file.

- [ ] **Step 6: Verify the guards**

1. Hard-refresh, open **Add New Movie → 📊 Bulk YouTube**, load
   `/tmp/bulk-youtube-sample.xlsx`, press **Start Import**.
2. **While it is running**, try each of: clicking the modal's `×`, clicking the `Upload File`
   tab, clicking `Clear`.

Expected: `×` shows the alert `Bulk import is still running. Please wait for it to finish.`;
the tab does not switch; Clear is disabled. The file input and quality dropdown are also
disabled.

3. Let it finish. Press **Retry Failed**.

Expected: only the previously failed row returns to `Queued` and re-runs; the two completed
rows keep their `Completed` badges and are not re-imported.

4. Close the modal, then reopen **Add New Movie**.

Expected: it opens on the `Upload File` tab with Movie Details visible, and the bulk queue is
empty (`No URLs loaded yet.` / `No file selected.`).

- [ ] **Step 7: Commit**

```bash
git add app.js bulk-youtube.js
git commit -m "feat: retry failed bulk rows and guard the modal while importing"
```

---

## Task 10: Duplicate flagging and full-pass verification

**Files:**
- No code changes expected. This task confirms the spec end to end.

- [ ] **Step 1: Verify duplicate flagging**

The two movies from Task 8 are already in the database, and Task 1 made
`existingMovieKeys` populate from the live listener.

1. Hard-refresh so the movies listener repopulates `existingMovieKeys`.
2. Open **Add New Movie → 📊 Bulk YouTube**, load `/tmp/bulk-youtube-sample.xlsx` again, press
   **Start Import**.

Expected: both valid rows import again (they are **not** skipped — this was the explicit
decision), each completed row shows a yellow `⚠ duplicate` tag beside its title, and the toast
reads `Bulk import complete: 2 imported, 1 failed. (2 possible duplicates)`.

3. Delete the duplicate movies from the dashboard to clean up.

- [ ] **Step 2: Verify CSV works through the same path**

```bash
cat > /tmp/bulk-youtube-sample.csv <<'CSV'
Movie,Link,Notes
Inception,https://www.youtube.com/watch?v=YoHD9XEInc0,valid
Broken,https://youtu.be/aaaaaaaaaaa,should fail
CSV
```

Load `/tmp/bulk-youtube-sample.csv` in the bulk panel.

Expected: `Found 2 URLs.` — SheetJS reads CSV through the identical code path.

- [ ] **Step 3: Verify the MP4 batch flow still works**

Click **📦 Batch Upload** in the header, queue one MP4, run it.

Expected: unchanged behavior from before this feature — completes and saves. This confirms the
Task 5 refactor did not regress the original flow.

- [ ] **Step 4: Check for console errors**

Reload the dashboard and open every modal once. The devtools Console must show no errors
(warnings about a missing AssemblyAI or OMDb key are pre-existing and fine).

- [ ] **Step 5: Commit any fixes and finish**

```bash
git add -A
git commit -m "test: verify bulk YouTube import end to end"
```

If no fixes were needed, skip the commit.

---

## Self-review notes

Spec requirements mapped to tasks:

| Spec section | Task |
|---|---|
| Third tab in Add New Movie, hides drop zone / URL section / Movie Details | 2, 4 |
| `bulk-youtube.js` module with injected deps | 6 |
| Extract `uploadItemVideo`, `uploadThumbnailBlob`, `enrichAndSave`, `runQueue` | 5 |
| Per-item pipeline with YouTube thumbnail and `youtube-info` duration | 8 |
| Concurrency 2 with download semaphore of 1 | 8 |
| SheetJS via dynamic CDN import; all sheets; hyperlink targets; dedupe | 6 |
| Per-item failure isolation | 5 (`runQueue`), verified in 8 |
| Retry Failed | 9 |
| Duplicates imported and tagged, checked before write | 5 (`wasDuplicate`), 7 (tag), 10 |
| New statuses `fetching-info`, `downloading` | 5 |
| Markup ids and `#metadata-section` | 2 |
| CSS reuse plus bulk additions | 3 |
| Tab guards and reset | 9 |

Known deviation from the spec, deliberate: the spec did not mention that
`existingMovieKeys` was never populated. Task 1 fixes that as a prerequisite, since duplicate
flagging is unimplementable without it.
