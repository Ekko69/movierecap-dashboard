import Anthropic from '@anthropic-ai/sdk';

const OPENAI_MODEL = 'gpt-4o-mini';
const CLAUDE_MODEL = 'claude-opus-5';
const SYSTEM_PROMPT = 'You are a helpful assistant for movie metadata and description generation.';

export default async function handler(req, res) {
    const requestId = `ai_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const startedAt = new Date().toISOString();

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { prompt, max_tokens, temperature } = req.body;
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

    if (!OPENAI_API_KEY && !ANTHROPIC_API_KEY) {
        console.error('AI Service Error: no provider key configured', { requestId, startedAt });
        return res.status(500).json({ error: 'No AI provider configured on server. Set OPENAI_API_KEY or ANTHROPIC_API_KEY.' });
    }

    const maxTokens = max_tokens || 200;
    const tempValue = temperature ?? 0.7;

    // Primary: OpenAI. Any failure (missing key, network, rate limit, bad response)
    // falls through to Claude rather than surfacing an error to the client.
    if (OPENAI_API_KEY) {
        try {
            console.info('AI Service Request', {
                requestId, startedAt, provider: 'openai', model: OPENAI_MODEL,
                max_tokens: maxTokens, temperature: tempValue
            });

            const data = await callOpenAI({ prompt, maxTokens, temperature: tempValue, apiKey: OPENAI_API_KEY });

            console.info('AI Service Success', { requestId, provider: 'openai' });
            return res.status(200).json({ ...data, provider: 'openai' });

        } catch (error) {
            console.error('AI Service: OpenAI failed, falling back to Claude', {
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
        console.info('AI Service Request', {
            requestId, provider: 'anthropic', model: CLAUDE_MODEL, max_tokens: maxTokens
        });

        const data = await callClaude({ prompt, maxTokens, apiKey: ANTHROPIC_API_KEY });

        console.info('AI Service Success', { requestId, provider: 'anthropic' });
        return res.status(200).json({ ...data, provider: 'anthropic' });

    } catch (error) {
        console.error('AI Service Error: Claude fallback also failed', {
            requestId, message: error.message
        });
        return res.status(500).json({ error: error.message, requestId });
    }
}

async function callOpenAI({ prompt, maxTokens, temperature, apiKey }) {
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
            max_tokens: maxTokens,
            temperature
        })
    });

    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.error?.message || `OpenAI API error ${response.status}`);
    }
    if (!data.choices?.[0]?.message?.content) {
        throw new Error('OpenAI returned no completion content');
    }
    return data;
}

async function callClaude({ prompt, maxTokens, apiKey }) {
    const anthropic = new Anthropic({ apiKey });

    // Claude Opus 5 thinks by default, and max_tokens caps thinking + response
    // together — the caller's 100–200 token budget would be spent thinking and
    // truncate the answer. Give headroom; the prompt already constrains length.
    const params = {
        model: CLAUDE_MODEL,
        max_tokens: Math.max(maxTokens * 8, 4096),
        // Low effort keeps this short-form task fast; temperature is deliberately
        // not forwarded — Opus 5 rejects sampling parameters with a 400.
        output_config: { effort: 'low' },
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }]
    };

    let message;
    try {
        // Server-side fallback re-runs the request on another model if safety
        // classifiers decline it, instead of returning the refusal.
        message = await anthropic.beta.messages.create({
            ...params,
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default'
        });
    } catch (err) {
        if (!isFallbackUnsupported(err)) throw err;
        console.warn('AI Service: server-side fallback unavailable, retrying without it');
        message = await anthropic.messages.create(params);
    }

    if (message.stop_reason === 'refusal') {
        const category = message.stop_details?.category || 'unspecified';
        throw new Error(`Claude declined the request (${category})`);
    }

    const content = message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
        .trim();

    if (!content) {
        throw new Error('Claude returned no text content');
    }

    return toOpenAIShape({ message, content });
}

function isFallbackUnsupported(err) {
    return err?.status === 400 && /fallback|beta/i.test(err?.message || '');
}

// The client reads data.choices[0].message.content, so Claude's response is
// normalized into the OpenAI envelope and no client changes are needed.
function toOpenAIShape({ message, content }) {
    const inputTokens = message.usage?.input_tokens || 0;
    const outputTokens = message.usage?.output_tokens || 0;

    return {
        id: message.id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: message.model,
        choices: [{
            index: 0,
            message: { role: 'assistant', content },
            finish_reason: message.stop_reason === 'max_tokens' ? 'length' : 'stop'
        }],
        usage: {
            prompt_tokens: inputTokens,
            completion_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens
        }
    };
}
