/**
 * Deepgram Flux TTS English voices. Deepgram has no API to list voices
 * programmatically, so this is a hardcoded snapshot of the documented
 * catalog (developers.deepgram.com/docs/flux-tts/voices),
 * `flux-[voicename]-[language]` (e.g. flux-haley-en).
 */

export interface DeepgramVoiceOption {
  model: string;
  name: string;
  description?: string;
}

export const DEEPGRAM_FLUX_ENGLISH_VOICES: DeepgramVoiceOption[] = [
  { model: 'flux-hannah-en', name: 'Hannah', description: 'Clear, confident, thoughtful' },
  { model: 'flux-kit-en', name: 'Kit', description: 'Friendly, energetic, thoughtful' },
  { model: 'flux-alexis-en', name: 'Alexis', description: 'Clear, professional, calm' },
  { model: 'flux-cliff-en', name: 'Cliff', description: 'Deep, confident, calm' },
  { model: 'flux-sienna-en', name: 'Sienna', description: 'Clear, professional, calm' },
  { model: 'flux-cole-en', name: 'Cole', description: 'Friendly, clear, interesting' },
  { model: 'flux-brooke-en', name: 'Brooke', description: 'Friendly, intelligent, fast' },
  { model: 'flux-colin-en', name: 'Colin', description: 'Warm, friendly, trustworthy' },
  { model: 'flux-gemma-en', name: 'Gemma', description: 'Friendly, kind, approachable' },
  { model: 'flux-haley-en', name: 'Haley', description: 'Clear, professional, caring' },
  { model: 'flux-heather-en', name: 'Heather', description: 'Clear, engaging, energetic' },
  { model: 'flux-miles-en', name: 'Miles', description: 'Clear, calm, professional' },
  { model: 'flux-sean-en', name: 'Sean', description: 'Friendly, kind, caring' },
  { model: 'flux-bree-en', name: 'Bree', description: 'Friendly, sweet, kind' },
  { model: 'flux-brittany-en', name: 'Brittany', description: 'Confident, kind, soft' },
  { model: 'flux-bruce-en', name: 'Bruce', description: 'Friendly, kind, natural' },
  { model: 'flux-conor-en', name: 'Conor', description: 'Confident, deep, friendly' },
  { model: 'flux-donovan-en', name: 'Donovan', description: 'Professional, calm, thoughtful' },
  { model: 'flux-drew-en', name: 'Drew', description: 'Confident, relaxed, soft' },
  { model: 'flux-elise-en', name: 'Elise', description: 'Clear, professional, calm' },
  { model: 'flux-jack-en', name: 'Jack', description: 'Confident, thoughtful, friendly' },
  { model: 'flux-kai-en', name: 'Kai', description: 'Clear, calm, professional' },
  { model: 'flux-kelsey-en', name: 'Kelsey', description: 'Clear, professional, caring' },
  { model: 'flux-maeve-en', name: 'Maeve', description: 'Friendly, energetic, confident' },
  { model: 'flux-marcelo-en', name: 'Marcelo', description: 'Clear, calm, professional' },
  { model: 'flux-marcus-en', name: 'Marcus', description: 'Friendly, helpful, smooth' },
  { model: 'flux-meena-en', name: 'Meena', description: 'Empathetic, professional, calm' },
  { model: 'flux-meghan-en', name: 'Meghan', description: 'Friendly, nice, energetic' },
  { model: 'flux-naveen-en', name: 'Naveen', description: 'Clear, professional, knowledgeable' },
  { model: 'flux-paige-en', name: 'Paige', description: 'Clear, professional, calm' },
  { model: 'flux-priya-en', name: 'Priya', description: 'Confident, empathetic, professional' },
  { model: 'flux-rufus-en', name: 'Rufus', description: 'Friendly, confident, intelligent' },
  { model: 'flux-sharon-en', name: 'Sharon', description: 'Formal, calm, relaxed' },
  { model: 'flux-tanner-en', name: 'Tanner', description: 'Professional, calm, confident' },
  { model: 'flux-wade-en', name: 'Wade', description: 'Warm, confident, clear' },
  { model: 'flux-wes-en', name: 'Wes', description: 'Thoughtful, friendly, warm' },
];

export const DEFAULT_DEEPGRAM_TTS_MODEL = 'flux-haley-en';

// Flux TTS accepts speed 0.5-1.5 in 0.05 increments. Two reference pages say
// so verbatim, quoted here so cross-checking is a string match rather than a
// hunt:
//   docs/tts-voice-controls    "Flux TTS (/v2/speak) supports speed
//                               (0.5-1.5 in 0.05 steps)"
//   docs/flux-tts/feature-overview
//                              "Adjust speed (0.5-1.5 in 0.05 steps)
//                               without reconnecting"
// Out of range is rejected as SPEED_OUT_OF_RANGE, off-increment as
// SPEED_INCREMENT_INVALID — hence both the bounds and the grid check below.
//
// Note for anyone cross-checking: Flux's GA launch post says "seven values
// from 0.85 to 1.15". That was the original range and it has since been
// widened to 0.5-1.5, with every previously accepted value still valid. The
// reference docs are current; the launch post is not. Don't take 0.85 from a
// blog post over the API reference. The 0.7 floor this replaced was Aura-2's
// (which that same tts-voice-controls page lists as 0.7-1.5) — a different
// endpoint, never evidence about /v2/speak.
export const DEEPGRAM_TTS_SPEED_MIN = 0.5;
export const DEEPGRAM_TTS_SPEED_MAX = 1.5;
export const DEEPGRAM_TTS_SPEED_STEP = 0.05;
export const DEFAULT_DEEPGRAM_TTS_SPEED = 1;

export function isKnownDeepgramVoiceModel(model: string): boolean {
  return DEEPGRAM_FLUX_ENGLISH_VOICES.some((voice) => voice.model === model);
}

// Slack for binary floating point only: `0.5 + 13 * 0.05` is
// 1.1500000000000001, so an exact comparison against a grid point would
// reject speeds the slider itself produces. Far tighter than the 0.005 a
// round-to-hundredths check would forgive.
const SPEED_GRID_TOLERANCE = 1e-9;

/**
 * Deepgram accepts speed only on the documented 0.05 grid — an in-range but
 * off-grid value (0.72) still 400s. Validated by distance to the nearest grid
 * point rather than a modulo, so the grid has exactly one definition
 * (`normalizeDeepgramTtsSpeed`) and a near-miss like 0.7011 is rejected
 * instead of being silently rounded into range: the update path stores the
 * number as given and narration sends it unchanged.
 */
export function isValidDeepgramTtsSpeed(speed: number): boolean {
  if (!Number.isFinite(speed)) {
    return false;
  }
  if (speed < DEEPGRAM_TTS_SPEED_MIN || speed > DEEPGRAM_TTS_SPEED_MAX) {
    return false;
  }
  return Math.abs(speed - normalizeDeepgramTtsSpeed(speed)) < SPEED_GRID_TOLERANCE;
}

/**
 * Coerces a stored speed onto the nearest value Deepgram accepts. Used on the
 * restore path, where a backup predating the current bounds would otherwise
 * reinstate a speed that fails every TTS connection.
 */
export function normalizeDeepgramTtsSpeed(speed: number): number {
  if (!Number.isFinite(speed)) {
    return DEFAULT_DEEPGRAM_TTS_SPEED;
  }
  const clamped = Math.min(DEEPGRAM_TTS_SPEED_MAX, Math.max(DEEPGRAM_TTS_SPEED_MIN, speed));
  const steps = Math.round((clamped - DEEPGRAM_TTS_SPEED_MIN) / DEEPGRAM_TTS_SPEED_STEP);
  return Math.round((DEEPGRAM_TTS_SPEED_MIN + steps * DEEPGRAM_TTS_SPEED_STEP) * 100) / 100;
}

/**
 * Maps an unrecognised voice — an `aura-2-*` name from a backup taken before
 * the Flux upgrade, or a voice since retired from the catalog — onto the
 * current default. The database migration does this for rows already stored;
 * this covers the restore path, which writes backup values verbatim and never
 * replays migrations.
 */
export function normalizeDeepgramVoiceModel(model: string): string {
  return isKnownDeepgramVoiceModel(model) ? model : DEFAULT_DEEPGRAM_TTS_MODEL;
}
