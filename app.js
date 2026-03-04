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

let existingMovieKeys = new Set();


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

// Batch import
const batchInput = document.getElementById('batch-video-files');
const batchQueueEl = document.getElementById('batch-queue');
const batchProgressBar = document.getElementById('batch-progress-bar');
let batchQueue = [];

batchInput?.addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    batchQueue = files.map((file) => ({ id: crypto.randomUUID(), file, status: 'queued' }));
    batchQueueEl.textContent = batchQueue.length ? batchQueue.length + ' file(s) queued' : 'No files queued';
});

// Start Batch
const startBatchBtn = document.getElementById('start-batch-btn');
startBatchBtn?.addEventListener('click', () => {
    startBatchBtn.disabled = true;
    processBatch(2).finally(() => {
        startBatchBtn.disabled = false;
        updateBatchUI();
    });
});

// Batch processing pipeline
async function processBatch(concurrency = 2) {
    const queue = batchQueue.filter(item => item.status === 'queued');
    if (!queue.length) return;

    let running = 0;
    let index = 0;

    async function runNext() {
        if (index >= queue.length) return;
        const item = queue[index++];
        running++;
        item.status = 'processing';
        updateBatchUI();
        try {
            await processBatchItem(item);
            item.status = 'completed';
        } catch (e) {
            item.status = 'failed';
            item.error = e.message;
        }
        running--;
        updateBatchUI();
        if (index < queue.length) runNext();
    }

    for (let i = 0; i < concurrency && i < queue.length; i++) runNext();
}

async function processBatchItem(item) {
    // Upload video
    const movieId = crypto.randomUUID();
    item.movieId = movieId;
    const videoRef = storageRef(storage, `videos/${movieId}.mp4`);
    await uploadBytesResumable(videoRef, item.file);
    const url = await getDownloadURL(videoRef);
    item.videoUrl = url;
    item.status = 'uploaded';
    updateBatchUI();

    // Transcription step
    item.status = 'transcribing';
    updateBatchUI();
    const transcriptId = await transcribeAudio(url);
    const transcript = await pollTranscription(transcriptId, () => {});
    item.transcriptText = transcript.text;
    item.status = 'transcribed';
    updateBatchUI();

    // Metadata extraction
    item.status = 'extracting-metadata';
    updateBatchUI();
    const sample = item.transcriptText.substring(0, 5000);
    const metadata = await extractMovieMetadata(sample);
    item.metadata = metadata;
    item.status = 'metadata-extracted';
    updateBatchUI();

    // OMDb enrichment
    item.status = 'omdb';
    updateBatchUI();
    const { title, year } = metadata;
    const omdb = await fetchMovieFromOMDB(title, year);
    if (omdb) {
        item.omdb = omdb;
        if (omdb.Poster && omdb.Poster !== 'N/A') {
            item.posterUrl = omdb.Poster;
        }
    }
    item.status = 'omdb-done';
    updateBatchUI();

    // Save to database
    item.status = 'saving';
    updateBatchUI();
    const movieData = {
        id: item.movieId,
        title: metadata.title,
        year: metadata.year,
        description: metadata.description,
        categories: metadata.genres || [],
        videoURL: item.videoUrl,
        featuredThumbnail: item.posterUrl || null,
        updatedAt: Date.now()
    };
    const movieRef = ref(db, 'movies/' + item.movieId);
    await set(movieRef, movieData);
    item.status = 'completed';
    updateBatchUI();
}

function updateBatchUI() {
    batchQueueEl.innerHTML = '';
    if (!batchQueue.length) return;
    const completed = batchQueue.filter(i => i.status === 'completed').length;
    const total = batchQueue.length;
    if (total > 0) {
        const pct = Math.round((completed / total) * 100);
        batchProgressBar.style.width = pct + '%';
    }
    for (const item of batchQueue) {
        const li = document.createElement('li');
        li.textContent = `${item.file.name} – ${item.status}`;
        batchQueueEl.appendChild(li);
    }
    const summary = document.createElement('li');
    summary.style.marginTop = '8px';
    summary.textContent = `Progress: ${completed}/${total} completed`;
    batchQueueEl.appendChild(summary);
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

let editingMovieId = null;

let uploadedVideoUrl = null; // Track uploaded URL to avoid duplicates
let fetchedPosterUrl = null; // Store poster URL from OMDB


// --- Event Listeners ---

// Navigation / Modals
addMovieBtn.addEventListener('click', () => openForm());
closeFormBtn.addEventListener('click', () => closeForm());
cancelFormBtn.addEventListener('click', () => closeForm());

// File Drop Zone
dropZone.addEventListener('click', () => videoInput.click());
dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.style.borderColor = 'var(--color-accent)';
});
dropZone.addEventListener('dragleave', () => {
    dropZone.style.borderColor = 'rgba(255,255,255,0.2)';
});
dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.style.borderColor = 'rgba(255,255,255,0.2)';
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

// Form Submit
movieForm.addEventListener('submit', handleFormSubmit);



// Featured Thumbnail (Poster)
featuredInput.addEventListener('change', (e) => {
    if (e.target.files.length) {
        const file = e.target.files[0];
        currentFeaturedThumbnailFile = file;
        const url = URL.createObjectURL(file);
        featuredPreview.src = url;
        featuredPreview.classList.remove('hidden');
        featuredPlaceholder.classList.add('hidden');
        featuredDropContent.classList.add('hidden');
        removeFeaturedBtn.classList.remove('hidden');
        posterSyncStatus.classList.add('hidden');
    }
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
    aiGenerateBtn.textContent = '⏳ Generating...';

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
        aiGenerateBtn.textContent = '✨ AI Generate';
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
    document.getElementById('form-title').innerText = 'Add New Movie';

    // Uncheck all categories
    document.querySelectorAll('input[name="category"]').forEach(cb => cb.checked = false);

    if (movie) {
        editingMovieId = movie.id;
        document.getElementById('form-title').innerText = 'Edit Movie';
        document.getElementById('title').value = movie.title;
        document.getElementById('year').value = movie.year;
        document.getElementById('duration').value = movie.duration;
        document.getElementById('description').value = movie.description;

        // Check the categories
        if (movie.categories && Array.isArray(movie.categories)) {
            movie.categories.forEach(cat => {
                const checkbox = document.querySelector(`input[name="category"][value="${cat}"]`);
                if (checkbox) checkbox.checked = true;
            });
        }

        // Handling existing media for edit is complex without re-upload/preview
        // For this version, we'll keep it simple: assume user keeps media if not changed.
        // We show a note or just show current thumbnail if possible.
        if (movie.thumbnail) {
            thumbnailImg.src = movie.thumbnail;
            thumbnailImg.classList.remove('hidden');
            thumbPlaceholder.classList.add('hidden');
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
}

function closeForm() {
    movieFormPanel.classList.add('hidden');
    videoPreview.pause();
}

function resetMediaInputs() {
    currentVideoFile = null;
    currentThumbnailBlob = null;
    currentSubtitleFile = null;
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
    thumbnailImg.classList.add('hidden');
    thumbPlaceholder.classList.remove('hidden');

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

    // Convert to blob
    croppedCanvas.toBlob((blob) => {
        currentThumbnailBlob = blob;
        const url = URL.createObjectURL(blob);
        thumbnailImg.src = url;
        thumbnailImg.classList.remove('hidden');
        thumbPlaceholder.classList.add('hidden');

        // Hide crop interface
        cropInterface.classList.add('hidden');
        cropControls.classList.add('hidden');
        captureBtn.classList.remove('hidden');
    }, 'image/jpeg', 0.85);
});

cancelCropBtn.addEventListener('click', () => {
    cropInterface.classList.add('hidden');
    cropControls.classList.add('hidden');
    captureBtn.classList.remove('hidden');
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
        alert("Please select a video file first.");
        return;
    }

    if (!ASSEMBLY_AI_KEY) {
        alert("Assembly API Key is missing.");
        return;
    }

    const btn = document.getElementById('sync-data-btn');
    btn.disabled = true;
    btn.textContent = "⏳ Syncing...";
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
        setTimeout(() => {
            progressContainer.classList.add('hidden');
            alert("Sync completed successfully! Please review the details.");
        }, 500);

    } catch (error) {
        console.error("Sync error:", error);
        alert("Sync failed: " + error.message);
        document.querySelector('.progress-label').textContent = "Sync Failed!";
    } finally {
        btn.disabled = false;
        btn.textContent = "⚡ Sync Movie Data";
    }
}

async function handleFormSubmit(e) {
    e.preventDefault();

    let title = document.getElementById('title').value;
    let year = document.getElementById('year').value;

    // Duplicate detection
    const dupKey = buildDuplicateKey(title, year);
    if (!editingMovieId && existingMovieKeys.has(dupKey)) {
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
            categories: selectedCategories.length ? selectedCategories : ['New'],
            description: description || "No description",
            updatedAt: Date.now()
        };

        if (videoUrl) movieData.videoURL = videoUrl;
        if (videoUrl) movieData.videoURL = videoUrl;
        if (thumbnailUrl) movieData.thumbnail = thumbnailUrl;
        if (featuredThumbnailUrl) movieData.featuredThumbnail = featuredThumbnailUrl;

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
        setTimeout(() => {
            closeForm();
            alert("Movie saved successfully!");
        }, 500);

    } catch (error) {
        console.error("Error saving movie:", error);
        alert("Error saving movie: " + error.message);
    } finally {
        saveBtn.disabled = false;
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
    applyFiltersAndRender();
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
    const categoriesDisplay = movie.categories && Array.isArray(movie.categories)
        ? movie.categories.join(', ')
        : (movie.category || 'Uncategorized');

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
