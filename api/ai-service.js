
export default async function handler(req, res) {
    const requestId = `ai_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const startedAt = new Date().toISOString();

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { prompt, max_tokens, temperature } = req.body;
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

    if (!OPENAI_API_KEY) {
        console.error('AI Service Error: missing OPENAI_API_KEY', {
            requestId,
            startedAt
        });
        return res.status(500).json({ error: 'OpenAI API key not configured on server' });
    }

    try {
        const model = 'gpt-4o-mini';
        console.info('AI Service Request', {
            requestId,
            startedAt,
            model,
            max_tokens: max_tokens || 200,
            temperature: temperature || 0.7
        });

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model,
                messages: [
                    {
                        role: 'system',
                        content: 'You are a helpful assistant for movie metadata and description generation.'
                    },
                    {
                        role: 'user',
                        content: prompt
                    }
                ],
                max_tokens: max_tokens || 200,
                temperature: temperature || 0.7
            })
        });

        const data = await response.json();

        if (!response.ok) {
            console.error('AI Service Error: OpenAI response not OK', {
                requestId,
                status: response.status,
                error: data?.error || null
            });
            throw new Error(data.error?.message || 'OpenAI API error');
        }

        console.info('AI Service Success', {
            requestId,
            status: response.status
        });
        return res.status(200).json(data);

    } catch (error) {
        console.error('AI Service Error:', {
            requestId,
            message: error.message
        });
        return res.status(500).json({ error: error.message, requestId });
    }
}
