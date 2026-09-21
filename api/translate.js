// Batch translation of user comments into the admin's language.
//
// Separate from api/ai-service.js on purpose: that endpoint is hardwired to a
// movie-metadata system prompt and a one-prompt-one-completion shape, while
// this one batches, detects source languages and must return strict JSON.

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
