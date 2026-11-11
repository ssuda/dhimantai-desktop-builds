// Public client configuration only (Supabase anon keys are designed to ship in clients).
// Generated from the repo env.*.json files; never add LIVEKIT_TOKEN_SECRET or other secrets here.
export type EnvironmentName = "production" | "staging" | "development" | "local";

export interface Environment {
  apiUrl: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
}

export const ENVIRONMENTS: Record<EnvironmentName, Environment> = {
  "production": {
    "apiUrl": "https://api-prod.dhimant.ai",
    "supabaseUrl": "https://xcqnciarlrybztcacsev.supabase.co",
    "supabaseAnonKey": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhjcW5jaWFybHJ5Ynp0Y2Fjc2V2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMwMjUzNDEsImV4cCI6MjA5ODYwMTM0MX0.hYM51PPaq2oGFIfSSWfodvC66waDVGG4O0_BuPlVpj0"
  },
  "staging": {
    "apiUrl": "https://api-staging.dhimant.ai",
    "supabaseUrl": "https://db.vidyai.in",
    "supabaseAnonKey": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBrYWttZ3B3YWtzb3Vjd2F5bWxtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTI2NjcwMDcsImV4cCI6MjA2ODI0MzAwN30.7o6WiziQxB44OdYWzE0WR_z_AbtEumAt3JtF17b5e14"
  },
  "development": {
    "apiUrl": "https://api-dev.vidyai.in",
    "supabaseUrl": "https://db.vidyai.in",
    "supabaseAnonKey": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBrYWttZ3B3YWtzb3Vjd2F5bWxtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTI2NjcwMDcsImV4cCI6MjA2ODI0MzAwN30.7o6WiziQxB44OdYWzE0WR_z_AbtEumAt3JtF17b5e14"
  },
  "local": {
    "apiUrl": "http://127.0.0.1:8082",
    "supabaseUrl": "https://db.vidyai.in",
    "supabaseAnonKey": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBrYWttZ3B3YWtzb3Vjd2F5bWxtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTI2NjcwMDcsImV4cCI6MjA2ODI0MzAwN30.7o6WiziQxB44OdYWzE0WR_z_AbtEumAt3JtF17b5e14"
  }
};
