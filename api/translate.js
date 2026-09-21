// Batch translation of user comments into the admin's language.
//
// Separate from api/ai-service.js on purpose: that endpoint is hardwired to a
// movie-metadata system prompt and a one-prompt-one-completion shape, while
// this one batches, detects source languages and must return strict JSON.

import Anthropic from '@anthropic-ai/sdk';

const OPENAI_MODEL = 'gpt-4o-mini';
const CLAUDE_MODEL = 'claude-opus-5';

const SYSTEM_PROMPT = `You translate short user comments from a movie app.
Reply with JSON only, in this exact shape:
{"items":[{"id":"<the id you were given>","lang":"<ISO 639-1 code of the ORIGINAL language>","text":"<translation>"}]}
Rules:
- Return exactly one entry for every id you were given.
- If a comment is already in the target language, copy it unchanged into "text" and set "lang" to that language's code.
- Translate meaning, not word for word. These are casual comments; keep them short and plain.
- Preserve emoji. Never add commentary, notes, apologies or extra keys.`;

// The model is asked for bare JSON but may still wrap it in a code fence or
// wrap prose around it. Everything here is defensive: a malformed response
// must raise a describable error, never crash the request or silently return
// half a batch.
export function parseTranslationResponse(content) {
    if (!content) throw new Error('Translator returned an empty response');

    const unfenced = String(content)
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/```$/, '')
        .trim();

    const start = unfenced.indexOf('{');
    const end = unfenced.lastIndexOf('}');
    if (start === -1 || end === -1) {
        throw new Error('Translator returned no JSON object');
    }

    let parsed;
    try {
        parsed = JSON.parse(unfenced.slice(start, end + 1));
    } catch (error) {
        throw new Error(`Translator returned invalid JSON: ${error.message}`);
    }

    if (!Array.isArray(parsed.items)) {
        throw new Error('Translator response has no items array');
    }

    return parsed.items
        .filter(item => item && typeof item.id === 'string')
        .map(item => ({
            id: item.id,
            lang: typeof item.lang === 'string' ? item.lang : 'unknown',
            text: typeof item.text === 'string' ? item.text : ''
        }));
}

export default async function handler(req, res) {
    const requestId = `tr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { items, targetLang } = req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'items must be a non-empty array' });
    }

    const target = targetLang || 'en';
    const prompt = buildPrompt(items, target);

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

    if (!OPENAI_API_KEY && !ANTHROPIC_API_KEY) {
        console.error('Translate: no provider key configured', { requestId });
        return res.status(500).json({
            error: 'No AI provider configured on server. Set OPENAI_API_KEY or ANTHROPIC_API_KEY.'
        });
    }

    // Primary: OpenAI. Any failure falls through to Claude rather than
    // surfacing an error, matching api/ai-service.js.
    if (OPENAI_API_KEY) {
        try {
            console.info('Translate request', { requestId, provider: 'openai', count: items.length });
            const content = await callOpenAI({ prompt, apiKey: OPENAI_API_KEY });
            return res.status(200).json({ items: parseTranslationResponse(content), provider: 'openai' });
        } catch (error) {
            console.error('Translate: OpenAI failed, falling back to Claude', {
                requestId, message: error.message
            });
            if (!ANTHROPIC_API_KEY) {
                return res.status(500).json({
                    error: `${error.message} (no ANTHROPIC_API_KEY configured for fallback)`,
                    requestId
                });
            }
        }
    }

    // Fallback: Claude
    try {
        console.info('Translate request', { requestId, provider: 'anthropic', count: items.length });
        const content = await callClaude({ prompt, apiKey: ANTHROPIC_API_KEY });
        return res.status(200).json({ items: parseTranslationResponse(content), provider: 'anthropic' });
    } catch (error) {
        console.error('Translate: Claude fallback also failed', { requestId, message: error.message });
        return res.status(500).json({ error: error.message, requestId });
    }
}

function buildPrompt(items, targetLang) {
    const payload = items.map(item => ({ id: item.id, text: item.text }));
    return `Target language: ${targetLang}\n\nComments:\n${JSON.stringify(payload, null, 1)}`;
}

async function callOpenAI({ prompt, apiKey }) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: OPENAI_MODEL,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: prompt }
            ],
            // Translating 25 comments needs real headroom; comments run long.
            max_tokens: 4096,
            temperature: 0.2,
            response_format: { type: 'json_object' }
        })
    });

    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.error?.message || `OpenAI API error ${response.status}`);
    }
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('OpenAI returned no completion content');
    return content;
}

async function callClaude({ prompt, apiKey }) {
    const anthropic = new Anthropic({ apiKey });

    const message = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        // Opus 5 counts thinking against max_tokens, so a batch of 25 needs
        // considerably more than the visible output will use. Temperature is
        // deliberately not sent — Opus 5 rejects sampling parameters with a 400.
        max_tokens: 8192,
        output_config: { effort: 'low' },
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }]
    });

    if (message.stop_reason === 'refusal') {
        const category = message.stop_details?.category || 'unspecified';
        throw new Error(`Claude declined the request (${category})`);
    }

    const content = message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
        .trim();

    if (!content) throw new Error('Claude returned no text content');
    return content;
}
