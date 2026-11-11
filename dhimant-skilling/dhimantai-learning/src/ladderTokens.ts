// Signed proof of the help already given, per exercise. Only the server can extend a token; it stores nothing,
// so losing one (a restart, a deleted file) only returns the learner to a hint.
const tokens = new Map<string, string>();

export function ladderToken(key: string): string | undefined {
  return tokens.get(key);
}

export function rememberLadderToken(key: string, token: string | null | undefined) {
  if (token) tokens.set(key, token); else tokens.delete(key);
}
