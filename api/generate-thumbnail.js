const IMAGE_MODEL = 'gpt-image-2.5-flare';
// Both edges must be multiples of 16, which rules out 1920x1080. This is exact
// 16:9, so the client's 1920x1080 watermark canvas does not stretch it.
const IMAGE_SIZE = '2048x1152';

const SYSTEM_PROMPT = `You are a master photorealistic image renderer and cinematographer. You take a precise scene description and produce a result that is indistinguishable from a real photograph or a frame from a big-budget Hollywood film. Your images have the weight, texture, and physical believability of real life — not rendered, not illustrated, not painted. Every pore, fabric thread, light reflection, and shadow behaves exactly as it would in the real physical world. You never deviate from photorealism under any circumstances.`;

async function describeImageWithVision(imageUrl, openAiKey) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${openAiKey}`
        },
        body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'image_url',
                            image_url: { url: imageUrl, detail: 'high' }
                        },
                        {
                            type: 'text',
                            text: `Describe this image in precise detail for use as a generation reference. Cover:
1. Every person/character: exact appearance, clothing, expression, pose, position in frame
2. Every object or prop visible
3. The setting and background environment
4. Existing lighting conditions and color tones
5. The overall mood and energy of the scene
6. Camera angle and framing

Be very specific and literal — this description will be used to recreate the exact same scene. Do not interpret or editorialize. Just describe what you see.`
                        }
                    ]
                }
            ],
            max_tokens: 600
        })
    });

    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error?.message || `Vision API returned ${res.status}`);
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || '';
}

const buildPrompt = (sceneDescription) => {
    // The Images API has no system prompt field, so it leads the prompt instead.
    return `${SYSTEM_PROMPT}

Recreate this exact scene as an ultra-photorealistic cinematic photograph:

ORIGINAL SCENE — preserve every detail exactly:
${sceneDescription}

REALISM REQUIREMENTS (highest priority):
- Ultra-photorealistic output — the image must be completely indistinguishable from a real photograph
- Shot on ARRI Alexa 65 with Panavision anamorphic lenses at 2.39:1, full-frame sensor
- Physically accurate light behavior: every shadow, reflection, and highlight obeys real-world optics
- Hyper-detailed skin pores, fabric microfibers, surface imperfections, subsurface scattering on skin
- Real-world depth of field: subject tack-sharp with natural optical bokeh falloff behind
- Micro-motion blur on any fast-moving elements to sell physical presence
- No AI artifacts, no plastic skin, no synthetic-looking surfaces — everything must have real material weight

CINEMATIC LIGHTING UPGRADE:
- Elevate the existing lighting into a dramatic Hollywood key-fill-rim three-point setup
- Add deep, directional shadows with soft penumbras — light behaves like a real physical source
- Volumetric god rays or light shafts where scene context allows
- Practical light sources (windows, screens, fire, neon) cast accurate colored spill onto nearby surfaces
- Specular highlights are tight and physically correct — no diffuse painted-on glows

CINEMATIC COLOR GRADE:
- Full professional DI color grade: deep crushed blacks (lifted just above clip), rich saturated midtones, creamy highlights
- Teal-and-orange skin/environment separation — Dune / Blade Runner 2049 / Mad Max: Fury Road aesthetic
- Shadow tint: cool deep blue-purple; highlight tint: warm amber-gold
- Film grain at ISO 800 equivalent — visible but not distracting, adds analogue texture

ATMOSPHERE & DEPTH:
- Thin layer of atmospheric haze or practical smoke appropriate to the scene — adds aerial perspective
- Micro-particles (dust motes, floating embers, moisture droplets) visible in light shafts
- Subtle optical lens flare from practical light sources — anamorphic oval streak, not digital

BRAND COLOR ACCENTS (physical, not decorative):
- Integrate small amounts of these colors as real light sources or reflections: hot pink (#ff0060), magenta (#bd369e), deep purple (#b448b5), teal (#78fac3)
- Must appear as: colored practical lights in the background, neon sign spill, rim light from an off-frame source, or colored reflection on a wet surface
- Must read as physically real — never painted on, never post-process overlaid

COMPOSITION:
- All subjects remain in their exact original positions — do not reframe or repose
- Strengthen foreground/background depth separation via lighting, not repositioning
- 16:9 frame at 2048×1152, optimized for thumbnail clarity at small mobile sizes

NON-NEGOTIABLE RULES:
- Identical subjects: every person's face, body, clothing must match the original exactly
- No new characters, no removed characters, no altered appearances
- Zero text, titles, captions, watermarks, or UI elements of any kind
- 100% photorealistic — any painterly, illustrated, or rendered quality is a failure`;
};

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY not configured on server' });

    const { thumbnailUrl } = req.body;
    if (!thumbnailUrl) return res.status(400).json({ error: 'Missing thumbnailUrl' });

    try {
        // Step 1: Describe the source frame
        const sceneDescription = await describeImageWithVision(thumbnailUrl, OPENAI_API_KEY);
        if (!sceneDescription) throw new Error('Failed to analyze thumbnail image');

        console.log('[generate-thumbnail] Scene description:', sceneDescription.slice(0, 200) + '...');

        // Step 2: Generate cinematic thumbnail using the visual description
        const imageRes = await fetch('https://api.openai.com/v1/images/generations', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: IMAGE_MODEL,
                prompt: buildPrompt(sceneDescription),
                size: IMAGE_SIZE,
                quality: 'high',
                output_format: 'jpeg',
                n: 1
            })
        });

        if (!imageRes.ok) {
            const errData = await imageRes.json().catch(() => ({}));
            throw new Error(errData?.error?.message || `OpenAI Images API returned ${imageRes.status}`);
        }

        const data = await imageRes.json();
        const b64 = data?.data?.[0]?.b64_json;
        if (!b64) throw new Error('No image returned from OpenAI');

        return res.status(200).json({ imageUrl: `data:image/jpeg;base64,${b64}` });
    } catch (err) {
        const msg = err?.message || String(err);
        console.error('[generate-thumbnail]', msg);
        return res.status(500).json({ error: msg });
    }
}
