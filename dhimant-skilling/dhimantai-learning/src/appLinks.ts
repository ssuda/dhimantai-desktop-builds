import type { EnvironmentName } from './environments';

export const WEB_APP_ORIGINS: Record<EnvironmentName, string | undefined> = {
  production: 'https://app.dhimant.ai', staging: 'https://app-staging.dhimant.ai',
  development: 'https://app-dev.dhimant.ai', local: undefined,
};

/** The app owns student profile completion and institute approval. Never include credentials. */
export function studentSignupUrl(environment: EnvironmentName): string | undefined {
  const origin = WEB_APP_ORIGINS[environment];
  return origin ? `${origin}/#/student-signup` : undefined;
}
