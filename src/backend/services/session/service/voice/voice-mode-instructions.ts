/**
 * Appended as an extra content block to voice-flagged prompts so replies stay
 * short enough to follow when spoken aloud. Never persisted to the transcript —
 * see chat-message-handlers.service.ts's buildMessageContent.
 */
export const VOICE_MODE_BREVITY_INSTRUCTION =
  'The user is speaking to you by voice and will hear this reply read aloud via text-to-speech, ' +
  'not read it on screen. Keep the reply to 2-4 short sentences for a straightforward answer. ' +
  'Avoid headers, bullet/numbered lists, tables, and code blocks unless the content genuinely ' +
  "can't be conveyed without them — describe steps in flowing prose instead.";
