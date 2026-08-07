import { runYtDlp, streamYtDlp } from './_ytdlp.js';

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
            const meta = JSON.parse(await runYtDlp(['--dump-json', '--no-download', '--no-playlist', url]));
            title = (meta.title || videoId).replace(/[^a-zA-Z0-9_\-. ]/g, '').trim() || videoId;
        } catch (_) {}

        // Stream yt-dlp output directly to the response, retrying across player clients
        // while nothing has been written yet
        streamYtDlp(
            ['-f', formatSelector, '--no-playlist', '-o', '-', url],
            res,
            {
                // Set download headers only once bytes are actually flowing, so an
                // extraction failure can still return a JSON error instead of a
                // zero-byte .mp4 attachment
                onFirstByte: () => {
                    res.setHeader('Content-Type', 'video/mp4');
                    res.setHeader('Content-Disposition', `attachment; filename="${title}.mp4"`);
                },
                onError: (err, wroteBytes) => {
                    console.error('youtube-download error:', err.message);
                    if (!wroteBytes && !res.headersSent) {
                        res.status(500).json({ error: err.message });
                    } else {
                        res.end();
                    }
                }
            }
        );
    } catch (err) {
        console.error('youtube-download error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: err.message });
    }
}
