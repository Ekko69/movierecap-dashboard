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

    clearBtn?.addEventListener('click', () => {
        if (processing) return;
        queue = [];
        if (fileInput) fileInput.value = '';
        setFoundText('No file selected.');
        renderQueue();
    });

    startBtn?.addEventListener('click', runBulkImport);

    retryBtn?.addEventListener('click', () => {
        if (processing) return;
        queue.forEach((item) => {
            if (item.status !== 'failed') return;
            item.status = 'queued';
            item.error = null;
            item.downloadedMb = null;
            item.thumbnailNote = null;
            item.usedAiThumbnail = false;
        });
        renderQueue();
        runBulkImport();
    });

    renderQueue();
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
            renderQueue();
            return;
        }
        queue = videoIds.map((videoId) => createQueueItem(videoId));
        setFoundText(`Found ${queue.length} URL${queue.length === 1 ? '' : 's'}.`);
        renderQueue();
    } catch (error) {
        queue = [];
        setFoundText(error.message);
        renderQueue();
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
        usedAiThumbnail: false,
        thumbnailNote: null,
        wasDuplicate: false,
        skipReason: null,
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

const BULK_STATUS_LABELS = {
    queued: 'Queued',
    'fetching-info': 'Fetching info',
    downloading: 'Downloading',
    'ai-thumbnail': 'Generating AI thumbnail',
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
    failed: 'Failed',
    skipped: 'Skipped'
};

function statusCategory(status) {
    if (!status || status === 'queued') return 'queued';
    if (status === 'completed') return 'completed';
    if (status === 'failed') return 'failed';
    if (status === 'skipped') return 'skipped';
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

            if (item.skipReason) {
                const skipEl = document.createElement('span');
                skipEl.className = 'batch-item-error';
                skipEl.textContent = item.skipReason;
                statusWrap.appendChild(skipEl);
            }

            // A thumbnail that fell back is not a failed import, but the row
            // should still say so rather than quietly looking like a success.
            if (item.thumbnailNote) {
                const noteEl = document.createElement('span');
                noteEl.className = 'batch-item-error';
                noteEl.textContent = item.thumbnailNote;
                statusWrap.appendChild(noteEl);
            }

            li.append(thumb, details, statusWrap);
            queueEl.appendChild(li);
        });
    }

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

    if (startBtn) startBtn.disabled = processing || !hasQueued;
    if (retryBtn) retryBtn.disabled = processing || failed === 0;
    if (clearBtn) clearBtn.disabled = processing || !queue.length;
    if (fileInput) fileInput.disabled = processing;
    if (qualitySelect) qualitySelect.disabled = processing;
}

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

// Resolve the thumbnail for one item. When the ✨ Auto AI Thumbnail toggle is on
// we run the video's YouTube thumbnail through the AI generator; if that fails we
// fall back to the plain YouTube thumbnail rather than failing the whole import —
// losing a movie over a thumbnail would be a bad trade.
async function resolveThumbnailBlob(item) {
    if (deps.isAutoAiThumbnailEnabled()) {
        item.status = 'ai-thumbnail';
        renderQueue();
        try {
            const aiBlob = await deps.generateAIThumbnailBlob(item.youtubeThumbnail);
            if (aiBlob) {
                item.usedAiThumbnail = true;
                return aiBlob;
            }
        } catch (error) {
            item.thumbnailNote = `AI thumbnail failed: ${error.message}`;
            console.error('[bulk AI thumbnail]', item.videoId, error);
        }
    }
    return fetchThumbnailBlob(item.youtubeThumbnail);
}

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

    if (item.youtubeThumbnail) {
        const thumbBlob = await resolveThumbnailBlob(item);
        if (thumbBlob) {
            item.status = 'uploading-thumbnail';
            renderQueue();
            item.thumbnailURL = await deps.uploadThumbnailBlob(
                item.movieId,
                thumbBlob,
                item.usedAiThumbnail ? 'ai-thumb.jpg' : 'yt-thumb.jpg'
            );
        }
    }
    renderQueue();

    await deps.enrichAndSave(item, renderQueue);
}

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
    deps.showToast(message);
    deps.showBatchCompleteModal(completed, failed);
}

export function resetBulkYoutube() {
    if (processing) return;
    queue = [];
    if (fileInput) fileInput.value = '';
    setFoundText('No file selected.');
    renderQueue();
}
