import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { extname, join } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync } from 'fs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PORT = 3000;

// Load .env into process.env
const envPath = join(__dirname, '.env');
if (existsSync(envPath)) {
    readFileSync(envPath, 'utf-8').split('\n').forEach(line => {
        const [key, ...rest] = line.split('=');
        if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
    });
}

const MIMES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.json': 'application/json',
    '.srt': 'text/plain',
    '.vtt': 'text/vtt',
    '.mp4': 'video/mp4',
};

const API_MODULES = {};

async function loadApiHandler(name) {
    if (!API_MODULES[name]) {
        const mod = await import(`./api/${name}.js`);
        API_MODULES[name] = mod.default;
    }
    return API_MODULES[name];
}

function addVercelHelpers(req, res, url) {
    req.query = Object.fromEntries(url.searchParams.entries());
    req.body = {};

    const origStatus = res.statusCode;
    res.status = (code) => {
        res.statusCode = code;
        return res;
    };
    res.json = (data) => {
        if (!res.headersSent) {
            res.setHeader('Content-Type', 'application/json');
        }
        res.end(JSON.stringify(data));
        return res;
    };
}

const server = createServer(async (req, rawRes) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = url.pathname;

    // CORS for local dev
    rawRes.setHeader('Access-Control-Allow-Origin', '*');
    rawRes.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') {
        rawRes.statusCode = 200;
        rawRes.end();
        return;
    }

    // API routes
    if (pathname.startsWith('/api/')) {
        const name = pathname.slice(5).replace(/\/$/, '');
        addVercelHelpers(req, rawRes, url);

        if (req.method === 'POST') {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            try {
                req.body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
            } catch {
                req.body = {};
            }
        }

        try {
            const handler = await loadApiHandler(name);
            await handler(req, rawRes);
        } catch (err) {
            console.error(`[api/${name}]`, err.message);
            if (!rawRes.headersSent) {
                rawRes.statusCode = 500;
                rawRes.setHeader('Content-Type', 'application/json');
                rawRes.end(JSON.stringify({ error: err.message }));
            } else {
                rawRes.end();
            }
        }
        return;
    }

    // Static files
    const filePath = join(__dirname, pathname === '/' ? 'index.html' : pathname);
    try {
        const content = await readFile(filePath);
        const ext = extname(filePath);
        rawRes.setHeader('Content-Type', MIMES[ext] || 'application/octet-stream');
        rawRes.statusCode = 200;
        rawRes.end(content);
    } catch {
        rawRes.statusCode = 404;
        rawRes.end('Not found');
    }
});

server.listen(PORT, () => {
    console.log(`Dev server → http://localhost:${PORT}`);
    console.log('API routes: /api/youtube-info  /api/youtube-download  /api/ai-service');
});
