// Student sign-in identity, matching the app (lib/shared/auth/presentation/student_login_screen.dart):
// institute code + roll number map to a Supabase email; the legacy dot format is tried second.

/** Current format: lowercased, letters and digits only, `<roll>_<code>@vidyai.in`. */
export function studentEmail(instituteCode: string, rollNumber: string): string | undefined {
  const clean = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  const roll = clean(rollNumber);
  const code = clean(instituteCode);
  return roll && code ? `${roll}_${code}@vidyai.in` : undefined;
}

/** Legacy accounts: lowercased as typed (punctuation kept), `<roll>.<code>@vidyai.in`. */
export function legacyStudentEmail(instituteCode: string, rollNumber: string): string {
  return `${rollNumber.trim().toLowerCase()}.${instituteCode.trim().toLowerCase()}@vidyai.in`;
}

/** Same rule as the app: any letter or digit is enough; sign-in imposes no new format rules. */
export function checkStudentIdentifier(value: string, label: string): string | undefined {
  if (!value.trim()) return `Enter your ${label}.`;
  return /[a-zA-Z0-9]/.test(value) ? undefined : `Enter a valid ${label}.`;
}

export const STUDENT_SIGN_IN_FAILED = "We couldn't sign you in. Check your institute code, roll number and password.";

export function isNetworkError(message: string): boolean {
  return /internet|network|connection|fetch failed|timed? ?out|abort/i.test(message);
}
