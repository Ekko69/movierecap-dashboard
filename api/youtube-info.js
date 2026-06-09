import { spawn } from 'child_process';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const { videoId } = req.query;
    if (!videoId) return res.status(400).json({ error: 'Missing videoId' });

    if (process.env.VERCEL) {
        return res.status(501).json({ error: 'YouTube info is only available when running locally (node dev-server.js).' });
    }

    const url = `https://www.youtube.com/watch?v=${videoId}`;

    try {
        const data = await runYtDlp(['--dump-json', '--no-download', url]);
        const meta = JSON.parse(data);

        return res.status(200).json({
            title: meta.title || '',
            description: meta.description || '',
            duration: meta.duration || 0,
            thumbnail: meta.thumbnail || null,
            publishYear: meta.upload_date ? parseInt(meta.upload_date.slice(0, 4)) : null
        });
    } catch (err) {
        console.error('youtube-info error:', err.message);
        return res.status(500).json({ error: err.message });
    }
}

function runYtDlp(args) {
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
