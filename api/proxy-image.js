export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'Missing url' });

    try {
        const response = await fetch(decodeURIComponent(url), {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        if (!response.ok) return res.status(response.status).end();

        res.setHeader('Content-Type', response.headers.get('content-type') || 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        const buffer = await response.arrayBuffer();
        res.end(Buffer.from(buffer));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}
