import { spawn } from 'child_process';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const { videoId, quality = '360p' } = req.query;
    if (!videoId) return res.status(400).json({ error: 'Missing videoId' });

    // yt-dlp requires a local Python installation — not available on Vercel cloud
    if (process.env.VERCEL) {
        return res.status(501).json({ error: 'YouTube download is only available when running locally (node dev-server.js). On production, upload the video file directly.' });
    }

    const url = `https://www.youtube.com/watch?v=${videoId}`;

    // Build format selector from requested quality
    const heightMap = { '360p': 360, '480p': 480, '720p': 720, '1080p': 1080 };
    const height = heightMap[quality] || 360;
    // Prefer pre-muxed mp4 at the target height (no FFmpeg needed); fall back to next best
    const formatSelector = `best[height<=${height}][ext=mp4]/best[height<=${height}]/best[ext=mp4]/best`;

    try {
        // First, get video title for Content-Disposition
        let title = videoId;
        try {
            const meta = JSON.parse(await runYtDlpCollect(['--dump-json', '--no-download', url]));
            title = (meta.title || videoId).replace(/[^a-zA-Z0-9_\-. ]/g, '').trim() || videoId;
        } catch (_) {}

        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', `attachment; filename="${title}.mp4"`);

        // Stream yt-dlp output directly to response
        // --extractor-args android bypasses YouTube's SABR streaming restriction
        const proc = spawn('python3', [
            '-m', 'yt_dlp',
            '-f', formatSelector,
            '--extractor-args', 'youtube:player_client=android',
            '--no-playlist',
            '-o', '-',
            url
        ]);

        proc.stdout.pipe(res);

        proc.stderr.on('data', chunk => {
            // Log to server console but don't send to client (headers already sent)
            process.stderr.write(chunk);
        });

        proc.on('close', (code) => {
            if (code !== 0 && !res.headersSent) {
                res.status(500).json({ error: `yt-dlp exited with code ${code}` });
            } else {
                res.end();
            }
        });

        proc.on('error', (err) => {
            console.error('yt-dlp spawn error:', err.message);
            if (!res.headersSent) {
                res.status(500).json({ error: err.message });
            } else {
                res.end();
            }
        });

    } catch (err) {
        console.error('youtube-download error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: err.message });
    }
}

function runYtDlpCollect(args) {
    return new Promise((resolve, reject) => {
        const proc = spawn('python3', ['-m', 'yt_dlp', ...args]);
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', d => stdout += d);
        proc.stderr.on('data', d => stderr += d);
        proc.on('close', code => {
            if (code !== 0) reject(new Error(stderr.trim() || `yt-dlp exited ${code}`));
            else resolve(stdout.trim());
        });
        proc.on('error', reject);
    });
}
