// Firebase Imports
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
    getDatabase,
    ref,
    push,
    set,
    onValue,
    remove,
    update
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import {
    getStorage,
    ref as storageRef,
    uploadBytesResumable,
    getDownloadURL,
    deleteObject
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";
import { initBulkYoutube, isBulkProcessing, resetBulkYoutube } from './bulk-youtube.js';
import {
    youtubeWatchURL,
    youtubeThumbnailURL,
    videoIdFromSourceURL,
    formatRelativeTime,
    pickLastAdded
} from './last-added.js';
import {
    TARGET_LANG,
    ADMIN_NAME,
    detectScript,
    needsTranslation,
    flattenComments,
    collectTranslatable,
    formatAdminReply,
    createTranslationScheduler,
    MAX_TRANSLATE_CHARS,
    replyLanguage,
    deletionWrites,
    clipText
} from './comments.js';
import { initAnalyticsView } from './analytics-view.js';

// Firebase Config
// Firebase Config
if (!window.CONFIG) {
    alert("Configuration missing! Please Rename config.example.js to config.js and update it.");
    throw new Error("Configuration missing");
}

const firebaseConfig = window.CONFIG.firebaseConfig;
if (!firebaseConfig) {
    alert("Firebase configuration missing in config.js!");
    throw new Error("Firebase configuration missing");
}

const ASSEMBLY_AI_KEY = window.CONFIG.assemblyAIKey;
if (!ASSEMBLY_AI_KEY) {
    console.warn("AssemblyAI key missing in config.js. automated transcription will be disabled.");
    console.warn("AssemblyAI key missing in config.js. automated transcription will be disabled.");
}

const OMDB_API_KEY = window.CONFIG.omdbApiKey || "74095f81";
if (!window.CONFIG.omdbApiKey) {
    console.warn("OMDB API Key missing in config.js, using default key.");
}


// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const storage = getStorage(app);

// OpenAI Configuration
// OpenAI Configuration
// API Key is now handled on the server side (Vercel Functions)
const AI_API_URL = '/api/ai-service';

// Duplicate Detection Helpers
function normalizeTitle(title) {
    return (title || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function buildDuplicateKey(title, year) {
    const t = normalizeTitle(title);
    const y = year && year !== '' ? String(year).trim() : 'N/A';
    return `${t}::${y}`;
}

let existingMoviesByKey = new Map();
// Video id -> movie, for recognising an already-imported YouTube video before
// anything is fetched or downloaded. Only movies imported since sourceURL
// shipped appear here; older records have no source to key on.
let existingMoviesByVideoId = new Map();
// Comment rows carry only a movieId; the comments inbox shows titles.
let moviesById = new Map();
// Duplicate key the banner was last shown for, so Save does not warn a second time.
let warnedDuplicateKey = null;
// Duplicate key the user explicitly dismissed, so the banner stays hidden for it.
let dismissedDuplicateKey = null;
// True while handleFormSubmit is awaiting an upload/save. The form panel stays open
// and interactive throughout, so the banner must not swap the form out from under it.
let isSavingMovie = false;


// DOM Elements
const movieFormPanel = document.getElementById('movie-form-panel');
const movieForm = document.getElementById('movie-form');
const addMovieBtn = document.getElementById('add-movie-toggle');
const closeFormBtn = document.getElementById('close-form-btn');
const cancelFormBtn = document.getElementById('cancel-form');
const moviesContainer = document.getElementById('movies-container');
const searchInput = document.getElementById('search-input');

// Video & Thumbnail Elements
const videoInput = document.getElementById('video-file');
const videoPreview = document.getElementById('video-preview');
const dropZone = document.getElementById('video-drop-zone');
const changeVideoBtn = document.getElementById('change-video-btn');
const captureBtn = document.getElementById('capture-btn');
const editThumbnailBtn = document.getElementById('edit-thumbnail-btn');
const thumbnailImg = document.getElementById('thumbnail-img');
const captureCanvas = document.getElementById('capture-canvas');
const thumbPlaceholder = document.getElementById('thumb-placeholder');

// Featured Thumbnail Elements (Poster)
const featuredInput = document.getElementById('featured-thumbnail-file');
const featuredPreview = document.getElementById('featured-thumbnail-img');
const featuredPlaceholder = document.getElementById('featured-thumb-placeholder');
const removeFeaturedBtn = document.getElementById('remove-featured-btn');
const featuredDropContent = document.getElementById('featured-drop-content');
const posterSyncStatus = document.getElementById('poster-sync-status');

// Batch upload modal + queue
const openBatchBtn = document.getElementById('open-batch-upload');
const batchModal = document.getElementById('batch-upload-modal');
const batchInput = document.getElementById('batch-video-files');
const batchQueueEl = document.getElementById('batch-queue');
const batchProgressBar = document.getElementById('batch-progress-bar');
const startBatchBtn = document.getElementById('start-batch-btn');
const batchClearBtn = document.getElementById('batch-clear-btn');
const closeBatchBtn = document.getElementById('close-batch-upload');
const batchCloseFooter = document.getElementById('batch-close-footer');
const batchSummaryEl = document.getElementById('batch-summary');
const toastEl = document.getElementById('toast');
const batchCompleteModal = document.getElementById('batch-complete-modal');
const batchCompleteMessage = document.getElementById('batch-complete-message');
const batchCompleteClose = document.getElementById('batch-complete-close');
const batchCompleteOk = document.getElementById('batch-complete-ok');

let batchQueue = [];
let batchProcessing = false;
let toastTimeout = null;

function isSafeThumbnailSrc(src) {
    if (!src) return false;
    if (src.startsWith('blob:') || src.startsWith('data:')) return true;
    try {
        const resolved = new URL(src, window.location.origin);
        return resolved.origin === window.location.origin;
    } catch (error) {
        return false;
    }
}

// Whether a stored src is safe to hand to an <img>. Deliberately NOT
// isSafeThumbnailSrc: that one is a canvas-taint test (same-origin only), and every
// thumbnail we persist is cross-origin (firebasestorage.googleapis.com, i.ytimg.com),
// so reusing it here would reject all of them. An <img> src is a passive sink, so a
// scheme allow-list is the right check — it keeps out javascript: and other actives.
function isDisplayableImageSrc(src) {
    if (!src) return false;
    return /^(https:|blob:|data:image\/(png|jpe?g|gif|webp);)/i.test(src);
}

const STATUS_LABELS = {
    queued: 'Queued',
    'fetching-info': 'Fetching info',
    downloading: 'Downloading',
    'ai-thumbnail': 'Generating AI thumbnail',
    uploading: 'Uploading video',
    uploaded: 'Video uploaded',
    'processing-video': 'Processing video',
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

openBatchBtn?.addEventListener('click', () => {
    batchModal?.classList.remove('hidden');
    updateBatchUI();
});

function closeBatchModal() {
    batchModal?.classList.add('hidden');
}

closeBatchBtn?.addEventListener('click', closeBatchModal);
batchCloseFooter?.addEventListener('click', closeBatchModal);

batchModal?.addEventListener('click', (e) => {
    if (e.target === batchModal) {
        closeBatchModal();
    }
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && batchModal && !batchModal.classList.contains('hidden')) {
        closeBatchModal();
    }
});

batchInput?.addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    files.forEach((file) => {
        batchQueue.push({
            id: crypto.randomUUID(),
            file,
            status: 'queued',
            error: null,
            metadata: null,
            duration: null,
            thumbnailURL: null
        });
    });
    batchInput.value = '';
    updateBatchUI();
});

batchClearBtn?.addEventListener('click', () => {
    if (batchProcessing) return;
    batchQueue = [];
    if (batchInput) batchInput.value = '';
    updateBatchUI();
});

startBatchBtn?.addEventListener('click', () => {
    if (batchProcessing) return;
    processBatch(2);
});

updateBatchUI();

function getStatusInfo(status) {
    const label = STATUS_LABELS[status] || (status ? status.replace(/-/g, ' ') : 'Queued');
    let category = 'processing';
    if (!status || status === 'queued') category = 'queued';
    else if (status === 'completed') category = 'completed';
    else if (status === 'failed') category = 'failed';
    return { label, category };
}

function formatDuration(seconds) {
    const total = Math.max(Math.floor(seconds || 0), 0);
    const minutes = Math.floor(total / 60);
    const sec = String(total % 60).padStart(2, '0');
    return `${minutes}:${sec}`;
}

function showToast(message) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.classList.add('show');
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
        toastEl.classList.remove('show');
    }, 6000);
}

toastEl?.addEventListener('click', () => {
    toastEl.classList.remove('show');
});

function showBatchCompleteModal(completedCount, failedCount, skippedCount = 0) {
    if (!batchCompleteModal || !batchCompleteMessage) return;
    let message = `Batch upload finished: ${completedCount} completed, ${failedCount} failed`;
    if (skippedCount) message += `, ${skippedCount} skipped as duplicate${skippedCount === 1 ? '' : 's'}`;
    batchCompleteMessage.textContent = `${message}.`;
    batchCompleteModal.classList.remove('hidden');
}

function hideBatchCompleteModal() {
    batchCompleteModal?.classList.add('hidden');
}

batchCompleteClose?.addEventListener('click', hideBatchCompleteModal);
batchCompleteOk?.addEventListener('click', hideBatchCompleteModal);
batchCompleteModal?.addEventListener('click', (e) => {
    if (e.target === batchCompleteModal) hideBatchCompleteModal();
});

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
                    // A worker may settle the item itself — the bulk importer marks
                    // an already-imported video 'skipped' and returns early. Claiming
                    // completion over that would report a skip as an import.
                    if (item.status !== 'skipped') item.status = 'completed';
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
    return existingMoviesByKey.has(buildDuplicateKey(title, year));
}

// Like findMovieByVideoId but with no exemption for the movie being edited.
// The bulk importer runs against the whole library, and its tab lives inside the
// movie form — so editingMovieId can still be set when a bulk run starts.
// Exempting it there would let the very movie you are editing be re-imported in
// full, which is the one thing this check exists to prevent.
function findImportedMovieByVideoId(videoId) {
    if (!videoId) return null;
    return existingMoviesByVideoId.get(videoId) || null;
}

// The already-imported movie for a YouTube video id, or null. Never returns the
// movie currently being edited, matching findDuplicateMovie's contract.
function findMovieByVideoId(videoId) {
    if (!videoId) return null;
    const match = existingMoviesByVideoId.get(videoId);
    if (!match) return null;
    if (editingMovieId && match.id === editingMovieId) return null;
    return match;
}

// Returns the existing movie that collides with this title/year, or null.
// Never returns the movie currently being edited, so editing a movie does not
// flag it against itself.
function findDuplicateMovie(title, year) {
    if (!normalizeTitle(title)) return null;
    const match = existingMoviesByKey.get(buildDuplicateKey(title, year));
    if (!match) return null;
    if (editingMovieId && match.id === editingMovieId) return null;
    return match;
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
    // A movie OMDb could match well enough to give us a real poster is a
    // stronger result than one we only have a video frame for, so it earns
    // a spot in Top Picks.
    const categories = [...(metadata.genres || [])];
    if (item.posterUrl && !categories.includes('Top Picks')) {
        categories.push('Top Picks');
    }
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

function updateBatchUI() {
    if (!batchQueueEl) return;
    batchQueueEl.innerHTML = '';

    const totals = { queued: 0, processing: 0, completed: 0, failed: 0 };

    if (!batchQueue.length) {
        const empty = document.createElement('li');
        empty.className = 'batch-item-empty';
        empty.textContent = 'No files queued yet.';
        batchQueueEl.appendChild(empty);
    } else {
        batchQueue.forEach((item) => {
            const { label, category } = getStatusInfo(item.status);
            totals[category] = (totals[category] || 0) + 1;

            const li = document.createElement('li');
            li.className = 'batch-item';

            const thumb = document.createElement('div');
            thumb.className = 'batch-item-thumb';
            if (item.thumbnailURL) {
                const img = document.createElement('img');
                img.src = item.thumbnailURL;
                img.alt = item.metadata?.title || item.file.name;
                thumb.appendChild(img);
            } else {
                thumb.textContent = 'Preview';
            }

            const details = document.createElement('div');
            details.className = 'batch-item-details';
            const title = document.createElement('div');
            title.className = 'title';
            title.textContent = item.metadata?.title || item.file.name;
            const meta = document.createElement('div');
            meta.className = 'meta';
            const durationText = item.duration || 'Duration pending';
            const yearText = item.metadata?.year || 'Year TBD';
            meta.textContent = `Duration: ${durationText} · Year: ${yearText}`;
            details.append(title, meta);

            const statusWrap = document.createElement('div');
            statusWrap.className = 'batch-item-status';
            const badge = document.createElement('span');
            const badgeCategory = category === 'processing' ? 'processing' : category;
            badge.className = `status-badge ${badgeCategory}`;
            badge.textContent = label;
            statusWrap.appendChild(badge);

            if (item.error) {
                const errorEl = document.createElement('span');
                errorEl.className = 'batch-item-error';
                errorEl.textContent = item.error;
                statusWrap.appendChild(errorEl);
            }

            li.append(thumb, details, statusWrap);
            batchQueueEl.appendChild(li);
        });
    }

    if (batchSummaryEl) {
        const queued = batchSummaryEl.querySelector('[data-summary="queued"]');
        const processing = batchSummaryEl.querySelector('[data-summary="processing"]');
        const completed = batchSummaryEl.querySelector('[data-summary="completed"]');
        const failed = batchSummaryEl.querySelector('[data-summary="failed"]');
        if (queued) queued.textContent = `Queued: ${totals.queued || 0}`;
        if (processing) processing.textContent = `Processing: ${totals.processing || 0}`;
        if (completed) completed.textContent = `Completed: ${totals.completed || 0}`;
        if (failed) failed.textContent = `Failed: ${totals.failed || 0}`;
    }

    if (batchProgressBar) {
        const total = batchQueue.length;
        const completedCount = totals.completed || 0;
        const pct = total ? Math.round((completedCount / total) * 100) : 0;
        batchProgressBar.style.width = `${pct}%`;
    }

    if (startBatchBtn) {
        const hasQueued = batchQueue.some(item => item.status === 'queued');
        startBatchBtn.disabled = batchProcessing || !hasQueued;
    }

    if (batchClearBtn) {
        batchClearBtn.disabled = batchProcessing || !batchQueue.length;
    }
}

// Featured Thumbnail Elements



// Upload Status
const progressContainer = document.getElementById('progress-container');
const uploadProgressBar = document.getElementById('upload-progress-bar');
const saveBtn = document.getElementById('save-btn');
const aiGenerateBtn = document.getElementById('ai-generate-btn');


const subtitleInput = document.getElementById('subtitle-file');
const subtitleFileName = document.getElementById('subtitle-file-name');

let currentVideoFile = null;
let currentThumbnailBlob = null;
let currentFeaturedThumbnailFile = null;
let currentSubtitleFile = null;
let currentYoutubeThumbnailUrl = null;
let aiThumbnailGenerating = false;
let aiThumbnailTriggered = false;

// ── Auto AI Thumbnail setting ──────────────────────────────────────────────
const AUTO_AI_THUMB_KEY = 'autoAiThumbnail';

function loadAutoAiThumbnailSetting() {
    const toggle = document.getElementById('auto-ai-thumbnail-toggle');
    if (!toggle) return;
    toggle.checked = localStorage.getItem(AUTO_AI_THUMB_KEY) === 'true';
    toggle.addEventListener('change', () => {
        localStorage.setItem(AUTO_AI_THUMB_KEY, toggle.checked);
    });
}

function isAutoAiThumbnailEnabled() {
    return localStorage.getItem(AUTO_AI_THUMB_KEY) === 'true';
}

loadAutoAiThumbnailSetting();

// ── Auto-run pipeline setting ──────────────────────────────────────────────
const AUTO_RUN_KEY = 'autoRunPipeline';

function loadAutoRunSetting() {
    const toggle = document.getElementById('auto-run-toggle');
    if (!toggle) return;
    toggle.checked = localStorage.getItem(AUTO_RUN_KEY) === 'true';
    toggle.addEventListener('change', () => {
        localStorage.setItem(AUTO_RUN_KEY, toggle.checked);
    });
}

function isAutoRunEnabled() {
    return localStorage.getItem(AUTO_RUN_KEY) === 'true';
}

loadAutoRunSetting();

// True while the automated pipeline is driving the form. The individual steps
// check this so they surface errors to the pipeline instead of blocking the
// chain on an alert(), and so they don't each kick off the next step themselves.
let autoRunActive = false;
// Handle on the in-flight AI thumbnail so the pipeline can wait for it before saving.
let aiThumbnailPromise = null;

let editingMovieId = null;

let uploadedVideoUrl = null; // Track uploaded URL to avoid duplicates
// The YouTube link the current video was actually downloaded from. Captured at
// download time rather than read from #youtube-url at save time: the input keeps
// its text when the user switches to the Upload File tab, which would otherwise
// stamp an unrelated source onto a movie uploaded from disk.
let currentSourceURL = null;
let fetchedPosterUrl = null; // Store poster URL from OMDB


// --- Event Listeners ---

// Navigation / Modals
addMovieBtn.addEventListener('click', () => openForm());
closeFormBtn.addEventListener('click', () => closeForm());
cancelFormBtn.addEventListener('click', () => closeForm());

// File Drop Zone
// The player sits inside the zone, so clicks on its controls must not reopen the
// file picker. The input is inside too: its own click would otherwise bubble back.
dropZone.addEventListener('click', (e) => {
    if (e.target === videoPreview || e.target === videoInput) return;
    videoInput.click();
});
dropZone.addEventListener('keydown', (e) => {
    if (e.target !== dropZone || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    videoInput.click();
});
dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('is-dragover');
});
dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('is-dragover');
});
dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('is-dragover');
    if (e.dataTransfer.files.length) {
        handleVideoSelect(e.dataTransfer.files[0]);
    }
});
videoInput.addEventListener('change', (e) => {
    if (e.target.files.length) handleVideoSelect(e.target.files[0]);
});

subtitleInput.addEventListener('change', async (e) => {
    if (e.target.files.length) {
        const file = e.target.files[0];
        if (file.name.endsWith('.vtt') || file.name.endsWith('.srt')) {
            currentSubtitleFile = file;
            subtitleFileName.textContent = file.name;

            // Automatically analyze subtitle and populate fields
            subtitleFileName.textContent = `${file.name} - ⏳ Analyzing...`;

            try {
                const metadata = await analyzeSubtitleFile(file);

                // Auto-populate form fields
                document.getElementById('title').value = metadata.title;
                document.getElementById('year').value = metadata.year;
                document.getElementById('description').value = metadata.description;

                // Auto-select genres
                if (metadata.genres && Array.isArray(metadata.genres)) {
                    // Uncheck all first (optional, but good for retries)
                    document.querySelectorAll('input[name="category"]').forEach(cb => cb.checked = false);

                    metadata.genres.forEach(genre => {
                        // Capitalize first letter just in case AI returns lowercase
                        const formattedGenre = genre.charAt(0).toUpperCase() + genre.slice(1).toLowerCase();
                        // Special handling for Sci-Fi if needed, but usually AI gets it right if prompt is clear.
                        // Actually, our values are Title Case.
                        // Let's try to match by value.

                        // We need to handle case sensitivity properly or leniently.
                        // Let's iterate all checkboxes and check if value matches loosely.
                        const checkbox = document.querySelector(`input[name="category"][value="${genre}"]`) ||
                            document.querySelector(`input[name="category"][value="${formattedGenre}"]`);

                        if (checkbox) {
                            checkbox.checked = true;
                        } else {
                            // Try deeper search for "Sci-Fi" vs "Sci-fi" etc
                            const allCbs = document.querySelectorAll('input[name="category"]');
                            for (const cb of allCbs) {
                                if (cb.value.toLowerCase() === genre.toLowerCase()) {
                                    cb.checked = true;
                                    break;
                                }
                            }
                        }
                    });
                }

                subtitleFileName.textContent = `${file.name} - ✅ Analysis complete`;

                // Show success message briefly
                setTimeout(() => {
                    subtitleFileName.textContent = file.name;
                }, 3000);

            } catch (error) {
                console.error('Error analyzing subtitle:', error);
                subtitleFileName.textContent = `${file.name} - ⚠️ Analysis failed`;

                // Show error message
                alert('Failed to analyze subtitle file. You can still upload it and fill in the details manually.\n\nError: ' + error.message);

                // Reset to just filename after delay
                setTimeout(() => {
                    subtitleFileName.textContent = file.name;
                }, 3000);
            }
        } else {
            alert('Please select a .vtt or .srt file.');
            subtitleInput.value = '';
            currentSubtitleFile = null;
            subtitleFileName.textContent = 'No file selected';
        }
    }
});

changeVideoBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    videoInput.value = '';
    currentVideoFile = null;
    videoPreview.src = '';
    videoPreview.classList.add('hidden');
    dropZone.querySelector('.drop-content').classList.remove('hidden');
    changeVideoBtn.classList.add('hidden');
    captureBtn.disabled = true;
});




// Capture Thumbnail
captureBtn.addEventListener('click', captureThumbnail);
editThumbnailBtn?.addEventListener('click', editCurrentThumbnail);

// Form Submit
movieForm.addEventListener('submit', handleFormSubmit);



// Featured Thumbnail (Poster)
function setFeaturedFile(file) {
    currentFeaturedThumbnailFile = file;
    // A poster chosen here replaces one OMDb supplied during a sync.
    fetchedPosterUrl = null;
    featuredPreview.src = URL.createObjectURL(file);
    featuredPreview.classList.remove('hidden');
    featuredPlaceholder.classList.add('hidden');
    featuredDropContent.classList.add('hidden');
    removeFeaturedBtn.classList.remove('hidden');
    posterSyncStatus.classList.add('hidden');
}

featuredInput.addEventListener('change', (e) => {
    if (e.target.files.length) setFeaturedFile(e.target.files[0]);
});

const featuredZone = document.getElementById('featured-thumbnail-zone');

featuredZone?.addEventListener('click', (e) => {
    if (e.target === featuredInput || removeFeaturedBtn.contains(e.target)) return;
    featuredInput.click();
});
featuredZone?.addEventListener('dragover', (e) => {
    e.preventDefault();
    featuredZone.classList.add('is-dragover');
});
featuredZone?.addEventListener('dragleave', () => {
    featuredZone.classList.remove('is-dragover');
});
featuredZone?.addEventListener('drop', (e) => {
    e.preventDefault();
    featuredZone.classList.remove('is-dragover');
    const file = e.dataTransfer.files[0];
    if (file?.type.startsWith('image/')) setFeaturedFile(file);
});

// Pasting only ever claims an image, so ordinary text paste into the fields is untouched.
document.addEventListener('paste', (e) => {
    if (movieFormPanel.classList.contains('hidden')) return;
    if (document.getElementById('metadata-section')?.classList.contains('hidden')) return;
    const file = Array.from(e.clipboardData?.files || []).find((f) => f.type.startsWith('image/'));
    if (!file) return;
    e.preventDefault();
    setFeaturedFile(file);
});

removeFeaturedBtn.addEventListener('click', () => {
    featuredInput.value = '';
    currentFeaturedThumbnailFile = null;
    featuredPreview.src = '';
    featuredPreview.classList.add('hidden');
    featuredPlaceholder.classList.remove('hidden');
    featuredDropContent.classList.remove('hidden');
    removeFeaturedBtn.classList.add('hidden');
    posterSyncStatus.classList.add('hidden');

    // Also clear if it was from OMDB
    fetchedPosterUrl = null;
});


// AI Generate Description
aiGenerateBtn.addEventListener('click', generateDescription);

// Sync Data
document.getElementById('sync-data-btn').addEventListener('click', syncMovieData);

// --- Functions ---

async function generateDescription() {
    const title = document.getElementById('title').value.trim();
    const year = document.getElementById('year').value;

    if (!title) {
        alert('Please enter a movie title first.');
        return;
    }

    aiGenerateBtn.disabled = true;
    aiGenerateBtn.textContent = 'Generating...';

    try {
        const prompt = `Write a short, engaging 2-3 sentence description for a movie recap video about "${title}"${year ? ` (${year})` : ''}. Make it exciting and capture the essence of the story. Focus on the main plot and what makes it interesting. Keep it under 150 characters.`;

        const response = await fetch(AI_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                prompt: prompt,
                max_tokens: 100,
                temperature: 0.7
            })
        });

        if (!response.ok) {
            throw new Error(`OpenAI API error: ${response.status}`);
        }

        const data = await response.json();
        const description = data.choices[0].message.content.trim();

        document.getElementById('description').value = description;

    } catch (error) {
        console.error('Error generating description:', error);
        alert('Failed to generate description. Please try again or write one manually.');
    } finally {
        aiGenerateBtn.disabled = false;
        aiGenerateBtn.textContent = 'AI Generate';
    }
}

// Analyze subtitle file and extract movie metadata
async function analyzeSubtitleFile(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = async (e) => {
            try {
                const content = e.target.result;
                // Extract first 2000 characters to stay within token limits
                const sample = content.substring(0, 2000);

                const metadata = await extractMovieMetadata(sample);
                resolve(metadata);
            } catch (error) {
                reject(error);
            }
        };

        reader.onerror = () => reject(new Error('Failed to read subtitle file'));
        reader.readAsText(file);
    });
}

// Extract movie metadata using OpenAI API
async function extractMovieMetadata(subtitleContent) {
    // No API check needed here, server handles it

    const prompt = `Analyze this subtitle content and extract the following information:
1. Movie title (if not clearly stated, create a 1-3 word descriptive title based on the content)
2. Year of release (if not found, return "N/A")
3. A short, engaging 2-3 sentence description (under 150 characters)
4. Genres (Select relevant ones from this list ONLY: "Action", "Comedy", "Drama", "Sci-Fi", "Horror", "Thriller", "Romance", "Fantasy", "Documentary")

Subtitle content:
${subtitleContent}

Return ONLY a JSON object in this exact format:
{"title": "Movie Title", "year": "2024", "description": "Short description here", "genres": ["Action", "Thriller"]}

If year is not found, use "N/A" for the year value.`;

    try {
        const response = await fetch(AI_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                prompt: prompt,
                max_tokens: 200,
                temperature: 0.3
            })
        });

        if (!response.ok) {
            throw new Error(`OpenAI API error: ${response.status}`);
        }

        const data = await response.json();
        const content = data.choices[0].message.content.trim();

        // Parse JSON response
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            throw new Error('Invalid response format from API');
        }

        const metadata = JSON.parse(jsonMatch[0]);

        // Validate and set defaults
        return {
            title: metadata.title || 'Movie Recap',
            year: metadata.year || 'N/A',
            description: metadata.description || '',
            genres: Array.isArray(metadata.genres) ? metadata.genres : []
        };

    } catch (error) {
        console.error('Error extracting metadata:', error);
        throw error;
    }
}

async function fetchMovieFromOMDB(title, year) {
    if (!title) return null;

    try {
        const byTitle = await fetchOmdbByTitle(title, year);
        if (byTitle) return byTitle;

        const bySearch = await searchOmdbByTitle(title, year);
        if (!bySearch) return null;

        const byId = await fetchOmdbByImdbId(bySearch.imdbID);
        return byId || bySearch;
    } catch (error) {
        console.error("Error fetching from OMDB:", error);
        return null;
    }
}

async function fetchOmdbByTitle(title, year) {
    let url = `https://www.omdbapi.com/?t=${encodeURIComponent(title)}&apikey=${OMDB_API_KEY}`;
    if (year && year !== 'N/A') {
        url += `&y=${year}`;
    }

    const response = await fetch(url);
    const data = await response.json();

    if (data.Response === "True") {
        return data;
    }

    console.warn("OMDB title lookup failed:", data.Error);
    return null;
}

async function searchOmdbByTitle(title, year) {
    let url = `https://www.omdbapi.com/?s=${encodeURIComponent(title)}&apikey=${OMDB_API_KEY}`;
    if (year && year !== 'N/A') {
        url += `&y=${year}`;
    }

    const response = await fetch(url);
    const data = await response.json();

    if (data.Response !== "True" || !Array.isArray(data.Search) || data.Search.length === 0) {
        console.warn("OMDB search lookup failed:", data.Error || "No results");
        return null;
    }

    let match = data.Search[0];
    if (year && year !== 'N/A') {
        const exactMatch = data.Search.find(item => item.Year === year);
        if (exactMatch) {
            match = exactMatch;
        }
    }

    return match;
}

async function fetchOmdbByImdbId(imdbId) {
    if (!imdbId) return null;

    const url = `https://www.omdbapi.com/?i=${encodeURIComponent(imdbId)}&apikey=${OMDB_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.Response === "True") {
        return data;
    }

    console.warn("OMDB IMDb lookup failed:", data.Error);
    return null;
}



function openForm(movie = null) {
    movieForm.reset();
    resetMediaInputs();
    editingMovieId = null;
    clearDuplicateWarningState();
    document.getElementById('form-title').innerText = 'Add New Movie';
    saveBtn.textContent = 'Upload & Save';

    // Uncheck all categories
    document.querySelectorAll('input[name="category"]').forEach(cb => cb.checked = false);

    if (movie) {
        editingMovieId = movie.id;
        document.getElementById('form-title').innerText = 'Edit Movie';
        saveBtn.textContent = 'Save changes';
        document.getElementById('title').value = movie.title;
        document.getElementById('year').value = movie.year;
        document.getElementById('duration').value = movie.duration;
        document.getElementById('description').value = movie.description;

        // Check the categories
        let catsToCheck = [];
        if (movie.categories && Array.isArray(movie.categories)) {
            catsToCheck = movie.categories;
        } else if (movie.category && typeof movie.category === 'string') {
            catsToCheck = [movie.category];
        } else if (movie.category && Array.isArray(movie.category)) {
            catsToCheck = movie.category;
        }

        if (catsToCheck.length > 0) {
            catsToCheck.forEach(cat => {
                const checkbox = document.querySelector(`input[name="category"][value="${cat}"]`);
                if (checkbox) checkbox.checked = true;
            });
        }

        // Handling existing media for edit is complex without re-upload/preview
        // For this version, we'll keep it simple: assume user keeps media if not changed.
        // We show a note or just show current thumbnail if possible.
        const existingThumbnailSrc = movie.thumbnail || movie.featuredThumbnail || null;
        if (existingThumbnailSrc) {
            thumbnailImg.src = existingThumbnailSrc;
            thumbnailImg.dataset.editable = isSafeThumbnailSrc(existingThumbnailSrc) ? 'true' : 'false';
            thumbnailImg.classList.remove('hidden');
            thumbPlaceholder.classList.add('hidden');
            if (editThumbnailBtn) editThumbnailBtn.disabled = thumbnailImg.dataset.editable !== 'true';
        } else {
            delete thumbnailImg.dataset.editable;
            if (editThumbnailBtn) editThumbnailBtn.disabled = true;
        }

        if (movie.featuredThumbnail) {
            featuredPreview.src = movie.featuredThumbnail;
            featuredPreview.classList.remove('hidden');
            featuredPlaceholder.classList.add('hidden');
            removeFeaturedBtn.classList.remove('hidden');
            featuredDropContent.classList.add('hidden');
        }

        posterSyncStatus.classList.add('hidden');




        // We won't load the full video into preview to save bandwidth, 
        // but we state that "New uploads will replace existing media"
    }

    movieFormPanel.classList.remove('hidden');
    // The form scrolls on its own now, so it would otherwise reopen where it was left.
    movieForm.scrollTop = 0;
}

function closeForm() {
    if (isBulkProcessing()) {
        alert('Bulk import is still running. Please wait for it to finish.');
        return;
    }
    movieFormPanel.classList.add('hidden');
    clearDuplicateWarningState();
    videoPreview.pause();
}

// --- Duplicate Warning Banner ---
const duplicateWarning = document.getElementById('duplicate-warning');
const duplicateWarningThumb = document.getElementById('duplicate-warning-thumb');
const duplicateWarningText = document.getElementById('duplicate-warning-text');
const duplicateWarningOpen = document.getElementById('duplicate-warning-open');
const duplicateWarningDismiss = document.getElementById('duplicate-warning-dismiss');

// The movie the banner is currently pointing at, so "Open existing" knows its target.
let duplicateWarningMatch = null;
let duplicateCheckTimer = null;
// Set once a save succeeds. The Firebase listener reports the record we just wrote
// while the form is still open and editingMovieId is still null, so without this the
// banner flashes "already in your library" at the movie the user just saved.
let duplicateWarningSuppressed = false;

function hideDuplicateWarning() {
    duplicateWarningMatch = null;
    duplicateWarning?.classList.add('hidden');
}

function clearDuplicateWarningState() {
    clearTimeout(duplicateCheckTimer);
    warnedDuplicateKey = null;
    dismissedDuplicateKey = null;
    duplicateWarningSuppressed = false;
    hideDuplicateWarning();
}

// Idempotent. Safe to call at any time, including while the form is closed.
function refreshDuplicateWarning() {
    if (!duplicateWarning) return;
    if (duplicateWarningSuppressed) {
        hideDuplicateWarning();
        return;
    }

    const title = document.getElementById('title').value;
    const year = document.getElementById('year').value;
    const match = findDuplicateMovie(title, year);

    if (!match) {
        hideDuplicateWarning();
        return;
    }

    const key = buildDuplicateKey(title, year);
    if (key === dismissedDuplicateKey) {
        hideDuplicateWarning();
        return;
    }

    duplicateWarningMatch = match;
    warnedDuplicateKey = key;

    duplicateWarningText.textContent =
        `Already in your library: "${match.title}" (${match.year || 'no year'})`;

    if (isDisplayableImageSrc(match.thumbnail)) {
        duplicateWarningThumb.src = match.thumbnail;
        duplicateWarningThumb.classList.remove('hidden');
    } else {
        duplicateWarningThumb.removeAttribute('src');
        duplicateWarningThumb.classList.add('hidden');
    }

    duplicateWarning.classList.remove('hidden');
}

function scheduleDuplicateCheck() {
    clearTimeout(duplicateCheckTimer);
    duplicateCheckTimer = setTimeout(refreshDuplicateWarning, 200);
}

['title', 'year'].forEach((id) => {
    document.getElementById(id)?.addEventListener('input', scheduleDuplicateCheck);
});

duplicateWarningDismiss?.addEventListener('click', () => {
    dismissedDuplicateKey = buildDuplicateKey(
        document.getElementById('title').value,
        document.getElementById('year').value
    );
    hideDuplicateWarning();
});

// Shared by both duplicate banners' "Open existing". Swapping the form mid-save
// would let the in-flight submit finish against a mutated editingMovieId and a
// cleared currentSourceURL, writing the new movie through the edit path and
// without its source. Opening another movie also discards whatever video is in
// the form, which the user should get to refuse.
function confirmLeavingFormForMovie() {
    if (isSavingMovie) {
        alert('This movie is still saving. Wait for it to finish before opening another.');
        return false;
    }
    if (currentVideoFile || uploadedVideoUrl) {
        return confirm(
            'This discards the video you are working on and opens the existing movie instead. Continue?'
        );
    }
    return true;
}

duplicateWarningOpen?.addEventListener('click', () => {
    const match = duplicateWarningMatch;
    if (!match) return;
    if (!confirmLeavingFormForMovie()) return;
    openForm(match);
});

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
// The video id the banner was actually raised for. "Import anyway" must exempt
// this, never whatever happens to be in the URL field when it is clicked — the
// field can be edited after the banner appears.
let sourceDuplicateVideoId = null;
// One video id the user chose to import anyway. A single slot, not a set: the
// form handles one video at a time, so overriding a second replaces the first
// and the exemption can never accumulate.
let overriddenVideoId = null;

function hideSourceDuplicateWarning() {
    sourceDuplicateMatch = null;
    sourceDuplicateVideoId = null;
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
    sourceDuplicateVideoId = videoId;
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
    const match = sourceDuplicateMatch;
    if (!match) return;
    if (!confirmLeavingFormForMovie()) return;
    openForm(match);
});

sourceDuplicateOverride?.addEventListener('click', () => {
    // sourceDuplicateVideoId, not the URL field: the field may have been edited
    // since the banner appeared, and exempting an id the user was never warned
    // about would let a different duplicate through silently.
    if (sourceDuplicateVideoId) overriddenVideoId = sourceDuplicateVideoId;
    hideSourceDuplicateWarning();
});

// Editing the URL invalidates whatever the banner is showing. Without this the
// banner would keep describing the previous video, and "Open existing" would
// open an unrelated movie.
document.getElementById('youtube-url')?.addEventListener('input', () => {
    if (sourceDuplicateMatch) hideSourceDuplicateWarning();
});

function resetMediaInputs() {
    currentVideoFile = null;
    currentThumbnailBlob = null;
    currentYoutubeThumbnailUrl = null;
    currentSourceURL = null;
    overriddenVideoId = null;
    hideSourceDuplicateWarning();
    currentSubtitleFile = null;
    aiThumbnailGenerating = false;
    aiThumbnailTriggered = false;
    aiThumbnailPromise = null;
    const aiBtn = document.getElementById('generate-ai-thumbnail-btn');
    if (aiBtn) aiBtn.disabled = true;
    videoInput.value = '';
    subtitleInput.value = '';
    subtitleFileName.textContent = 'No file selected';

    videoPreview.src = '';
    videoPreview.classList.add('hidden');
    dropZone.querySelector('.drop-content').classList.remove('hidden');
    changeVideoBtn.classList.add('hidden');
    uploadedVideoUrl = null;
    window.tempGeneratedSubtitleUrl = null;
    fetchedPosterUrl = null;


    thumbnailImg.src = '';
    delete thumbnailImg.dataset.editable;
    thumbnailImg.classList.add('hidden');
    thumbPlaceholder.classList.remove('hidden');
    if (editThumbnailBtn) editThumbnailBtn.disabled = true;

    // Reset Featured (Poster)
    featuredInput.value = '';
    currentFeaturedThumbnailFile = null;
    featuredPreview.src = '';
    featuredPreview.classList.add('hidden');
    featuredPlaceholder.classList.remove('hidden');
    removeFeaturedBtn.classList.add('hidden');
    featuredDropContent.classList.remove('hidden');
    posterSyncStatus.classList.add('hidden');

    captureBtn.disabled = true;

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

    progressContainer.classList.add('hidden');
    uploadProgressBar.style.width = '0%';
    saveBtn.disabled = false;
}

function handleVideoSelect(file) {
    if (file.type !== 'video/mp4') {
        alert('Please select an MP4 file.');
        return;
    }
    currentVideoFile = file;

    if (editThumbnailBtn) editThumbnailBtn.disabled = true;
    delete thumbnailImg.dataset.editable;

    const url = URL.createObjectURL(file);
    videoPreview.src = url;
    videoPreview.classList.remove('hidden');

    dropZone.querySelector('.drop-content').classList.add('hidden');
    changeVideoBtn.classList.remove('hidden');

    // Enable capture when metadata loaded and auto-fill duration
    videoPreview.onloadedmetadata = () => {
        captureBtn.disabled = false;

        // Auto-populate duration field
        const durationSeconds = Math.floor(videoPreview.duration);
        const minutes = Math.floor(durationSeconds / 60);
        const seconds = durationSeconds % 60;
        const formattedDuration = `${minutes}m ${seconds}s`;
        document.getElementById('duration').value = formattedDuration;
    };

    // Reset uploaded URL if video changes
    uploadedVideoUrl = null;

    // Any newly selected video is from disk unless the YouTube download path
    // sets this again immediately after calling us.
    currentSourceURL = null;
}

// Crop Interface Elements
const cropInterface = document.getElementById('crop-interface');
const cropCanvas = document.getElementById('crop-canvas');
const cropBox = document.getElementById('crop-box');
const applyCropBtn = document.getElementById('apply-crop-btn');
const cancelCropBtn = document.getElementById('cancel-crop-btn');
const cropControls = document.getElementById('crop-controls');

let cropData = {
    x: 0,
    y: 0,
    width: 200,
    height: 200,
    isDragging: false,
    isResizing: false,
    resizeHandle: null,
    startX: 0,
    startY: 0,
    canvasScale: 1
};

function captureThumbnail() {
    if (!videoPreview.videoWidth) return;

    // Draw full video frame to canvas
    captureCanvas.width = videoPreview.videoWidth;
    captureCanvas.height = videoPreview.videoHeight;

    const ctx = captureCanvas.getContext('2d');
    ctx.drawImage(videoPreview, 0, 0, captureCanvas.width, captureCanvas.height);

    // Show crop interface
    showCropInterface();
}

function loadImageElement(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
    });
}

async function editCurrentThumbnail() {
    if (!thumbnailImg || thumbnailImg.classList.contains('hidden') || !thumbnailImg.src) {
        alert('No thumbnail available to edit yet. Capture one first.');
        return;
    }

    if (thumbnailImg.dataset.editable !== 'true') {
        alert('This saved thumbnail cannot be edited because it was generated outside this browser session. Please capture a new thumbnail from the video.');
        return;
    }

    let tempUrl = null;

    const drawToCanvas = (image) => {
        const width = image.naturalWidth || image.width;
        const height = image.naturalHeight || image.height;
        captureCanvas.width = width;
        captureCanvas.height = height;
        const ctx = captureCanvas.getContext('2d');
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(image, 0, 0, width, height);
    };

    try {
        let image;
        try {
            image = await loadImageElement(thumbnailImg.src);
        } catch (err) {
            const response = await fetch(thumbnailImg.src, { mode: 'cors' });
            const blob = await response.blob();
            tempUrl = URL.createObjectURL(blob);
            image = await loadImageElement(tempUrl);
        }

        if (editThumbnailBtn) editThumbnailBtn.disabled = true;
        drawToCanvas(image);
        showCropInterface();
    } catch (error) {
        console.error('Failed to load thumbnail for editing', error);
        alert('Unable to edit this thumbnail. Please capture a new one.');
        if (editThumbnailBtn) editThumbnailBtn.disabled = false;
    } finally {
        if (tempUrl) URL.revokeObjectURL(tempUrl);
    }
}

function showCropInterface() {
    // Set up crop canvas
    const containerRect = document.querySelector('.thumbnail-preview-container').getBoundingClientRect();
    cropCanvas.width = captureCanvas.width;
    cropCanvas.height = captureCanvas.height;

    const ctx = cropCanvas.getContext('2d');
    ctx.drawImage(captureCanvas, 0, 0);

    // Calculate scale
    cropData.canvasScale = cropCanvas.offsetWidth / cropCanvas.width;

    // Initialize crop box (center, 16:9 aspect ratio)
    const boxWidth = Math.min(300, containerRect.width * 0.7);
    const boxHeight = boxWidth * 9 / 16;
    cropData.width = boxWidth;
    cropData.height = boxHeight;
    cropData.x = (containerRect.width - boxWidth) / 2;
    cropData.y = (containerRect.height - boxHeight) / 2;

    updateCropBox();

    // Show interface
    cropInterface.classList.remove('hidden');
    cropControls.classList.remove('hidden');
    captureBtn.classList.add('hidden');
    if (editThumbnailBtn) editThumbnailBtn.disabled = true;
}

function updateCropBox() {
    cropBox.style.left = cropData.x + 'px';
    cropBox.style.top = cropData.y + 'px';
    cropBox.style.width = cropData.width + 'px';
    cropBox.style.height = cropData.height + 'px';
}

// Crop box drag and resize
cropBox.addEventListener('mousedown', (e) => {
    if (e.target.classList.contains('crop-handle')) {
        cropData.isResizing = true;
        cropData.resizeHandle = e.target.classList[1]; // nw, ne, sw, se
    } else {
        cropData.isDragging = true;
    }
    cropData.startX = e.clientX;
    cropData.startY = e.clientY;
    e.preventDefault();
});

document.addEventListener('mousemove', (e) => {
    if (!cropData.isDragging && !cropData.isResizing) return;

    const dx = e.clientX - cropData.startX;
    const dy = e.clientY - cropData.startY;

    if (cropData.isDragging) {
        cropData.x += dx;
        cropData.y += dy;

        // Constrain to container
        const container = cropInterface.getBoundingClientRect();
        cropData.x = Math.max(0, Math.min(cropData.x, container.width - cropData.width));
        cropData.y = Math.max(0, Math.min(cropData.y, container.height - cropData.height));
    } else if (cropData.isResizing) {
        const handle = cropData.resizeHandle;

        if (handle.includes('e')) {
            cropData.width += dx;
        }
        if (handle.includes('w')) {
            cropData.width -= dx;
            cropData.x += dx;
        }
        if (handle.includes('s')) {
            cropData.height += dy;
        }
        if (handle.includes('n')) {
            cropData.height -= dy;
            cropData.y += dy;
        }

        // Min size
        cropData.width = Math.max(50, cropData.width);
        cropData.height = Math.max(50, cropData.height);
    }

    cropData.startX = e.clientX;
    cropData.startY = e.clientY;
    updateCropBox();
});

document.addEventListener('mouseup', () => {
    cropData.isDragging = false;
    cropData.isResizing = false;
});

applyCropBtn.addEventListener('click', () => {
    // Calculate crop coordinates on original canvas
    const scaleX = captureCanvas.width / cropCanvas.offsetWidth;
    const scaleY = captureCanvas.height / cropCanvas.offsetHeight;

    const cropX = cropData.x * scaleX;
    const cropY = cropData.y * scaleY;
    const cropW = cropData.width * scaleX;
    const cropH = cropData.height * scaleY;

    // Create cropped canvas
    const croppedCanvas = document.createElement('canvas');
    croppedCanvas.width = cropW;
    croppedCanvas.height = cropH;
    const ctx = croppedCanvas.getContext('2d');
    ctx.drawImage(captureCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

    // Composite watermark directly from croppedCanvas (avoids blob URL + crossOrigin taint issue)
    croppedCanvas.toBlob(async (blob) => {
        const watermarked = await new Promise((resolve) => {
            const wCanvas = document.createElement('canvas');
            wCanvas.width = 1920;
            wCanvas.height = 1080;
            const wCtx = wCanvas.getContext('2d');
            wCtx.drawImage(croppedCanvas, 0, 0, 1920, 1080);

            const logoImg = new Image();
            const finish = () => wCanvas.toBlob(b => resolve(b || blob), 'image/jpeg', 0.92);
            logoImg.onload = () => {
                const logoSize = Math.round(1920 * 0.075);
                const margin = Math.round(1920 * 0.022);
                wCtx.globalAlpha = 0.88;
                wCtx.drawImage(logoImg, 1920 - logoSize - margin, 1080 - logoSize - margin, logoSize, logoSize);
                wCtx.globalAlpha = 1;
                finish();
            };
            logoImg.onerror = finish;
            logoImg.src = 'assets/img/logo-icon.png';
        });

        currentThumbnailBlob = watermarked;
        thumbnailImg.src = URL.createObjectURL(watermarked);
        thumbnailImg.dataset.editable = 'true';
        thumbnailImg.classList.remove('hidden');
        thumbPlaceholder.classList.add('hidden');

        // Hide crop interface
        cropInterface.classList.add('hidden');
        cropControls.classList.add('hidden');
        captureBtn.classList.remove('hidden');
        if (editThumbnailBtn) editThumbnailBtn.disabled = false;
    }, 'image/jpeg', 0.85);
});

cancelCropBtn.addEventListener('click', () => {
    cropInterface.classList.add('hidden');
    cropControls.classList.add('hidden');
    captureBtn.classList.remove('hidden');
    if (editThumbnailBtn) {
        editThumbnailBtn.disabled = thumbnailImg.classList.contains('hidden') || thumbnailImg.dataset.editable !== 'true';
    }
});


async function uploadVideoIfNeeded(movieId) {
    if (uploadedVideoUrl) return uploadedVideoUrl;
    if (!currentVideoFile) return null;

    uploadProgressBar.classList.remove('bg-success');
    document.querySelector('.progress-label').textContent = `Uploading ${currentVideoFile.name} (0%)...`;
    progressContainer.classList.remove('hidden');

    const vidRef = storageRef(storage, `videos/${movieId}/${currentVideoFile.name}`);
    const vidUploadAndProgress = uploadBytesResumable(vidRef, currentVideoFile);

    vidUploadAndProgress.on('state_changed', (snapshot) => {
        const progress = Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100);
        document.querySelector('.progress-label').textContent = `Uploading Video: ${progress}%`;
        uploadProgressBar.style.width = `${progress * 0.5}%`; // First 50% for upload
    });

    await vidUploadAndProgress;
    uploadedVideoUrl = await getDownloadURL(vidRef);
    return uploadedVideoUrl;
}

async function syncMovieData() {
    if (!currentVideoFile && !uploadedVideoUrl) {
        if (autoRunActive) throw new Error("No video available to sync.");
        alert("Please select a video file first.");
        return;
    }

    if (!ASSEMBLY_AI_KEY) {
        if (autoRunActive) throw new Error("AssemblyAI key is missing.");
        alert("Assembly API Key is missing.");
        return;
    }

    const btn = document.getElementById('sync-data-btn');
    btn.disabled = true;
    btn.textContent = "Syncing...";
    progressContainer.classList.remove('hidden');

    try {
        const movieId = editingMovieId || crypto.randomUUID();

        // 1. Upload
        const videoUrl = await uploadVideoIfNeeded(movieId);
        if (!videoUrl) throw new Error("Video upload failed");

        // 2. Transcribe
        document.querySelector('.progress-label').textContent = "Requesting Transcription...";
        uploadProgressBar.style.width = '60%';

        const transcriptId = await transcribeAudio(videoUrl);

        const transcript = await pollTranscription(transcriptId, (status) => {
            document.querySelector('.progress-label').textContent = `Transcribing: ${status}...`;
        });

        uploadProgressBar.style.width = '80%';
        document.querySelector('.progress-label').textContent = "Processing Metadata...";

        // 3. Save Generated SRT (temporary until save? No, let's save it now)
        const srtContent = await getTranscriptSRT(transcriptId);

        const srtBlob = new Blob([srtContent], { type: 'text/vtt' });
        const srtRef = storageRef(storage, `subtitles/${movieId}/generated.srt`);
        await uploadBytesResumable(srtRef, srtBlob);
        const subtitleUrl = await getDownloadURL(srtRef);

        // Store strict ref to this subtitle? Or just auto-load it
        // Let's create a "virtual" file for the form
        subtitleFileName.textContent = "generated.srt (Auto-synced)";
        // We can't set file input value, but we can set a flag or just assume it's there
        // Ideally we save this URL to a hidden field or global
        window.tempGeneratedSubtitleUrl = subtitleUrl;

        // 4. Extract logic
        const metadata = await extractMovieMetadata(transcript.text.substring(0, 5000));

        document.getElementById('title').value = metadata.title;
        document.getElementById('year').value = metadata.year;
        document.getElementById('description').value = metadata.description;

        // --- OMDB Integration ---
        if (OMDB_API_KEY) {
            document.querySelector('.progress-label').textContent = "Fetching details from OMDB...";
            const omdbData = await fetchMovieFromOMDB(metadata.title, metadata.year);

            if (omdbData) {
                // Populate with official data
                document.getElementById('title').value = omdbData.Title;
                document.getElementById('year').value = omdbData.Year;
                document.getElementById('description').value = omdbData.Plot;

                // Handle Poster
                if (omdbData.Poster && omdbData.Poster !== 'N/A') {
                    fetchedPosterUrl = omdbData.Poster;
                    currentFeaturedThumbnailFile = null;
                    featuredPreview.src = fetchedPosterUrl;
                    featuredPreview.classList.remove('hidden');
                    featuredPlaceholder.classList.add('hidden');
                    removeFeaturedBtn.classList.remove('hidden');
                    featuredDropContent.classList.add('hidden');
                    posterSyncStatus.textContent = "Poster updated from OMDb during sync";
                    posterSyncStatus.classList.remove('hidden');
                } else {
                    posterSyncStatus.classList.add('hidden');
                }

                // Map Genres
                if (omdbData.Genre) {
                    const omdbGenres = omdbData.Genre.split(',').map(g => g.trim());
                    omdbGenres.forEach(g => {
                        Array.from(document.querySelectorAll('input[name="category"]')).forEach(cb => {
                            if (cb.value.toLowerCase() === g.toLowerCase()) cb.checked = true;
                        });
                    });
                }
            } else {
                posterSyncStatus.classList.add('hidden');
            }
        }


        // Categories
        document.querySelectorAll('input[name="category"]').forEach(cb => cb.checked = false);
        if (metadata.genres) {
            metadata.genres.forEach(g => {
                // Approximate match
                Array.from(document.querySelectorAll('input[name="category"]')).forEach(cb => {
                    if (cb.value.toLowerCase() === g.toLowerCase()) cb.checked = true;
                });
            });
        }

        uploadProgressBar.style.width = '100%';
        document.querySelector('.progress-label').textContent = "Sync Complete!";

        // Title and year are only known now — this is the earliest the banner can fire
        // on the sync path, and it lands before AI thumbnail generation.
        refreshDuplicateWarning();

        // Auto AI Thumbnail generation (skip if already triggered during download)
        if (isAutoAiThumbnailEnabled() && currentYoutubeThumbnailUrl && !aiThumbnailTriggered) {
            document.querySelector('.progress-label').textContent = "Generating AI Thumbnail...";
            await generateAIThumbnail();
        }

        setTimeout(() => {
            progressContainer.classList.add('hidden');
            if (!autoRunActive) alert("Sync completed successfully! Please review the details.");
        }, 500);

    } catch (error) {
        console.error("Sync error:", error);
        document.querySelector('.progress-label').textContent = "Sync Failed!";
        if (autoRunActive) throw error;
        alert("Sync failed: " + error.message);
    } finally {
        btn.disabled = false;
        btn.textContent = "Sync Movie Data";
    }
}

async function handleFormSubmit(e) {
    e.preventDefault();

    let title = document.getElementById('title').value;
    let year = document.getElementById('year').value;

    // Duplicate detection. The inline banner normally warns much earlier; this only
    // catches a collision the banner never surfaced — e.g. a title set through a path
    // that does not fire an input event.
    const dupKey = buildDuplicateKey(title, year);
    if (!editingMovieId && existingMoviesByKey.has(dupKey) && dupKey !== warnedDuplicateKey) {
        const proceed = confirm("A movie with the same title and year already exists. Save anyway?");
        if (!proceed) return;
    }
    const duration = document.getElementById('duration').value;
    let description = document.getElementById('description').value;

    const selectedCategories = Array.from(document.querySelectorAll('input[name="category"]:checked'))
        .map(cb => cb.value);

    if (!editingMovieId && (!currentVideoFile && !uploadedVideoUrl)) {
        alert('Please upload a video.');
        return;
    }

    saveBtn.disabled = true;
    isSavingMovie = true;
    progressContainer.classList.remove('hidden');

    try {
        const movieId = editingMovieId || crypto.randomUUID();
        let videoUrl = uploadedVideoUrl;
        let thumbnailUrl = null;


        // Ensure video is uploaded if not already

        if (!videoUrl && currentVideoFile) {
            videoUrl = await uploadVideoIfNeeded(movieId);
        }

        // Upload Thumbnail (Main Video Thumbnail)
        if (currentThumbnailBlob) {
            document.querySelector('.progress-label').textContent = "Uploading Thumbnail...";
            const thumbRef = storageRef(storage, `thumbnails/${movieId}/thumbnail.jpg`);
            await uploadBytesResumable(thumbRef, currentThumbnailBlob);
            thumbnailUrl = await getDownloadURL(thumbRef);
        }

        // Handle Featured Thumbnail (Poster)
        let featuredThumbnailUrl = null;
        if (currentFeaturedThumbnailFile) {
            const featuredRef = storageRef(storage, `thumbnails/${movieId}/featured.jpg`);
            await uploadBytesResumable(featuredRef, currentFeaturedThumbnailFile);
            featuredThumbnailUrl = await getDownloadURL(featuredRef);
        } else if (fetchedPosterUrl) {
            featuredThumbnailUrl = fetchedPosterUrl;
        } else if (editingMovieId) {
            // Keep existing if editing and not replaced
            // We need to fetch it first effectively, but since we don't have it in memory easily without re-fetch
            // We can check if we want to keep it. 
            // Actually, for simplicity, if we are editing, we should probably fetch the existing movie data first or pass it.
            // But since we didn't wipe it from DB, we can just NOT update it if it's null, 
            // OR we have to trust that the user didn't clear it.
            // If the user clicked "remove", currentFeaturedThumbnailFile is null and fetchedPosterUrl is null.
            // But we don't know if it WAS there.
            // Let's rely on the fact that if we don't provide a new one, we might want to keep the old one?
            // No, standard update logic: if undefined, don't update. If explicitly cleared... well, we can't easily detect explicit clear without a flag.
            // For now, let's just save if we have a new one.
        }





        let subtitleUrl = window.tempGeneratedSubtitleUrl || null;
        if (currentSubtitleFile) {
            const subRef = storageRef(storage, `subtitles/${movieId}/${currentSubtitleFile.name}`);
            await uploadBytesResumable(subRef, currentSubtitleFile);
            subtitleUrl = await getDownloadURL(subRef);
        }

        const movieData = {
            id: movieId,
            title: title || "New Movie",
            year: year || new Date().getFullYear(),
            duration,
            // Only a brand-new movie gets stamped "New". When editing, clearing every
            // chip means the user removed the status deliberately — re-applying it here
            // is what dropped edited movies back into the New list.
            categories: selectedCategories.length
                ? selectedCategories
                : (editingMovieId ? [] : ['New']),
            description: description || "No description"
        };

        if (!editingMovieId) {
            movieData.updatedAt = Date.now();
        }

        if (videoUrl) movieData.videoURL = videoUrl;
        if (thumbnailUrl) movieData.thumbnail = thumbnailUrl;
        if (featuredThumbnailUrl) movieData.featuredThumbnail = featuredThumbnailUrl;

        // Where this recap came from. videoURL points at our Storage copy, which
        // says nothing about the source. Absent when the video came from disk.
        // On an edit this is null (resetMediaInputs clears it) and update() only
        // writes the keys it is given, so an existing sourceURL survives.
        if (currentSourceURL) movieData.sourceURL = currentSourceURL;

        // Handle featured thumbnail update logic
        // REMOVED: Consolidated to main thumbnail.
        // We do typically NOT set featuredThumbnail anymore, 
        // effectively deprecating it locally, while DB structure remains.


        if (subtitleUrl) movieData.subtitleURL = subtitleUrl;


        document.querySelector('.progress-label').textContent = "Saving...";
        if (editingMovieId) {
            await update(ref(db, 'movies/' + movieId), movieData);
        } else {
            await set(ref(db, 'movies/' + movieId), movieData);
        }

        uploadProgressBar.style.width = '100%';
        // The Firebase listener fires after this with the record we just wrote, so
        // suppress the banner until the form is reopened.
        clearDuplicateWarningState();
        duplicateWarningSuppressed = true;
        setTimeout(() => {
            closeForm();
            alert("Movie saved successfully!");
        }, 500);

    } catch (error) {
        console.error("Error saving movie:", error);
        alert("Error saving movie: " + error.message);
    } finally {
        saveBtn.disabled = false;
        isSavingMovie = false;
    }
}

// --- Realtime Listeners & Pagination Logic ---

// State
let allMovies = [];
let currentFilter = {
    search: '',
    category: 'all',
    sort: 'newest'
};
let pagination = {
    currentPage: 1,
    itemsPerPage: 10
};

// Elements
const categoryFilter = document.getElementById('category-filter');
const sortFilter = document.getElementById('sort-filter');
const paginationControls = document.getElementById('pagination-controls');
const prevPageBtn = document.getElementById('prev-page');
const nextPageBtn = document.getElementById('next-page');
const pageInfo = document.getElementById('page-info');

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

    // Prefer the video's original frame on YouTube over movie.thumbnail, which by
    // this point is usually the AI-generated or watermarked artwork. The panel is
    // a "where did I leave off" marker, so the frame that matches what you see on
    // YouTube identifies the recap faster than the stylised version does.
    //
    // isDisplayableImageSrc, not isSafeThumbnailSrc: the latter is a canvas-taint
    // test that only passes same-origin URLs, and every stored thumbnail is
    // cross-origin. See the comment above both functions.
    const storedThumb = isDisplayableImageSrc(movie.thumbnail)
        ? movie.thumbnail
        : 'assets/img/app-icon.png';
    const originalThumb = youtubeThumbnailURL(movie.sourceURL);

    // A deleted or private video still has a sourceURL but no image, so fall back
    // once rather than leaving a broken frame. Cleared first so a failure on one
    // movie cannot fire against the next one rendered.
    lastAddedThumb.onerror = null;
    if (originalThumb) {
        lastAddedThumb.onerror = () => {
            lastAddedThumb.onerror = null;
            lastAddedThumb.src = storedThumb;
        };
    }
    lastAddedThumb.src = originalThumb || storedThumb;
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
        // Guarded like the thumbnail src: this value comes from the database and
        // an http(s) allow-list keeps javascript: out of a target="_blank" anchor.
        lastAddedSource.href = /^https?:\/\//i.test(movie.sourceURL)
            ? movie.sourceURL
            : '#';
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

// onValue only fires on data change, so without this the panel would still read
// "added just now" hours later. Re-rendering is a handful of textContent writes.
setInterval(() => {
    if (lastAddedMovie) renderLastAdded();
}, 60000);

// Listeners
searchInput.addEventListener('input', (e) => {
    currentFilter.search = e.target.value.toLowerCase();
    pagination.currentPage = 1; // Reset to page 1 on search
    applyFiltersAndRender();
});

categoryFilter.addEventListener('change', (e) => {
    currentFilter.category = e.target.value;
    pagination.currentPage = 1;
    applyFiltersAndRender();
});

sortFilter.addEventListener('change', (e) => {
    currentFilter.sort = e.target.value;
    applyFiltersAndRender();
});

prevPageBtn.addEventListener('click', () => {
    if (pagination.currentPage > 1) {
        pagination.currentPage--;
        applyFiltersAndRender();
    }
});

nextPageBtn.addEventListener('click', () => {
    pagination.currentPage++;
    applyFiltersAndRender();
});


const moviesRef = ref(db, 'movies');
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
    existingMoviesByVideoId = new Map(
        allMovies
            .map((movie) => [videoIdFromSourceURL(movie.sourceURL), movie])
            .filter(([videoId]) => videoId)
    );
    moviesById = new Map(allMovies.map((movie) => [movie.id, movie]));
    applyFiltersAndRender();
    if (!movieFormPanel.classList.contains('hidden')) refreshDuplicateWarning();
    renderLastAdded();

    // Last, and isolated: nothing in the comments view may stop the movies
    // grid from rendering. Re-flattening here corrects comment titles when the
    // movies arrive after the comments did.
    try {
        rebuildComments();
        analyticsView.rerender();
    } catch (error) {
        console.error('Refreshing comment titles failed:', error);
    }
}, (error) => {
    // Without this the failure is silent: allMovies stays empty, so the duplicate
    // indexes stay empty, and every duplicate check quietly passes.
    console.error('[movies] realtime read failed', error);
    showToast('Could not load your movies — duplicate checks are disabled until this reconnects.');
});

function applyFiltersAndRender() {
    let filtered = [...allMovies];

    // 1. Filter by Search
    if (currentFilter.search) {
        filtered = filtered.filter(m => m.title.toLowerCase().includes(currentFilter.search));
    }

    // 2. Filter by Category
    if (currentFilter.category !== 'all') {
        filtered = filtered.filter(m => m.categories && m.categories.includes(currentFilter.category));
    }

    // 3. Sort
    filtered.sort((a, b) => {
        if (currentFilter.sort === 'newest') return (b.updatedAt || 0) - (a.updatedAt || 0);
        if (currentFilter.sort === 'oldest') return (a.updatedAt || 0) - (b.updatedAt || 0);
        if (currentFilter.sort === 'az') return a.title.localeCompare(b.title);
        if (currentFilter.sort === 'za') return b.title.localeCompare(a.title);
        return 0;
    });

    // 4. Pagination
    const totalItems = filtered.length;
    const totalPages = Math.ceil(totalItems / pagination.itemsPerPage) || 1;

    // Ensure current page is valid
    if (pagination.currentPage > totalPages) pagination.currentPage = totalPages;
    if (pagination.currentPage < 1) pagination.currentPage = 1;

    const startIndex = (pagination.currentPage - 1) * pagination.itemsPerPage;
    const paginatedItems = filtered.slice(startIndex, startIndex + pagination.itemsPerPage);

    // Render
    renderMovies(paginatedItems, totalItems === 0);
    updatePaginationUI(totalPages);
}

function renderMovies(movies, isEmpty) {
    moviesContainer.innerHTML = '';

    if (isEmpty) {
        moviesContainer.innerHTML = '<p class="loading-state">No movies found matching your criteria.</p>';
        return;
    }

    movies.forEach(movie => {
        const card = createMovieCard(movie);
        moviesContainer.appendChild(card);
    });
}

function updatePaginationUI(totalPages) {
    pageInfo.textContent = `Page ${pagination.currentPage} of ${totalPages}`;
    prevPageBtn.disabled = pagination.currentPage === 1;
    nextPageBtn.disabled = pagination.currentPage === totalPages;

    if (totalPages > 1 || allMovies.length > 0) {
        paginationControls.classList.remove('hidden');
    } else {
        paginationControls.classList.add('hidden');
    }
}

function createMovieCard(movie) {
    const categoryList = Array.isArray(movie.categories)
        ? movie.categories
        : (movie.category ? [movie.category] : []);
    const categoriesDisplay = categoryList.length ? categoryList.join(', ') : 'Uncategorized';

    const div = document.createElement('div');
    div.className = 'movie-card';
    div.innerHTML = `
        <div class="card-top">
            <img src="${movie.thumbnail || 'assets/img/app-icon.png'}" class="card-thumbnail" loading="lazy">
            <span class="duration-badge">${movie.duration}</span>
        </div>
        <div class="card-body">
            <h3 class="card-title">${movie.title}</h3>
            <div class="card-meta">
                <span>${movie.year}</span>
                <span>•</span>
                <span>${categoriesDisplay}</span>
            </div>
            <p class="card-desc">${movie.description}</p>
            <div class="card-actions">
                <button class="btn btn-secondary btn-sm edit-btn">Edit</button>
                <button class="btn btn-danger btn-sm delete-btn">Delete</button>
            </div>
        </div>
    `;

    div.querySelector('.edit-btn').addEventListener('click', () => openForm(movie));
    div.querySelector('.delete-btn').addEventListener('click', () => confirmDelete(movie.id, movie.title));

    return div;
}

async function confirmDelete(id, title) {
    if (!confirm(`Delete "${title}"? This cannot be undone.`)) {
        return;
    }

    try {
        // Get movie data to find file paths
        const movieRef = ref(db, 'movies/' + id);
        const snapshot = await new Promise((resolve, reject) => {
            onValue(movieRef, resolve, reject, { onlyOnce: true });
        });

        const movieData = snapshot.val();

        if (movieData) {
            // Delete video file from Storage if it exists
            if (movieData.videoURL) {
                try {
                    // Extract path from URL or use ID-based path
                    const videoRef = storageRef(storage, `videos/${id}/`);
                    // Note: We need to delete the specific file, but we don't have the exact filename
                    // We'll use a pattern based on the stored URL
                    const videoPath = movieData.videoURL.split('/o/')[1]?.split('?')[0];
                    if (videoPath) {
                        const decodedPath = decodeURIComponent(videoPath);
                        await deleteObject(storageRef(storage, decodedPath));
                    }
                } catch (error) {
                    console.warn('Could not delete video file:', error);
                }
            }

            // Delete thumbnail file from Storage if it exists
            if (movieData.thumbnail) {
                try {
                    const thumbPath = movieData.thumbnail.split('/o/')[1]?.split('?')[0];
                    if (thumbPath) {
                        const decodedPath = decodeURIComponent(thumbPath);
                        await deleteObject(storageRef(storage, decodedPath));
                    }
                } catch (error) {
                    console.warn('Could not delete thumbnail file:', error);
                }
            }
        }

        // Delete database entry
        await remove(ref(db, 'movies/' + id));
    } catch (error) {
        console.error("Error deleting movie:", error);
        alert("Error deleting movie: " + error.message);
    }
}

// --- AssemblyAI Integration ---

async function transcribeAudio(audioUrl) {
    const response = await fetch('https://api.assemblyai.com/v2/transcript', {
        method: 'POST',
        headers: {
            'authorization': ASSEMBLY_AI_KEY,
            'content-type': 'application/json'
        },
        body: JSON.stringify({ audio_url: audioUrl })
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error);
    return data.id;
}

async function pollTranscription(id, statusCallback) {
    while (true) {
        const response = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, {
            headers: { 'authorization': ASSEMBLY_AI_KEY }
        });
        const data = await response.json();

        if (statusCallback) statusCallback(data.status);

        if (data.status === 'completed') return data;
        if (data.status === 'error') throw new Error(data.error);

        // Wait 3 seconds
        await new Promise(r => setTimeout(r, 3000));
    }
}

async function getTranscriptSRT(id) {
    const response = await fetch(`https://api.assemblyai.com/v2/transcript/${id}/srt`, {
        headers: { 'authorization': ASSEMBLY_AI_KEY }
    });
    return await response.text();
}




function filterMovies(query) {
    const cards = document.querySelectorAll('.movie-card');
    query = query.toLowerCase();

    cards.forEach(card => {
        const title = card.querySelector('.card-title').innerText.toLowerCase();
        if (title.includes(query)) {
            card.classList.remove('hidden');
        } else {
            card.classList.add('hidden');
        }
    });
}

// ── YouTube downloader ──────────────────────────────────────────────

async function setYouTubeThumbnail(url) {
    try {
        currentYoutubeThumbnailUrl = url;
        const res = await fetch(`/api/proxy-image?url=${encodeURIComponent(url)}`);
        if (!res.ok) return;
        const blob = await res.blob();
        currentThumbnailBlob = blob;
        thumbnailImg.src = URL.createObjectURL(blob);
        thumbnailImg.dataset.editable = 'true';
        thumbnailImg.classList.remove('hidden');
        thumbPlaceholder.classList.add('hidden');
        if (editThumbnailBtn) editThumbnailBtn.disabled = false;
        const aiBtn = document.getElementById('generate-ai-thumbnail-btn');
        if (aiBtn) aiBtn.disabled = false;
    } catch (_) {}
}

// Headless AI thumbnail generation: takes a source image URL, returns the
// watermarked blob. Touches no globals and no DOM, so bulk imports can run it
// for several videos at once without the queue items clobbering each other.
async function generateAIThumbnailBlob(sourceThumbnailUrl) {
    const res = await fetch('/api/generate-thumbnail', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ thumbnailUrl: sourceThumbnailUrl })
    });

    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const msg = typeof body.error === 'string' ? body.error
            : body.error ? JSON.stringify(body.error)
            : `Server error ${res.status}`;
        throw new Error(msg);
    }

    const { imageUrl } = await res.json();

    // Composite logo watermark onto generated image using Canvas
    return compositeWatermark(imageUrl);
}

async function generateAIThumbnail() {
    if (!currentYoutubeThumbnailUrl || aiThumbnailGenerating) return;

    aiThumbnailGenerating = true;
    aiThumbnailTriggered = true;
    const btn = document.getElementById('generate-ai-thumbnail-btn');
    const loadingOverlay = document.getElementById('ai-thumb-loading');

    btn.disabled = true;
    btn.textContent = 'Generating...';
    loadingOverlay.classList.remove('hidden');

    try {
        const composited = await generateAIThumbnailBlob(currentYoutubeThumbnailUrl);

        currentThumbnailBlob = composited;
        thumbnailImg.src = URL.createObjectURL(composited);
        thumbnailImg.dataset.editable = 'true';
        thumbnailImg.classList.remove('hidden');
        thumbPlaceholder.classList.add('hidden');
        if (editThumbnailBtn) editThumbnailBtn.disabled = false;
    } catch (err) {
        const msg = err?.message || String(err);
        console.error('[AI thumbnail]', msg);
        alert('AI thumbnail generation failed: ' + msg);
    } finally {
        aiThumbnailGenerating = false;
        btn.disabled = false;
        btn.textContent = 'AI thumbnail';
        loadingOverlay.classList.add('hidden');
    }
}

function compositeWatermark(generatedImageUrl) {
    return new Promise((resolve, reject) => {
        const canvas = document.createElement('canvas');
        canvas.width = 1920;
        canvas.height = 1080;
        const ctx = canvas.getContext('2d');

        const mainImg = new Image();
        mainImg.crossOrigin = 'anonymous';
        mainImg.onload = () => {
            ctx.drawImage(mainImg, 0, 0, 1920, 1080);

            const logoImg = new Image();
            logoImg.onload = () => {
                const logoSize = Math.round(1920 * 0.075); // ~144px
                const margin = Math.round(1920 * 0.022);   // ~42px
                ctx.globalAlpha = 0.88;
                ctx.drawImage(logoImg, 1920 - logoSize - margin, 1080 - logoSize - margin, logoSize, logoSize);
                ctx.globalAlpha = 1;
                canvas.toBlob((blob) => {
                    if (blob) resolve(blob);
                    else reject(new Error('Canvas export failed'));
                }, 'image/jpeg', 0.92);
            };
            logoImg.onerror = () => {
                // If logo fails to load, still resolve with the generated image as-is
                canvas.toBlob((blob) => {
                    if (blob) resolve(blob);
                    else reject(new Error('Canvas export failed'));
                }, 'image/jpeg', 0.92);
            };
            logoImg.src = 'assets/img/logo-icon.png';
        };
        mainImg.onerror = reject;
        mainImg.src = generatedImageUrl;
    });
}

function extractYouTubeVideoId(url) {
    const patterns = [
        /[?&]v=([a-zA-Z0-9_-]{11})/,
        /youtu\.be\/([a-zA-Z0-9_-]{11})/,
        /\/shorts\/([a-zA-Z0-9_-]{11})/,
        /\/embed\/([a-zA-Z0-9_-]{11})/
    ];
    for (const re of patterns) {
        const m = url.match(re);
        if (m) return m[1];
    }
    return null;
}

async function fetchYouTubeInfo(videoId) {
    const fetchBtn = document.getElementById('fetch-youtube-btn');
    fetchBtn.disabled = true;
    fetchBtn.textContent = 'Fetching...';

    try {
        const res = await fetch(`/api/youtube-info?videoId=${encodeURIComponent(videoId)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to fetch video info');

        // Auto-populate metadata fields
        if (data.title) document.getElementById('title').value = data.title;
        if (data.publishYear) document.getElementById('year').value = data.publishYear;
        if (data.description) {
            const existing = document.getElementById('description').value;
            if (!existing) document.getElementById('description').value = data.description.slice(0, 500);
        }

        // Show YouTube preview card
        const preview = document.getElementById('youtube-preview');
        const thumbEl = document.getElementById('youtube-thumb-preview');
        const titleEl = document.getElementById('youtube-title-preview');
        const durEl = document.getElementById('youtube-duration-preview');

        if (data.thumbnail) thumbEl.src = data.thumbnail;
        titleEl.textContent = data.title || '';
        if (data.duration) {
            const m = Math.floor(data.duration / 60);
            const s = data.duration % 60;
            durEl.textContent = `${m}m ${s}s`;
        }
        preview.classList.remove('hidden');

        // Pre-fetch the YouTube thumbnail via server proxy (avoids CORS)
        if (data.thumbnail) {
            await setYouTubeThumbnail(data.thumbnail);
        }
    } catch (err) {
        if (autoRunActive) throw err;
        alert('Could not fetch YouTube info: ' + err.message);
    } finally {
        fetchBtn.disabled = false;
        fetchBtn.textContent = 'Fetch Info';
    }
}

async function downloadYouTubeVideo(videoId, quality = '360p') {
    const dlBtn = document.getElementById('download-youtube-btn');
    const progressWrap = document.getElementById('youtube-download-progress');
    const progressBar = document.getElementById('youtube-progress-bar');
    const statusLabel = document.getElementById('youtube-status-label');

    dlBtn.disabled = true;
    progressWrap.classList.remove('hidden');
    statusLabel.textContent = 'Connecting...';
    progressBar.style.width = '0%';

    try {
        const res = await fetch(`/api/youtube-download?videoId=${encodeURIComponent(videoId)}&quality=${encodeURIComponent(quality)}`);
        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: res.statusText }));
            throw new Error(err.error || 'Download failed');
        }

        const contentLength = res.headers.get('Content-Length');
        const total = contentLength ? parseInt(contentLength, 10) : 0;
        const reader = res.body.getReader();
        const chunks = [];
        let received = 0;

        statusLabel.textContent = 'Downloading...';

        // Fire AI thumbnail generation in parallel with the download
        if (isAutoAiThumbnailEnabled() && currentYoutubeThumbnailUrl) {
            // Kept unawaited so it overlaps the download; the handle lets the
            // auto-run pipeline wait for it before saving.
            aiThumbnailPromise = generateAIThumbnail();
        }

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            received += value.length;
            if (total > 0) {
                progressBar.style.width = Math.min(100, Math.round((received / total) * 100)) + '%';
            } else {
                // Indeterminate — animate width based on received MB
                const fakeProgress = Math.min(90, Math.round((received / (1024 * 1024 * 100)) * 100));
                progressBar.style.width = fakeProgress + '%';
            }
            statusLabel.textContent = `Downloading… ${(received / (1024 * 1024)).toFixed(1)} MB`;
        }

        progressBar.style.width = '100%';
        statusLabel.textContent = 'Processing video...';

        const blob = new Blob(chunks, { type: 'video/mp4' });
        const title = document.getElementById('title').value || videoId;
        const file = new File([blob], `${title}.mp4`, { type: 'video/mp4' });

        handleVideoSelect(file);
        // Must follow handleVideoSelect, which clears this.
        currentSourceURL = youtubeWatchURL(videoId);
        statusLabel.textContent = 'Done! Starting sync...';

        // Reveal the video drop zone so the preview is visible
        document.getElementById('video-drop-zone').classList.remove('hidden');

        // Auto-set thumbnail from YouTube if not already loaded
        if (!currentThumbnailBlob) {
            const thumbUrl = `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
            await setYouTubeThumbnail(thumbUrl);
        }

        dlBtn.disabled = false;

        // Auto-run Sync Movie Data — skipped when the pipeline is driving, since
        // it sequences the sync itself and needs to await the result.
        await new Promise(r => setTimeout(r, 500));
        if (!autoRunActive) syncMovieData();
    } catch (err) {
        statusLabel.textContent = 'Error: ' + err.message;
        dlBtn.disabled = false;
        if (autoRunActive) throw err;
    }
}

// Source toggle — Upload File / YouTube URL / Bulk YouTube
const SOURCE_TABS = [
    { btnId: 'source-file-btn', panelId: 'video-drop-zone' },
    { btnId: 'source-youtube-btn', panelId: 'youtube-input-section' },
    { btnId: 'source-bulk-btn', panelId: 'bulk-youtube-section' }
];

function setSourceMode(activeBtnId) {
    if (isBulkProcessing()) return;
    SOURCE_TABS.forEach(({ btnId, panelId }) => {
        const isActive = btnId === activeBtnId;
        const btn = document.getElementById(btnId);
        btn?.classList.toggle('active', isActive);
        btn?.setAttribute('aria-pressed', String(isActive));
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

document.getElementById('download-youtube-btn')?.addEventListener('click', () => {
    const url = document.getElementById('youtube-url').value.trim();
    const videoId = extractYouTubeVideoId(url);
    if (!videoId) return;
    if (blockedAsDuplicate(videoId)) return;
    const quality = document.getElementById('youtube-quality')?.value || '360p';
    downloadYouTubeVideo(videoId, quality);
});

document.getElementById('generate-ai-thumbnail-btn')?.addEventListener('click', generateAIThumbnail);

// ── Automated add-movie pipeline ────────────────────────────────────────────
// With the Auto-run toggle on, entering a YouTube URL drives the whole flow:
// fetch info → download video → AI thumbnail → sync metadata → save.
async function runAutoPipeline(videoId, quality) {
    if (autoRunActive) return;
    autoRunActive = true;

    const statusLabel = document.getElementById('youtube-status-label');
    const progressWrap = document.getElementById('youtube-download-progress');
    progressWrap?.classList.remove('hidden');
    const setStage = (text) => { if (statusLabel) statusLabel.textContent = text; };

    try {
        setStage('Auto-run: fetching video info…');
        await fetchYouTubeInfo(videoId);

        setStage('Auto-run: downloading video…');
        await downloadYouTubeVideo(videoId, quality);

        setStage('Auto-run: syncing movie data…');
        await syncMovieData();

        // The AI thumbnail was started alongside the download. Wait for it, or the
        // save would store the plain YouTube frame it hasn't replaced yet.
        if (aiThumbnailPromise) {
            setStage('Auto-run: finishing AI thumbnail…');
            await aiThumbnailPromise;
        }

        setStage('Auto-run: saving…');
        // requestSubmit() (not submit()) so the form's own submit handler and
        // validation still run, exactly as if the Save button were clicked.
        movieForm.requestSubmit();
    } catch (err) {
        const msg = err?.message || String(err);
        console.error('[auto-run]', err);
        setStage('Auto-run stopped: ' + msg);
        alert(`Auto-run stopped: ${msg}\n\nEverything completed so far is still in the form — you can finish it manually.`);
    } finally {
        autoRunActive = false;
    }
}

let autoRunDebounce = null;
document.getElementById('youtube-url')?.addEventListener('input', () => {
    // Only for new movies — auto-saving over one being edited would clobber it.
    if (!isAutoRunEnabled() || autoRunActive || editingMovieId) return;

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
});

initBulkYoutube({
    extractYouTubeVideoId,
    findMovieByVideoId: findImportedMovieByVideoId,
    uploadItemVideo,
    uploadThumbnailBlob,
    enrichAndSave,
    formatDuration,
    showToast,
    showBatchCompleteModal,
    runQueue,
    generateAIThumbnailBlob,
    isAutoAiThumbnailEnabled
});

// --- View routing ---
//
// .main-content's data-view attribute decides which view shows (see "View
// switching" in style.css). The Movies view's own parts keep managing their own
// hidden state — the last-added panel re-shows itself on every movie write and
// on a one-minute timer — and the attribute overrides them without touching
// that logic. #nav-settings stays deliberately unwired.

const mainContent = document.querySelector('.main-content');
const pageTitle = document.querySelector('.page-title');

const VIEWS = {
    movies: { nav: document.getElementById('nav-dashboard'), section: null, title: 'Dashboard' },
    comments: { nav: document.getElementById('nav-comments'), section: document.getElementById('comments-view'), title: 'Comments' },
    analytics: { nav: document.getElementById('nav-analytics'), section: document.getElementById('analytics-view'), title: 'Analytics' }
};

function showView(name) {
    if (!VIEWS[name]) return;
    if (mainContent) mainContent.dataset.view = name;
    for (const [viewName, view] of Object.entries(VIEWS)) {
        view.nav?.classList.toggle('active', viewName === name);
        view.section?.classList.toggle('hidden', viewName !== name);
    }
    if (pageTitle) pageTitle.textContent = VIEWS[name].title;
    if (name === 'analytics') analyticsView.show();
}

for (const [name, view] of Object.entries(VIEWS)) {
    view.nav?.addEventListener('click', () => showView(name));
}

// --- Comments ---

const commentsContainer = document.getElementById('comments-container');
const commentsSummary = document.getElementById('comments-summary');
const commentSearch = document.getElementById('comment-search');
const commentLangFilter = document.getElementById('comment-lang-filter');

// The raw tree is kept, not just the rows built from it. Rows carry movie
// titles, and the comments and movies listeners arrive in no fixed order:
// comments are a fraction of the size and usually land first, while
// moviesById is still empty. Rows built then would read "Unknown movie" until
// the next comment write, so they are rebuilt whenever either side changes.
let commentsTree = null;
let commentRows = [];
let commentsLoaded = false;

// pushId -> { text, lang, at }, mirrored from commentTranslations/.
let translations = {};
let translationsLoaded = false;

function rebuildComments() {
    commentRows = flattenComments(commentsTree, moviesById);
    renderComments();
}

onValue(ref(db, 'comments'), (snapshot) => {
    commentsTree = snapshot.val();
    commentsLoaded = true;
    rebuildComments();
    translatePending();
    analyticsView.rerender();
}, (error) => {
    // Without this a failed read is silent and the spinner turns forever.
    console.error('[comments] realtime read failed', error);
    showCommentsMessage(`Could not load comments: ${error.message}`);
});

onValue(ref(db, 'commentTranslations'), (snapshot) => {
    translations = snapshot.val() || {};
    translationsLoaded = true;
    renderComments();
    translatePending();
}, (error) => {
    // Without the cache there is no knowing what is already translated, and
    // translating blind would re-pay for every comment on every load. So
    // translation stays off and comments show in their original language.
    console.error('[commentTranslations] realtime read failed', error);
    showToast('Translations unavailable — comments are shown untranslated.');
});

// A translation worth showing: one exists, and it came from a language other
// than the admin's own. English comments are cached too — the model is what
// decides they are English — but restating them would only be noise.
function foreignTranslation(item) {
    const cached = translations[item.id];
    if (!cached || !cached.text || cached.lang === TARGET_LANG) return null;
    return cached;
}

function visibleRows() {
    const term = (commentSearch?.value || '').trim().toLowerCase();
    const mode = commentLangFilter?.value || 'all';

    return commentRows.filter((row) => {
        if (term) {
            // Translations are searched too, so the admin can find a Burmese
            // comment about downloads by typing "download".
            const items = [row, ...row.replies];
            const matches = items.some((item) => [
                item.text,
                item.userName,
                translations[item.id]?.text || ''
            ].join(' ').toLowerCase().includes(term));
            if (!matches && !row.movieTitle.toLowerCase().includes(term)) return false;
        }

        if (mode === 'foreign') return Boolean(foreignTranslation(row));
        if (mode === 'pending') {
            return !row.isAdmin && needsTranslation(row.text) && !translations[row.id];
        }
        return true;
    });
}

function showCommentsMessage(message) {
    if (!commentsContainer) return;
    commentsContainer.textContent = '';
    const note = document.createElement('div');
    note.className = 'comments-empty';
    note.textContent = message;
    commentsContainer.appendChild(note);
}

function renderComments() {
    // Until comments arrive the loading spinner stays in place.
    if (!commentsContainer || !commentsLoaded) return;

    const rows = visibleRows();

    if (commentsSummary) {
        const replyCount = rows.reduce((total, row) => total + row.replies.length, 0);
        commentsSummary.textContent =
            `${rows.length} of ${commentRows.length} comments · ${replyCount} replies`;
    }

    if (rows.length === 0) {
        showCommentsMessage(commentRows.length === 0 ? 'No comments yet.' : 'No comments match this filter.');
        return;
    }

    commentsContainer.textContent = '';
    for (const row of rows) {
        commentsContainer.appendChild(buildCommentCard(row));
    }
}

function buildCommentCard(row) {
    const card = document.createElement('div');
    card.className = 'comment-card';
    card.appendChild(buildCommentBody(row, row));

    if (row.replies.length > 0) {
        const thread = document.createElement('div');
        thread.className = 'comment-replies';
        for (const reply of row.replies) {
            const replyEl = buildCommentBody(reply, row);
            replyEl.classList.add('comment-reply');
            thread.appendChild(replyEl);
        }
        card.appendChild(thread);
    }

    return card;
}

// Shared by comments and replies. `row` is always the top-level comment, so a
// reply knows its parent without searching for it; `item` is that comment or
// one of its replies. Only the comment itself names the movie.
//
// Every user-authored string goes in through textContent, never innerHTML:
// this text is written by anonymous users straight into the database.
function buildCommentBody(item, row) {
    const wrapper = document.createElement('div');

    const head = document.createElement('div');
    head.className = 'comment-head';

    if (item === row) {
        const movie = document.createElement('span');
        movie.className = 'comment-movie';
        movie.textContent = `🎬 ${row.movieTitle}`;
        movie.addEventListener('click', () => openMovieFromComment(row.movieId));
        head.appendChild(movie);
    }

    const user = document.createElement('span');
    user.className = 'comment-user';
    user.textContent = item.userName;
    head.appendChild(user);

    if (item.isAdmin) {
        const badge = document.createElement('span');
        badge.className = 'admin-badge';
        badge.textContent = 'ADMIN';
        head.appendChild(badge);
    }

    const time = document.createElement('span');
    time.className = 'comment-time';
    time.textContent = formatRelativeTime(item.timestamp, Date.now());
    head.appendChild(time);

    // The model's language once it has answered; until then the script, as a
    // hint. Nothing is shown for the admin's own language or plain Latin text.
    const lang = translations[item.id]?.lang || detectScript(item.text);
    if (lang && ![TARGET_LANG, 'latin', 'empty'].includes(lang)) {
        const tag = document.createElement('span');
        tag.className = 'comment-lang';
        tag.textContent = lang;
        head.appendChild(tag);
    }

    wrapper.appendChild(head);

    const text = document.createElement('p');
    text.className = 'comment-text';
    text.textContent = item.text;
    wrapper.appendChild(text);

    const translated = foreignTranslation(item);
    if (translated && translated.text !== item.text) {
        const line = document.createElement('p');
        line.className = 'comment-translation';
        // A comment longer than the endpoint accepts was translated from its
        // opening only; the ellipsis says the translation stops short.
        const clipped = item.text.length > MAX_TRANSLATE_CHARS ? ' …' : '';
        line.textContent = `🌐 ${translated.text}${clipped}`;
        wrapper.appendChild(line);
    }

    wrapper.appendChild(buildActions(item, row));
    return wrapper;
}

// The per-comment action row. Replies are flat under their comment in the
// data, so only a top-level comment can be replied to.
function buildActions(item, row) {
    const actions = document.createElement('div');
    actions.className = 'comment-actions';

    if (item === row) {
        actions.appendChild(actionButton('Reply', 'btn-secondary', () => openReplyDialog(row)));
    }
    // btn-danger, matching the Delete button on movie cards.
    actions.appendChild(actionButton('Delete', 'btn-danger', () => deleteComment(item, row)));
    return actions;
}

function actionButton(label, variant, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `btn btn-sm ${variant}`;
    button.textContent = label;
    button.addEventListener('click', onClick);
    return button;
}

// openForm is the same entry point the movie cards and the last-added panel
// use. Its panel is a fixed overlay outside .content-body, so it opens over
// the inbox and the admin never loses their place in the comments.
function openMovieFromComment(movieId) {
    const movie = moviesById.get(movieId);
    if (!movie) {
        showToast('That movie has been deleted.');
        return;
    }
    openForm(movie);
}

commentSearch?.addEventListener('input', renderComments);
commentLangFilter?.addEventListener('change', renderComments);

// --- Translation ---
//
// Strictly additive: every failure path leaves comments rendered with their
// original text. Nothing here may stop the inbox from displaying.

async function translateBatch(batch, targetLang = TARGET_LANG) {
    const response = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: batch, targetLang })
    });
    // A platform error page is HTML, not JSON; report the status instead.
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Translate failed (${response.status})`);
    return data.items || [];
}

// Cached under its own top-level node, never inside comments/. Push ids are
// unique database-wide, so one flat node serves comments and replies alike.
async function cacheTranslations(results) {
    // A comment deleted while its batch was in flight must not get its
    // translation written back: the delete removed it, and nothing would ever
    // clean it up again.
    const live = new Set(commentRows.flatMap((row) => [row.id, ...row.replies.map((reply) => reply.id)]));
    const writes = {};
    for (const result of results) {
        if (!live.has(result.id)) continue;
        writes[result.id] = { text: result.text, lang: result.lang, at: Date.now() };
    }
    if (Object.keys(writes).length > 0) {
        await update(ref(db, 'commentTranslations'), writes);
    }
}

// When and what to send — waiting for both listeners, one attempt per item,
// no overlapping passes, picking up work that arrives mid-run — is decided by
// the scheduler in comments.js, where each of those rules is tested.
const translationScheduler = createTranslationScheduler({
    isReady: () => commentsLoaded && translationsLoaded,
    collectPending: () => collectTranslatable(commentRows, translations),
    translateBatch,
    cache: cacheTranslations,
    onError: (error) => {
        console.error('Comment translation failed:', error);
        showToast(`Translation unavailable: ${error.message}`);
    }
});

// Called without awaiting from the listeners, so a failure is caught here
// rather than left as an unhandled rejection.
function translatePending() {
    translationScheduler.run().catch((error) => console.error('Translation scheduling failed:', error));
}

document.getElementById('comment-translate-all')?.addEventListener('click', () => {
    if (!commentsLoaded || !translationsLoaded) {
        showToast('Comments are still loading.');
        return;
    }
    if (translationScheduler.isRunning()) {
        showToast('Translation is already running.');
        return;
    }
    const pending = collectTranslatable(commentRows, translations);
    if (pending.length === 0) {
        showToast('Everything is already translated.');
        return;
    }
    // Lets the admin retry what the model dropped earlier in this session.
    translationScheduler.clearAttempts();
    showToast(`Translating ${pending.length} comments...`);
    translatePending();
});

// --- Replying ---
//
// Compose in English, translate into the commenter's language, preview, post.
// The preview is not a nicety: it is the only thing between a bad machine
// translation and a user reading it, so nothing is ever posted that the admin
// has not seen exactly.

const replyModal = document.getElementById('reply-modal');
const replyInput = document.getElementById('reply-input');
const replyPreview = document.getElementById('reply-preview');
const replyPreviewText = document.getElementById('reply-preview-text');
const replyPostBtn = document.getElementById('reply-post');
const replyTranslateBtn = document.getElementById('reply-translate');

let replyTarget = null;   // the comment row being replied to
let replyBody = '';       // exactly what will be written; set only by a preview

function openReplyDialog(row) {
    replyTarget = row;

    document.getElementById('reply-context-movie').textContent = `🎬 ${row.movieTitle}`;
    document.getElementById('reply-context-user').textContent =
        `${row.userName} · ${formatRelativeTime(row.timestamp, Date.now())}`;
    document.getElementById('reply-context-text').textContent = row.text;
    const translated = foreignTranslation(row);
    document.getElementById('reply-context-translation').textContent =
        translated ? `🌐 ${translated.text}` : '';

    replyInput.value = '';
    clearReplyPreview();
    replyModal.classList.remove('hidden');
    replyInput.focus();
}

function closeReplyDialog() {
    replyModal.classList.add('hidden');
    replyTarget = null;
    clearReplyPreview();
}

// Any edit invalidates the preview, so Post is only ever enabled for text the
// admin is looking at.
function clearReplyPreview() {
    replyBody = '';
    replyPreviewText.textContent = '';
    replyPreview.classList.add('hidden');
    replyPostBtn.disabled = true;
}

function showReplyPreview(body) {
    replyBody = body;
    replyPreviewText.textContent = body;
    replyPreview.classList.remove('hidden');
    replyPostBtn.disabled = false;
}

document.getElementById('reply-cancel')?.addEventListener('click', closeReplyDialog);
document.getElementById('reply-close')?.addEventListener('click', closeReplyDialog);
replyInput?.addEventListener('input', clearReplyPreview);

replyTranslateBtn?.addEventListener('click', async () => {
    const target = replyTarget;
    const original = replyInput.value.trim();
    if (!target || posting) return;
    if (!original) {
        showToast('Type a reply first.');
        return;
    }

    // Any earlier preview is withdrawn first, so Post stays disabled until the
    // one for this text is showing.
    clearReplyPreview();

    const detected = translations[target.id]?.lang;
    const targetLang = replyLanguage(detected);
    if (!targetLang) {
        showReplyPreview(original);
        if (!detected && needsTranslation(target.text)) {
            showToast('This comment is not translated yet, so its language is unknown — the reply will post in English.');
        } else if (detected && detected !== TARGET_LANG) {
            showToast("This comment's language could not be identified — the reply will post in English.");
        }
        return;
    }

    // The admin may edit the text or close the dialog while this runs. A
    // translation of text they have since changed must not become the preview.
    const stillCurrent = () => replyTarget === target && replyInput.value.trim() === original;

    replyTranslateBtn.disabled = true;
    replyTranslateBtn.textContent = 'Translating...';
    try {
        const [reply] = await translateBatch([{ id: 'reply', text: original }], targetLang);
        if (!stillCurrent()) return;

        const translated = reply?.text || '';
        showReplyPreview(formatAdminReply(translated, original));
        if (!translated.trim() || translated.trim() === original) {
            showToast("Couldn't translate this reply — the preview shows it will post in English.");
        }
    } catch (error) {
        console.error('Reply translation failed:', error);
        if (!stillCurrent()) return;
        // Offer the English rather than discard what was typed.
        showReplyPreview(original);
        showToast(`Translation failed — you can still post the English: ${error.message}`);
    } finally {
        replyTranslateBtn.disabled = false;
        replyTranslateBtn.textContent = '🌐 Translate & preview';
    }
});

// While a post is in flight nothing in the dialog may change what it sends or
// start a second post: Post is only ever re-enabled for a preview on screen.
let posting = false;

function setReplyBusy(busy) {
    posting = busy;
    replyInput.disabled = busy;
    replyTranslateBtn.disabled = busy;
    replyPostBtn.disabled = busy || !replyBody;
}

replyPostBtn?.addEventListener('click', async () => {
    const target = replyTarget;
    const body = replyBody;
    if (posting || !target || !body) return;

    // A comment deleted since the dialog opened would get a replies node with
    // nothing else beside it — a blank ghost comment in the app.
    if (!commentsTree?.[target.movieId]?.[target.id]) {
        showToast('That comment was deleted, so the reply was not posted.');
        closeReplyDialog();
        return;
    }

    setReplyBusy(true);
    replyPostBtn.textContent = 'Posting...';
    try {
        await push(ref(db, `comments/${target.movieId}/${target.id}/replies`), {
            text: body,
            timestamp: Date.now(),
            userName: ADMIN_NAME,
            // Inert in the consumer app today; lets a verified badge be added
            // later without backfilling old replies.
            isAdmin: true
        });
        showToast('Reply posted.');
        // The admin may have moved to another comment meanwhile. Only the
        // dialog this reply came from is closed; another's draft is kept.
        if (replyTarget === target) closeReplyDialog();
    } catch (error) {
        console.error('Posting reply failed:', error);
        showToast(`Could not post reply: ${error.message}`);
    } finally {
        setReplyBusy(false);
        replyPostBtn.textContent = 'Post reply';
    }
});

// --- Deleting ---
//
// A native confirm(), matching confirmDelete for movies: the pattern this
// codebase uses. (#delete-modal in index.html is unwired markup.)

// One line, capped. A long or multi-line name or translation must not push the
// warning out of a dialog the browser truncates, or fake extra lines in it.
function forDialog(text, limit) {
    const line = String(text).replace(/\s+/g, ' ').trim();
    const clipped = clipText(line, limit);
    return clipped.length < line.length ? `${clipped}…` : line;
}

async function deleteComment(item, row) {
    const isComment = item === row;

    // The paths come from comments.js, where a key that could widen the
    // delete is refused rather than written.
    let writes;
    try {
        writes = deletionWrites(item, row);
    } catch (error) {
        console.error('Delete refused:', error);
        showToast(error.message);
        return;
    }

    // Deleting a comment takes its replies with it, which the UI does not
    // show. Stated first, so no amount of text below can push it out of view.
    const replyCount = isComment ? row.replies.length : 0;
    const cascade = replyCount > 0
        ? `This also deletes its ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}.\n\n`
        : '';
    // The admin often cannot read the original, so its translation is shown too.
    const translated = foreignTranslation(item);
    const meaning = translated ? `\n🌐 ${forDialog(translated.text, 160)}` : '';

    const message = `Delete this ${isComment ? 'comment' : 'reply'} by ${forDialog(item.userName, 60)}?\n\n` +
        `${cascade}"${forDialog(item.text, 120)}"${meaning}\n\nThis cannot be undone.`;
    if (!confirm(message)) return;

    try {
        // One atomic multi-path write: the comment or reply and every cached
        // translation that belonged to it go together, or not at all.
        await update(ref(db), writes);
        showToast(`${isComment ? 'Comment' : 'Reply'} deleted.`);
    } catch (error) {
        console.error('Deleting failed:', error);
        showToast(`Could not delete: ${error.message}`);
    }
}

// --- Analytics ---
//
// The view reads movies and comments through getters, so every render joins
// against what is loaded at that moment. The router and both listeners above
// reference analyticsView before this line; that is safe only because they run
// after module evaluation — app.js has no top-level await to change that.
const analyticsView = initAnalyticsView({
    section: document.getElementById('analytics-view'),
    getMovies: () => allMovies,
    getCommentRows: () => commentRows
});
