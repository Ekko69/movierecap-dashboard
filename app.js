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

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const storage = getStorage(app);

// OpenAI Configuration
// OpenAI Configuration
// API Key is now handled on the server side (Vercel Functions)
const AI_API_URL = '/api/ai-service';


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

// Upload Status
const progressContainer = document.getElementById('progress-container');
const uploadProgressBar = document.getElementById('upload-progress-bar');
const saveBtn = document.getElementById('save-btn');
const aiGenerateBtn = document.getElementById('ai-generate-btn');


const subtitleInput = document.getElementById('subtitle-file');
const subtitleFileName = document.getElementById('subtitle-file-name');

let currentVideoFile = null;
let currentThumbnailBlob = null;
let currentSubtitleFile = null;
let editingMovieId = null;

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

// Search
searchInput.addEventListener('input', (e) => filterMovies(e.target.value));

// AI Generate Description
aiGenerateBtn.addEventListener('click', generateDescription);

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

    thumbnailImg.src = '';
    thumbnailImg.classList.add('hidden');
    thumbPlaceholder.classList.remove('hidden');
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


async function handleFormSubmit(e) {
    e.preventDefault();

    const title = document.getElementById('title').value;
    const year = parseInt(document.getElementById('year').value);
    const duration = document.getElementById('duration').value;
    const description = document.getElementById('description').value;

    // Collect selected categories
    const selectedCategories = Array.from(document.querySelectorAll('input[name="category"]:checked'))
        .map(cb => cb.value);

    if (selectedCategories.length === 0) {
        alert('Please select at least one category.');
        return;
    }

    if (!editingMovieId && (!currentVideoFile || !currentThumbnailBlob)) {
        alert('Please upload a video and capture a thumbnail.');
        return;
    }

    saveBtn.disabled = true;
    progressContainer.classList.remove('hidden');

    try {
        let videoUrl = null;
        let thumbnailUrl = null;

        const movieId = editingMovieId || crypto.randomUUID();

        // Upload Media if present to Storage
        if (currentVideoFile) {
            // Upload Video
            const vidRef = storageRef(storage, `videos/${movieId}/${currentVideoFile.name}`);
            const vidUploadAndProgress = uploadBytesResumable(vidRef, currentVideoFile);

            // Just a basic progress visualization combining both
            vidUploadAndProgress.on('state_changed', (snapshot) => {
                const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
                uploadProgressBar.style.width = `${progress * 0.9}%`; // 90% for video
            });

            await vidUploadAndProgress;
            videoUrl = await getDownloadURL(vidRef);

            // Upload Thumbnail (only if video changed or explicitly captured)
            if (currentThumbnailBlob) {
                const thumbRef = storageRef(storage, `thumbnails/${movieId}/thumbnail.jpg`);
                await uploadBytesResumable(thumbRef, currentThumbnailBlob);
                thumbnailUrl = await getDownloadURL(thumbRef);
            }
        }

        // Complete data object
        const movieData = {
            id: movieId,
            title,
            year,
            duration,
            categories: selectedCategories,
            description,
            updatedAt: Date.now()
        };

        if (videoUrl) movieData.videoURL = videoUrl;
        if (thumbnailUrl) movieData.thumbnail = thumbnailUrl;

        // Upload Subtitle if present
        if (currentSubtitleFile) {
            const subRef = storageRef(storage, `subtitles/${movieId}/${currentSubtitleFile.name}`);
            await uploadBytesResumable(subRef, currentSubtitleFile);
            const subtitleUrl = await getDownloadURL(subRef);
            movieData.subtitleURL = subtitleUrl;
        }

        // Save to Database
        if (editingMovieId) {
            await update(ref(db, 'movies/' + movieId), movieData);
        } else {
            await set(ref(db, 'movies/' + movieId), movieData);
        }

        uploadProgressBar.style.width = '100%';
        setTimeout(() => {
            closeForm();
            // Optional: Success toast
        }, 500);

    } catch (error) {
        console.error("Error saving movie:", error);
        alert("Error saving movie: " + error.message);
    } finally {
        saveBtn.disabled = false;
    }
}

// --- Realtime Listeners ---

const moviesRef = ref(db, 'movies');
onValue(moviesRef, (snapshot) => {
    moviesContainer.innerHTML = '';
    const data = snapshot.val();

    if (!data) {
        moviesContainer.innerHTML = '<p class="loading-state">No movies found. Add one!</p>';
        return;
    }

    const movieList = Object.values(data).sort((a, b) => b.updatedAt - a.updatedAt);

    movieList.forEach(movie => {
        const card = createMovieCard(movie);
        moviesContainer.appendChild(card);
    });
});

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

        console.log(`Successfully deleted movie: ${title}`);
    } catch (error) {
        console.error('Error deleting movie:', error);
        alert('Error deleting movie: ' + error.message);
    }
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
