import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SYSTEM_PROMPT = `You are a world-class cinematic thumbnail artist. You receive an exact visual description of a real image and recreate that exact scene with dramatically elevated cinematic production quality. You never change who or what is in the scene — the subjects, people, objects, and setting are preserved exactly. You only enhance the lighting, atmosphere, color grade, and visual drama. Your output always looks like a frame pulled from a blockbuster film — photorealistic, never illustrated or CGI.`;

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

    return `Recreate this exact scene with cinematic production enhancement:

ORIGINAL SCENE (do not change any of this):
${sceneDescription}

ENHANCEMENT INSTRUCTIONS — apply these on top of the exact scene above:

PHOTOGRAPHY & LIGHTING:
- Shot on ARRI Alexa with anamorphic lens, subtle 2.39:1 oval bokeh
- Elevate the existing lighting: add depth, rim lighting on subjects, volumetric haze
- Shallow depth of field — foreground subject razor-sharp, background softly blurred
- Add subtle god rays or atmospheric light shafts where appropriate

COLOR GRADE:
- Hollywood cinematic grade: deep crushed blacks, rich midtones, lifted highlights
- Teal-and-orange complementary grade with hints of purple in shadows
- High contrast with visible texture — Blade Runner / Dune / Mad Max aesthetic

ATMOSPHERE:
- Add thin atmospheric smoke or fog layers for cinematic depth
- Subtle lens flare from any existing light sources
- Environmental particles (dust, embers, haze) appropriate to the scene setting

BRAND COLOR ACCENTS (subtle, not dominant):
- Weave small touches of these brand colors into the scene: hot pink (#ff0060), magenta (#bd369e), deep purple (#b448b5), teal (#78fac3)
- Express them as: colored rim lighting on the subject, ambient glow bleeding into background fog, faint neon reflections on surfaces, or a soft color leak from an off-frame light source
- These accents should feel like a natural part of the scene's lighting — never painted on, never overwhelming the subject

COMPOSITION:
- Keep every subject in the same position as the original
- Strengthen foreground/background separation
- Frame is 16:9, 1920×1080, optimized for YouTube mobile viewing

ABSOLUTE RULES:
- Every person, character, face, and object from the original scene must appear identical
- Do NOT add new characters, remove characters, or alter anyone's appearance
- Do NOT add any text, titles, or overlays
- Output must be fully photorealistic — no illustration, no painting, no CGI${logoInstruction}`;
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
