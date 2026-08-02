/**
 * Deepgram Aura-2 English TTS voices. Deepgram has no API to list voices
 * programmatically, so this is a hardcoded snapshot of the documented
 * catalog (developers.deepgram.com/docs/tts-models),
 * `[modelname]-[voicename]-[language]` (e.g. aura-2-thalia-en).
 */

export interface DeepgramVoiceOption {
  model: string;
  name: string;
  description?: string;
}

export const DEEPGRAM_AURA2_ENGLISH_VOICES: DeepgramVoiceOption[] = [
  { model: 'aura-2-thalia-en', name: 'Thalia', description: 'Clear, confident, energetic' },
  { model: 'aura-2-andromeda-en', name: 'Andromeda', description: 'Casual, expressive' },
  { model: 'aura-2-helena-en', name: 'Helena', description: 'Caring, friendly, raspy' },
  { model: 'aura-2-apollo-en', name: 'Apollo', description: 'Confident, casual' },
  { model: 'aura-2-arcas-en', name: 'Arcas', description: 'Natural, smooth, clear' },
  { model: 'aura-2-aries-en', name: 'Aries', description: 'Warm, energetic, caring' },
  { model: 'aura-2-amalthea-en', name: 'Amalthea' },
  { model: 'aura-2-asteria-en', name: 'Asteria' },
  { model: 'aura-2-athena-en', name: 'Athena' },
  { model: 'aura-2-atlas-en', name: 'Atlas' },
  { model: 'aura-2-aurora-en', name: 'Aurora' },
  { model: 'aura-2-callista-en', name: 'Callista' },
  { model: 'aura-2-cora-en', name: 'Cora' },
  { model: 'aura-2-cordelia-en', name: 'Cordelia' },
  { model: 'aura-2-delia-en', name: 'Delia' },
  { model: 'aura-2-draco-en', name: 'Draco' },
  { model: 'aura-2-electra-en', name: 'Electra' },
  { model: 'aura-2-harmonia-en', name: 'Harmonia' },
  { model: 'aura-2-hera-en', name: 'Hera' },
  { model: 'aura-2-hermes-en', name: 'Hermes' },
  { model: 'aura-2-hyperion-en', name: 'Hyperion' },
  { model: 'aura-2-iris-en', name: 'Iris' },
  { model: 'aura-2-janus-en', name: 'Janus' },
  { model: 'aura-2-juno-en', name: 'Juno' },
  { model: 'aura-2-jupiter-en', name: 'Jupiter' },
  { model: 'aura-2-luna-en', name: 'Luna' },
  { model: 'aura-2-mars-en', name: 'Mars' },
  { model: 'aura-2-minerva-en', name: 'Minerva' },
  { model: 'aura-2-neptune-en', name: 'Neptune' },
  { model: 'aura-2-odysseus-en', name: 'Odysseus' },
  { model: 'aura-2-ophelia-en', name: 'Ophelia' },
  { model: 'aura-2-orion-en', name: 'Orion' },
  { model: 'aura-2-orpheus-en', name: 'Orpheus' },
  { model: 'aura-2-pandora-en', name: 'Pandora' },
  { model: 'aura-2-phoebe-en', name: 'Phoebe' },
  { model: 'aura-2-pluto-en', name: 'Pluto' },
  { model: 'aura-2-saturn-en', name: 'Saturn' },
  { model: 'aura-2-selene-en', name: 'Selene' },
  { model: 'aura-2-theia-en', name: 'Theia' },
  { model: 'aura-2-vesta-en', name: 'Vesta' },
  { model: 'aura-2-zeus-en', name: 'Zeus' },
];

export const DEFAULT_DEEPGRAM_TTS_MODEL = 'aura-2-thalia-en';

// Deepgram rejects speed values outside this range with a 400 for Aura-2
// voices, even though it isn't documented anywhere but the error message.
export const DEEPGRAM_TTS_SPEED_MIN = 0.7;
export const DEEPGRAM_TTS_SPEED_MAX = 1.5;
export const DEFAULT_DEEPGRAM_TTS_SPEED = 1;

export function isKnownDeepgramVoiceModel(model: string): boolean {
  return DEEPGRAM_AURA2_ENGLISH_VOICES.some((voice) => voice.model === model);
}
