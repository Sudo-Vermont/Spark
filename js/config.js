// ── Spark Configuration ──
// Coaching and music sharing run 100% locally. Accounts (sign-in, friends,
// messages) need a free Supabase project — paste its URL and anon key below.
// The anon key is designed to be public: all data access is enforced
// server-side by Row Level Security policies (see supabase/schema.sql).
// Until these are filled in, the app works exactly as before, just without accounts.
const SPARK_CONFIG = {
  supabaseUrl: '',     // e.g. 'https://abcdefgh.supabase.co'
  supabaseAnonKey: ''  // Settings → API → anon public key
};
