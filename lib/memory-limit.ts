export const MEMORY_MAX_CHARS = 3000;
export const MEMORY_LIMIT_ERROR = 'Pinned context exceeds 3000 characters. Read it with optbot_read_state({"target":"memory"}), condense it, then use optbot_update_state({"target":"memory","action":"overwrite","content":"...","expectedSha256":"<sha256 from read>"}). The replacement must be at most 3000 characters. Conversation history is separate and must not be erased.';
export function validateMemory(content: string) {
  if (content.length > MEMORY_MAX_CHARS) throw new Error(MEMORY_LIMIT_ERROR);
  return content;
}
