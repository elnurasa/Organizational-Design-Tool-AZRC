/**
 * supabase-client.js
 * ---------------------------------------------------------------------------
 * Creates the single shared Supabase client used for authentication
 * (sign-in, session management). Every page that needs a session loads the
 * Supabase UMD library from a CDN, then this file, before auth.js.
 *
 * Requires this in the page's <head>/<body>, in this order:
 *   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
 *   <script src="js/config.js"></script>
 *   <script src="js/supabase-client.js"></script>
 *
 * The CDN script exposes a global `supabase` object with `.createClient`.
 * The client instance created here is stored as `supabaseClient` instead
 * (not `supabase`) so it doesn't shadow that global.
 *
 * Storage choice: Supabase's session (access/refresh tokens) is kept in
 * sessionStorage rather than the default localStorage, so a Supabase
 * session ends when the browser tab closes — consistent with the rest
 * of this app's session model (see auth.js). This is the session TOKEN,
 * not a password; storing it is how Supabase Auth is meant to work.
 *
 * Unconfigured-Supabase handling: `supabaseClient` is always declared
 * (as `null` if config is missing), never left in a temporal-dead-zone
 * state. Classic <script> tags share one global scope for `const`/`let`,
 * so a top-level `throw` before a `const` declaration would otherwise
 * poison that name for every OTHER script on the page too, turning a
 * clear "config missing" message into a confusing "supabaseClient is
 * not defined" error anywhere it's referenced. auth.js checks
 * `supabaseClient`/`supabaseConfigError` itself before using it.
 * ---------------------------------------------------------------------------
 */

let supabaseClient = null;
let supabaseConfigError = null;

if (
  !CONFIG.SUPABASE_URL ||
  CONFIG.SUPABASE_URL.startsWith("PASTE_") ||
  !CONFIG.SUPABASE_ANON_KEY ||
  CONFIG.SUPABASE_ANON_KEY.startsWith("PASTE_")
) {
  supabaseConfigError =
    "Authentication is not configured yet. Update SUPABASE_URL and SUPABASE_ANON_KEY in js/config.js.";
  console.error(supabaseConfigError);
} else {
  supabaseClient = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
    auth: {
      storage: window.sessionStorage,
      persistSession: true,
      autoRefreshToken: true,
    },
  });
}
