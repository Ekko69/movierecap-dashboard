import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

const buildPrompt = (sceneDescription, logoUrl) => {
    const logoInstruction = logoUrl
        ? `\n\nWATERMARK: Place the pink-purple circular logo from ${logoUrl} as a small semi-transparent watermark (~7% of frame width) in the bottom-right corner. Preserve its exact colors. Keep it premium, subtle, and non-intrusive.`
        : '';

    return `Recreate this exact scene as an ultra-photorealistic cinematic photograph:

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
- 16:9 frame at 1920×1080, optimized for thumbnail clarity at small mobile sizes

NON-NEGOTIABLE RULES:
- Identical subjects: every person's face, body, clothing must match the original exactly
- No new characters, no removed characters, no altered appearances
- Zero text, titles, captions, watermarks, or UI elements of any kind
- 100% photorealistic — any painterly, illustrated, or rendered quality is a failure${logoInstruction}`;
};

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const FAL_API_KEY = process.env.FAL_API_KEY;
    if (!FAL_API_KEY) return res.status(500).json({ error: 'FAL_API_KEY not configured on server' });

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY not configured on server' });

    const { thumbnailUrl } = req.body;
    if (!thumbnailUrl) return res.status(400).json({ error: 'Missing thumbnailUrl' });

    try {
        // Step 1: Run logo upload and vision description in parallel
        const logoPath = join(__dirname, '..', 'assets', 'img', 'logo-icon.png');
        const logoBuffer = readFileSync(logoPath);

        const [uploadRes, sceneDescription] = await Promise.all([
            fetch('https://fal.run/fal-ai/utils/upload', {
                method: 'POST',
                headers: {
                    'Authorization': `Key ${FAL_API_KEY}`,
                    'Content-Type': 'image/png'
                },
                body: logoBuffer
            }),
            describeImageWithVision(thumbnailUrl, OPENAI_API_KEY)
        ]);

        let logoUrl = null;
        if (uploadRes.ok) {
            const uploadData = await uploadRes.json();
            logoUrl = uploadData?.url || null;
        }

        if (!sceneDescription) throw new Error('Failed to analyze thumbnail image');

        console.log('[generate-thumbnail] Scene description:', sceneDescription.slice(0, 200) + '...');

        // Step 2: Generate cinematic thumbnail using the visual description
        const prompt = buildPrompt(sceneDescription, logoUrl);

        const falRes = await fetch('https://fal.run/fal-ai/nano-banana-2', {
            method: 'POST',
            headers: {
                'Authorization': `Key ${FAL_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                prompt,
                system_prompt: SYSTEM_PROMPT,
                aspect_ratio: '16:9',
                resolution: '2K',
                output_format: 'jpeg',
                num_images: 1
            })
        });

        if (!falRes.ok) {
            const errData = await falRes.json().catch(() => ({}));
            const detail = errData.detail;
            const errMsg = typeof detail === 'string' ? detail
                : Array.isArray(detail) ? detail.map(d => d.msg || JSON.stringify(d)).join('; ')
                : typeof errData.error === 'string' ? errData.error
                : JSON.stringify(errData) || `fal.ai returned ${falRes.status}`;
            throw new Error(errMsg);
        }

        const data = await falRes.json();
        const imageUrl = data?.images?.[0]?.url;
        if (!imageUrl) throw new Error('No image returned from fal.ai');

        return res.status(200).json({ imageUrl, logoUrl });
    } catch (err) {
        const msg = err?.message || String(err);
        console.error('[generate-thumbnail]', msg);
        return res.status(500).json({ error: msg });
    }
}
