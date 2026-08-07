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
