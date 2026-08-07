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
