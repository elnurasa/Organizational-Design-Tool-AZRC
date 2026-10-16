/**
 * config.js
 * ---------------------------------------------------------------------------
 * Central configuration file for the Organizational Design Tool.
 *
 * This is the ONLY file you should need to edit with your own project
 * values (Google Apps Script URL, Supabase credentials).
 *
 * Supabase Auth verifies passwords and issues sessions; Supabase Postgres
 * (read/written through the Apps Script Web App at GOOGLE_SCRIPT_URL) holds
 * who's allowed in and what role they have. See js/auth.js for how sign-in
 * combines the two.
 * -------------------------------------------------------------------------
 */

const CONFIG = {
  // -------------------------------------------------------------------------
  // Google Apps Script Web App URL.
  // This is the deployed "exec" URL you get after publishing the Apps
  // Script as a Web App (see README / setup guide, Step 4-6).
  // Example: "https://script.google.com/macros/s/AKfycb.../exec"
  // -------------------------------------------------------------------------
  GOOGLE_SCRIPT_URL: "https://script.google.com/macros/s/AKfycbw-CNzbL8ipYqJibYMvfiv2aINX65e_CzIL3D6eAOnSREtO1BbNhoLd4a6uzT5CPWIB/exec",

  // -------------------------------------------------------------------------
  // Supabase project credentials — Project Settings > API in your
  // Supabase dashboard. The anon/public key is safe to ship to the
  // browser (it has no special privileges by itself); never put a
  // service_role key in this file.
  //
  // These same two values also need to be pasted into
  // apps-script/Code.gs (SUPABASE_URL / SUPABASE_ANON_KEY near the top)
  // — Apps Script runs on Google's servers, not in this browser bundle,
  // so it can't read this file. Code.gs uses them to verify a caller's
  // Supabase access token server-side before returning account data.
  // -------------------------------------------------------------------------
  SUPABASE_URL: "https://mkgkbqjvywhiginhjyjn.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1rZ2ticWp2eXdoaWdpbmhqeWpuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU0OTU5NTcsImV4cCI6MjEwMTA3MTk1N30.bbgpjDQRMKm77L9EKn9u_0531oZWiQfrnS556sWDjGU",

  // =========================================================================
  // RETIRED. When true, Sign In skipped Supabase Auth and checked the email
  // against a static real-employee snapshot with one shared password
  // (js/dev-employee-directory.js, js/dev-auth-provider.js) — used before
  // any Supabase Auth accounts existed. Those two files (and js/mock-data.js,
  // the in-memory store they and the rest of the app read from during that
  // same phase) have been deleted now that Supabase is the real backend;
  // js/auth.js's loginWithPassword() always takes the real Supabase Auth
  // path (supabaseLogin()) below. Left as `false` rather than removed so
  // the seam that made this swap possible in the first place stays visible.
  // =========================================================================
  DEV_MODE_DEFAULT_PASSWORD_AUTH: false,
};

// Freeze so the config object cannot be accidentally mutated at runtime.
Object.freeze(CONFIG);
