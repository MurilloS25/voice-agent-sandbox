/**
 * What the API accepts as a chat message. Kept apart from `api/client.ts` (which is server-only)
 * so the chat and the server share one definition.
 */
export const MAX_MESSAGE_LENGTH = 500;
/** The API ends a conversation after this many turns. */
export const MAX_TURN_INDEX = 30;

/** Control characters other than a newline, which the API refuses. */
function hasControlCharacters(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if ((code < 32 && code !== 10) || code === 127) return true;
  }
  return false;
}

/** The message as the API will normalize it: trimmed, 1 to 500 characters, no control characters. */
export function normalizeMessage(message: string): string | undefined {
  const text = message.trim();
  if (text.length === 0 || text.length > MAX_MESSAGE_LENGTH) return undefined;
  return hasControlCharacters(text) ? undefined : text;
}
