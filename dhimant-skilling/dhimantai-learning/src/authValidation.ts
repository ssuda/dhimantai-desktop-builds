/** Shared by the account form and its host; passwords are never trimmed. */
export function authInputErrors(input: {name?: unknown; email?: unknown; password?: unknown; confirmation?: unknown}, signup: boolean): Record<string, string> {
  const errors: Record<string, string> = {};
  if (signup && (typeof input.name !== 'string' || input.name.trim().length < 2 || input.name.trim().length > 100))
    errors.name = 'Enter a name between 2 and 100 characters.';
  if (typeof input.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim()))
    errors.email = 'Enter a valid email address, such as name@example.com.';
  if (typeof input.password !== 'string' || !input.password)
    errors.password = 'Enter your password.';
  else if (signup && input.password.length < 8)
    errors.password = 'Use at least 8 characters for your password.';
  if (signup && (!input.confirmation || input.confirmation !== input.password))
    errors.confirmation = 'Enter the same password in both password fields.';
  return errors;
}

export function authErrorMessage(error: unknown): string {
  const code = (error as {code?: string})?.code;
  if (code === 'invalid_credentials') return 'Email or password is incorrect. Check both and try again.';
  if (code === 'email_not_confirmed') return 'Confirm your email using the link in your inbox, then sign in.';
  if (code === 'user_already_exists' || code === 'email_exists') return 'An account already uses this email. Sign in with your existing password.';
  if (code === 'over_request_rate_limit' || code === 'over_email_send_rate_limit') return 'Too many attempts. Wait a few minutes, then try again.';
  if (error instanceof TypeError) return 'Could not connect. Check your internet connection and try again.';
  if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) return 'The request timed out. Please try again.';
  return error instanceof Error ? error.message : 'Could not sign in. Please try again.';
}
