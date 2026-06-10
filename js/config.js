// ── Spark Configuration ──
// All coaching runs 100% locally — no API keys needed for the core app.
//
// SPOTIFY "NOW PLAYING" SYNC (optional)
// To show what you and your partner are listening to:
//   1. Go to developer.spotify.com/dashboard and create a free app
//   2. In your app settings add this Redirect URI:
//        https://sudo-vermont.github.io/Spark/
//   3. Copy your Client ID and paste it below
const SPARK_CONFIG = {
  spotifyClientId: '', // e.g. 'a1b2c3d4e5f6...'
};
