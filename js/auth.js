/**
 * auth.js
 * ---------------------------------------------------------------------------
 * The app's Authentication Service — every page's ONLY entry point for
 * signing in, signing out, and checking who's logged in as what. Pages and
 * other scripts call the functions listed under "Exposes" below and never
 * touch supabaseClient or Code.gs directly for auth purposes; that
 * indirection is what makes it possible to swap the underlying provider
 * later without touching any page, route guard, or business logic — only
 * this file's internals would change.
 *
 * Current provider: Supabase Auth (supabaseClient, from supabase-client.js)
 * verifies the password; this file never persists one anywhere itself.
 * Role/authorization data (which of Managers/HRBPs/OD/Admins an account
 * belongs to) lives in Supabase Postgres, read through Code.gs (google.js)
 * using the session's own access token — see resolveAccountRole() in both
 * google.js and apps-script/Code.gs.
 *
 * TEMPORARY: while CONFIG.DEV_MODE_DEFAULT_PASSWORD_AUTH is true (see
 * js/config.js), loginWithPassword() takes a second path — a shared
 * default password checked against a snapshot of the real employee list
 * (js/dev-auth-provider.js, js/dev-employee-directory.js) — instead of
 * calling Supabase at all. Both paths return the exact same shape, so
 * this function's own contract, and everything downstream of it (session
 * storage, route guards, redirects), doesn't know or care which one ran.
 *
 * Sign-in is single-stage: the form collects email + password together,
 * and loginWithPassword() authenticates with Supabase FIRST. A valid
 * session is proof the password was correct; only then is the account's
 * role looked up to decide where to send them and what to store in
 * sessionStorage. There is no self-service account creation or password
 * reset anywhere in this app — only the Admin Panel can create accounts or
 * set/change a password (see apps-script/Code.gs's adminCreateEmployee /
 * adminUpdateEmployee).
 *
 * Session state is kept in sessionStorage under "email", "role",
 * "loggedIn". The password is NEVER stored in sessionStorage or
 * localStorage — Supabase's own session token is kept in sessionStorage
 * too (configured in supabase-client.js), but that token is not a
 * password.
 *
 * Exposes:
 *   - validateEmail(email)
 *   - validatePassword(password)
 *   - loginWithPassword(email, password)
 *   - logout()
 *   - getCurrentUser()
 *   - getCurrentRole()
 *   - redirectByRole(role)
 * ---------------------------------------------------------------------------
 */

// Maps each PRIMARY role to its dashboard. Every account's primary role is
// one of Manager/HRBP/OD — this is what Sign In redirects to, always, even
// for an account that also has Admin permission (see loginWithPassword()'s
// isAdmin handling). "Admin" is kept here only as a landing target for the
// (temporary, dev-mode) case of an account with no primary role at all;
// see js/dev-auth-provider.js and guardPage("Admin") in app.js for how
// Admin Panel access itself is actually gated (a permission check, not a
// role match).
const ROLE_REDIRECT_MAP = {
  Manager: "manager.html",
  HRBP: "hrbp.html",
  OD: "od.html",
  Admin: "admin.html",
};

// sessionStorage keys, centralized so they're never mistyped elsewhere.
const SESSION_KEYS = {
  EMAIL: "email",
  ROLE: "role",
  LOGGED_IN: "loggedIn",
  IS_ADMIN: "isAdmin",
};

/**
 * Validates that a string is a plausible, well-formed email address. This
 * is a format check only — it does NOT verify the email has an account.
 *
 * @param {string} email
 * @returns {boolean}
 */
function validateEmail(email) {
  if (!email || typeof email !== "string") return false;

  // Standard, pragmatic email format check (not fully RFC 5322, but
  // sufficient for validating human-entered company email addresses).
  const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return EMAIL_REGEX.test(email.trim());
}

/**
 * Validates that a password was actually entered. Just an emptiness check
 * — the real rule-check happens server-side when an Admin sets a password
 * (see checkPasswordRules() / Code.gs's checkPasswordRulesServer()), not
 * at Sign In.
 *
 * @param {string} password
 * @returns {boolean}
 */
function validatePassword(password) {
  return typeof password === "string" && password.length > 0;
}

/**
 * Creates an Error tagged with which form field it relates to, so the UI
 * layer can show the message under the right input instead of a generic
 * banner. Sign In's own errors are deliberately untagged (field: null) —
 * see loginWithPassword() — so they render as a general banner instead of
 * hinting which of email/password was wrong.
 *
 * @param {string} message
 * @param {"email" | "password" | null} field
 * @returns {Error}
 */
function createAuthError(message, field) {
  const error = new Error(message);
  error.field = field || null;
  return error;
}

/**
 * Throws a clear, on-page error if Supabase isn't configured yet, instead
 * of letting a raw "supabaseClient is null" TypeError reach the user.
 * Call this first in any function that's about to use supabaseClient.
 *
 * @throws {Error} untagged (shown in the generic error banner).
 */
function requireSupabase() {
  if (!supabaseClient) {
    throw createAuthError(
      supabaseConfigError || "Authentication is not configured yet.",
      null
    );
  }
}

/**
 * Verifies the given credentials (via whichever provider is active — see
 * the file header) and, on success, starts the session with the resolved
 * role. Both failure cases use a generic, untagged message rather than
 * pointing at email vs. password specifically.
 *
 * @param {string} email
 * @param {string} password
 * @returns {Promise<string>} the authenticated user's role.
 * @throws {Error} untagged (field: null) — always shown as a general
 *   banner, never attributed to a specific field.
 */
async function loginWithPassword(email, password) {
  const trimmedEmail = String(email || "").trim();

  if (!validateEmail(trimmedEmail)) {
    throw createAuthError("Please enter a valid email address.", null);
  }
  if (!validatePassword(password)) {
    throw createAuthError("Please enter your password.", null);
  }

  // TEMPORARY branch — see the file header and js/dev-auth-provider.js.
  // Both branches resolve to the exact same {authorized, role, notFound}
  // shape, so everything below this point is provider-agnostic.
  const result = CONFIG.DEV_MODE_DEFAULT_PASSWORD_AUTH
    ? devDirectoryLogin(trimmedEmail, password)
    : await supabaseLogin(trimmedEmail, password);

  if (result.notFound) {
    throw createAuthError("This account does not exist.", null);
  }
  if (!result.authorized) {
    throw createAuthError("Invalid email or password.", null);
  }

  sessionStorage.setItem(SESSION_KEYS.EMAIL, trimmedEmail);
  sessionStorage.setItem(SESSION_KEYS.ROLE, result.role);
  sessionStorage.setItem(SESSION_KEYS.LOGGED_IN, "true");
  // Admin permission is orthogonal to the primary role above — it only
  // controls whether the Admin Panel button/route is available, never the
  // post-login landing page. See redirectByRole() and guardPage("Admin").
  sessionStorage.setItem(SESSION_KEYS.IS_ADMIN, result.isAdmin ? "true" : "false");

  return result.role;
}

/**
 * The real (non-temporary) credential check: Supabase Auth verifies the
 * password, then resolveAccountRole() (google.js / Code.gs) looks up the
 * account's role using the resulting session token. Supabase deliberately
 * doesn't distinguish "wrong password" from "no such account" (avoids
 * confirming which emails exist), so this doesn't set notFound on a failed
 * sign-in — only on a successful sign-in for an account that turns out to
 * have no matching row anywhere (see resolveAccountRole()'s own doc comment).
 *
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{authorized: boolean, role?: string, isAdmin?: boolean, notFound?: boolean}>}
 */
async function supabaseLogin(email, password) {
  requireSupabase();

  const { data: signInData, error: signInError } = await supabaseClient.auth.signInWithPassword({
    email,
    password,
  });

  if (signInError) {
    return { authorized: false };
  }

  const accessToken = signInData && signInData.session ? signInData.session.access_token : null;
  const result = await resolveAccountRole(accessToken);

  if (!result.authorized) {
    await supabaseClient.auth.signOut();
    return { authorized: false, notFound: true };
  }

  // TODO (backend phase): resolveAccountRole() will need to return isAdmin
  // as its own field once the real users table has an is_admin column —
  // same orthogonal-permission shape the mock layer already uses. Defaults
  // to false here rather than inferring it from role, so this path never
  // silently grants Admin Panel access.
  return { authorized: true, role: result.role, isAdmin: !!result.isAdmin };
}

/**
 * Clears the current session (both this app's sessionStorage flags and
 * the underlying Supabase session) and returns the user to the login page.
 */
async function logout() {
  sessionStorage.removeItem(SESSION_KEYS.EMAIL);
  sessionStorage.removeItem(SESSION_KEYS.ROLE);
  sessionStorage.removeItem(SESSION_KEYS.LOGGED_IN);
  sessionStorage.removeItem(SESSION_KEYS.IS_ADMIN);

  if (supabaseClient) {
    await supabaseClient.auth.signOut();
  }

  window.location.href = "index.html";
}

/**
 * @returns {string | null} the logged-in user's email, or null if no
 *   active session exists.
 */
function getCurrentUser() {
  const isLoggedIn = sessionStorage.getItem(SESSION_KEYS.LOGGED_IN) === "true";
  return isLoggedIn ? sessionStorage.getItem(SESSION_KEYS.EMAIL) : null;
}

/**
 * @returns {string | null} the logged-in user's role, or null if no
 *   active session exists.
 */
function getCurrentRole() {
  const isLoggedIn = sessionStorage.getItem(SESSION_KEYS.LOGGED_IN) === "true";
  return isLoggedIn ? sessionStorage.getItem(SESSION_KEYS.ROLE) : null;
}

/**
 * Whether the signed-in user also holds Admin permission — orthogonal to
 * their primary role (see loginWithPassword()). Used to show/hide the
 * Admin Panel button on Manager/HRBP/OD dashboards and to gate admin.html
 * itself in guardPage("Admin") (app.js), instead of requiring role
 * === "Admin" the way a single-role account model would.
 *
 * @returns {boolean}
 */
function getIsAdmin() {
  const isLoggedIn = sessionStorage.getItem(SESSION_KEYS.LOGGED_IN) === "true";
  return isLoggedIn && sessionStorage.getItem(SESSION_KEYS.IS_ADMIN) === "true";
}

/**
 * Redirects the browser to the page that matches the given role.
 *
 * @param {string} role - "Manager" | "HRBP" | "OD" | "Admin"
 */
function redirectByRole(role) {
  const targetPage = ROLE_REDIRECT_MAP[role];

  if (!targetPage) {
    console.error(`Unknown role "${role}" — cannot redirect.`);
    return;
  }

  window.location.href = targetPage;
}
