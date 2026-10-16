/**
 * Code.gs
 * ---------------------------------------------------------------------------
 * Google Apps Script Web App — Authorization + Admin Panel backend for the
 * Organizational Design Tool.
 *
 * DATA SOURCE: every account (Manager/HRBP/OD) lives in one Supabase
 * Postgres table, "users" (see supabase/migrations/0003_unify_users_and_
 * requests.sql), keyed by auth.users.id directly (users.id IS the Supabase
 * Auth user id — no separate join column). This script is the only thing on
 * Earth allowed to WRITE to "users" or to Supabase Auth: it holds the
 * Supabase service_role key (via Script Properties, never in source) and
 * every mutation goes through here after verifying the caller is an Admin.
 *
 * The Structural Change Request workflow (requests / request_answers /
 * request_history) is NOT handled here — those writes need no elevated
 * privilege (no Supabase Auth involvement), so the browser calls Postgres
 * functions directly via supabase-js .rpc() under Row Level Security (see
 * js/request-service.js and supabase/migrations/0004_request_workflow_
 * rpcs.sql). This script's scope is exactly: sign-in role resolution, and
 * Admin Panel user CRUD.
 *
 * AUTHENTICATION ARCHITECTURE (passwords live in Supabase Auth, NOT here):
 *
 * This script never receives, stores, or compares a raw password — Admin
 * Panel writes hand a password straight through to Supabase Auth's Admin API
 * (GoTrue), which hashes it. Nothing in the app database ever holds a
 * password or a hash.
 *
 * SERVER-SIDE VERIFICATION: this Web App is deployed with "Anyone" access,
 * so a caller's email/role/id can never be trusted just because they claim
 * it. EVERY endpoint requires an `access_token` (a Supabase session access
 * token, obtained from a successful supabaseClient.auth.signInWithPassword()
 * — see js/auth.js); getVerifiedUser() confirms it server-side with Supabase
 * itself (GET {SUPABASE_URL}/auth/v1/user) before doing anything, and every
 * admin-* action additionally confirms the verified user has an
 * admin_permissions row (requireAdmin()) — never trusts a role/isAdmin flag
 * the client sends.
 *
 * REQUIRED SCRIPT PROPERTIES (Project Settings -> Script Properties — never
 * hardcode these, unlike the anon key below, since they grant full database
 * and Auth admin access):
 *   SUPABASE_SERVICE_ROLE_KEY  - Project Settings > API > service_role key.
 *   BOOTSTRAP_KEY               - a one-time secret you choose, used once to
 *                                  seed the first Admin(s) via bootstrapAdmin.
 *                                  Delete this property after using it.
 *
 * Deployed as a Web App (Deploy > New deployment > Web app):
 *
 * doGet():
 *   - ?resolveRole=1&access_token=... -> the verified caller's PRIMARY role
 *     plus their Admin permission as a separate flag — Admin never overrides
 *     the primary role (see resolveAccountRole()). A deactivated
 *     (is_active = false) account is treated as unauthorized:
 *       { "authorized": true, "role": "Manager" | "HRBP" | "OD" | "Admin", "isAdmin": boolean }
 *       { "authorized": false }
 *     ("Admin" is only ever the role itself for an account with Admin
 *     permission and no Manager/HRBP/OD row at all — see resolveAccountRole().)
 *
 * doPost() actions (all require the caller to be an Admin, except
 * bootstrapAdmin):
 *   - adminCreateEmployee { role, full_name, job_title, email, password,
 *                           company?, division?, department?, subdepartment?,
 *                           unit?, subunit?, access_token }
 *   - adminUpdateEmployee { role, id, full_name?, job_title?, email?,
 *                           password?, company?, division?, department?,
 *                           subdepartment?, unit?, subunit?, access_token }
 *   - adminDeleteEmployee { role, id, access_token }
 *   - adminSetPermission  { auth_user_id, is_admin, access_token }
 *   - adminSetActive      { role, id, is_active, access_token }
 *   - bootstrapAdmin      { bootstrap_key, employees: [ { role, full_name,
 *                           job_title, email, password, ... } ] }
 *     — one-time seed path, gated by BOOTSTRAP_KEY instead of an admin
 *     session (there is no admin yet). Refuses to run twice.
 * ---------------------------------------------------------------------------
 */

// Same Supabase project this app's js/config.js points at (SUPABASE_URL /
// SUPABASE_ANON_KEY). The anon/public key is safe here for the same reason
// it's safe in a browser bundle: Supabase designs it to be publishable and
// non-secret. Used only to verify a caller's access token server-side — see
// getVerifiedUser(). Never put the service_role key here — it lives in
// Script Properties instead (see getServiceRoleKey()).
const SUPABASE_URL = "https://mkgkbqjvywhiginhjyjn.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1rZ2ticWp2eXdoaWdpbmhqeWpuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU0OTU5NTcsImV4cCI6MjEwMTA3MTk1N30.bbgpjDQRMKm77L9EKn9u_0531oZWiQfrnS556sWDjGU";

/**
 * Generates this employee's starting password from their own full_name,
 * so every newly created account (any role, via handleAdminCreateEmployee
 * or handleBootstrapAdmin — the Admin Panel's Create form no longer collects
 * a password) gets a password unique to them instead of one shared default.
 * It's only ever the STARTING password: Supabase Auth hashes and stores it
 * exactly like any other password (never written anywhere in plaintext by
 * this app), and an Admin can overwrite it per-account at any time via Edit,
 * which immediately invalidates it for that account. Only used when the
 * caller supplies no password at all.
 *
 * Rule: first letter of each of the first three whitespace-separated name
 * parts, uppercased, + "_123!" — e.g. "Abbasova Irina Vladimirovna" (the
 * existing full_name convention throughout this app is surname first, given
 * name, then father's/patronymic name) -> "AIV_123!". The schema has no
 * separate first/last/father-name columns (see supabase/migrations/0003 —
 * only one full_name field exists), so this parses that one field rather
 * than relying on structured fields that don't exist. Parenthetical asides
 * some employees' names carry (e.g. "Islamova (ex. Allahverdiyeva) Ulviyya
 * Vahid" for a former/maiden name) are stripped first so they never end up
 * contributing an initial. Falls back to fewer initials if fewer than three
 * name parts are present — never zero, since full_name is already required/
 * non-empty by validateEmployeeInput() before this is ever called.
 *
 * @param {string} fullName
 * @returns {string}
 */
function generateDefaultPassword(fullName) {
  const withoutParens = String(fullName || "").replace(/\([^)]*\)/g, " ");
  const nameParts = withoutParens.split(/\s+/).filter(Boolean).slice(0, 3);
  const initials = nameParts.map((part) => part.charAt(0).toUpperCase()).join("");
  return initials + "_123!";
}

// Role name (as used throughout the client/session, e.g. sessionStorage,
// guardPage()) <-> the value stored in users.role. Kept as an explicit
// mapping at this one boundary rather than changing the client's role
// vocabulary, so nothing outside this file needs to know the DB uses
// lowercase/underscored values.
const ROLE_TO_DB = { Manager: "manager", HRBP: "hrbp", OD: "od_team" };
const DB_TO_ROLE = { manager: "Manager", hrbp: "HRBP", od_team: "OD" };
const ROLE_NAMES = Object.keys(ROLE_TO_DB);

// Extra fields accepted from the client beyond the shared full_name/
// job_title/email/company, whitelisted per role so a caller can never write
// an unexpected column just by naming it in the request body.
const ROLE_EXTRA_FIELDS = {
  Manager: ["division", "department", "subdepartment", "unit", "subunit"],
  HRBP: [],
  OD: [],
};

// Extra fields that are REQUIRED (beyond full_name/job_title/email, which
// are always required) for each role.
const ROLE_REQUIRED_EXTRA_FIELDS = {
  Manager: ["division", "department"],
  HRBP: [],
  OD: [],
};

/**
 * Handles GET requests to the deployed web app URL.
 *
 * @param {GoogleAppsScript.Events.DoGet} e
 * @returns {GoogleAppsScript.Content.TextOutput}
 */
function doGet(e) {
  const params = (e && e.parameter) || {};

  if (params.resolveRole) {
    return buildJsonResponse(resolveAccountRole(params.access_token));
  }

  if (params.debugResolve) {
    return buildJsonResponse(debugResolveAccountRole(params.access_token));
  }

  return buildJsonResponse({ status: "error", message: "Unknown request." });
}

/**
 * TEMPORARY diagnostic twin of resolveAccountRole() — returns non-sensitive
 * structural facts about each step (found/not found, counts, raw role
 * string) instead of just the final authorized/role/isAdmin answer, to
 * debug why a real account isn't resolving as expected. Safe to call
 * unauthenticated (reveals no emails, ids, or secrets) but should be
 * removed once the bootstrap issue is confirmed fixed.
 *
 * @param {string | undefined} accessToken
 */
function debugResolveAccountRole(accessToken) {
  const verifiedUser = getVerifiedUser(accessToken);
  if (!verifiedUser) {
    return Object.assign({ step: "getVerifiedUser", verified: false }, debugGetVerifiedUser(accessToken));
  }

  const adminRows = restGet(
    "admin_permissions",
    "auth_user_id=eq." + encodeURIComponent(verifiedUser.id) + "&select=is_admin&limit=1"
  );
  const userRows = restGet(
    "users",
    "id=eq." + encodeURIComponent(verifiedUser.id) + "&select=role,is_active&limit=1"
  );

  return {
    verified: true,
    adminRowsFound: adminRows ? adminRows.length : null,
    isAdminRaw: adminRows && adminRows.length > 0 ? adminRows[0].is_admin : null,
    userRowsFound: userRows ? userRows.length : null,
    userRoleRaw: userRows && userRows.length > 0 ? userRows[0].role : null,
    userIsActiveRaw: userRows && userRows.length > 0 ? userRows[0].is_active : null,
    roleMapsToKnownRole: userRows && userRows.length > 0 ? !!DB_TO_ROLE[userRows[0].role] : null,
  };
}

/**
 * Handles POST requests. Dispatches on body.action.
 *
 * @param {GoogleAppsScript.Events.DoPost} e
 * @returns {GoogleAppsScript.Content.TextOutput}
 */
function doPost(e) {
  let body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
  } catch (parseError) {
    return buildJsonResponse({ status: "error", message: "Invalid request body." });
  }

  switch (body.action) {
    case "adminCreateEmployee":
      return buildJsonResponse(handleAdminCreateEmployee(body));
    case "adminUpdateEmployee":
      return buildJsonResponse(handleAdminUpdateEmployee(body));
    case "adminDeleteEmployee":
      return buildJsonResponse(handleAdminDeleteEmployee(body));
    case "adminSetPermission":
      return buildJsonResponse(handleAdminSetPermission(body));
    case "adminSetActive":
      return buildJsonResponse(handleAdminSetActive(body));
    case "bootstrapAdmin":
      return buildJsonResponse(handleBootstrapAdmin(body));
    default:
      return buildJsonResponse({ status: "error", message: "Unknown action." });
  }
}

// =============================================================================
// Auth verification
// =============================================================================

/**
 * Verifies a Supabase access token server-side by asking Supabase itself who
 * it belongs to, rather than trusting any email/id the caller claims. Fails
 * closed (returns null) on a missing token, missing config, an invalid/
 * expired token, or any network error.
 *
 * @param {string | undefined} accessToken
 * @returns {{email: string, id: string} | null}
 */
function getVerifiedUser(accessToken) {
  if (!accessToken) return null;
  if (!isConfigured(SUPABASE_URL)) return null;

  try {
    const response = UrlFetchApp.fetch(SUPABASE_URL.replace(/\/+$/, "") + "/auth/v1/user", {
      method: "get",
      headers: {
        Authorization: "Bearer " + accessToken,
        // Uses the service_role key (not the public anon key) as the apikey
        // header — Supabase's gateway was rejecting this endpoint's calls
        // from Apps Script's server with the anon key specifically ("Invalid
        // API key") even though the same key works fine called directly and
        // the service_role key already works reliably from this same script
        // for every other Supabase call (see restGet/restPost below). Still
        // safe: this only ever confirms who a token belongs to, the same
        // thing the anon key would have done — no elevated action is taken
        // based on the response beyond that.
        apikey: getServiceRoleKey(),
      },
      muteHttpExceptions: true,
    });

    if (response.getResponseCode() !== 200) return null;

    const user = JSON.parse(response.getContentText());
    if (!user || !user.email || !user.id) return null;

    return { email: String(user.email).trim().toLowerCase(), id: user.id };
  } catch (error) {
    return null;
  }
}

/**
 * TEMPORARY diagnostic twin of getVerifiedUser() — reports the actual HTTP
 * status and a truncated response body from Supabase, plus basic facts
 * about the token itself (never the token value), to see exactly why
 * verification is failing. Remove once the bootstrap issue is fixed.
 *
 * @param {string | undefined} accessToken
 */
function debugGetVerifiedUser(accessToken) {
  if (!accessToken) return { tokenPresent: false };
  if (!isConfigured(SUPABASE_URL) || !isConfigured(SUPABASE_ANON_KEY)) {
    return { tokenPresent: true, configOk: false };
  }

  const base = SUPABASE_URL.replace(/\/+$/, "");
  const result = {
    tokenPresent: true,
    tokenLength: String(accessToken).length,
    anonKeyLength: SUPABASE_ANON_KEY.length,
    anonKeyPrefix: SUPABASE_ANON_KEY.slice(0, 15),
    anonKeySuffix: SUPABASE_ANON_KEY.slice(-15),
  };

  try {
    const response = UrlFetchApp.fetch(base + "/auth/v1/user", {
      method: "get",
      headers: { Authorization: "Bearer " + accessToken, apikey: SUPABASE_ANON_KEY },
      muteHttpExceptions: true,
    });
    result.headerAttempt = {
      httpCode: response.getResponseCode(),
      bodySnippet: String(response.getContentText()).slice(0, 200),
    };
  } catch (error) {
    result.headerAttempt = { fetchError: String(error) };
  }

  try {
    const response2 = UrlFetchApp.fetch(base + "/auth/v1/user?apikey=" + encodeURIComponent(SUPABASE_ANON_KEY), {
      method: "get",
      headers: { Authorization: "Bearer " + accessToken },
      muteHttpExceptions: true,
    });
    result.queryParamAttempt = {
      httpCode: response2.getResponseCode(),
      bodySnippet: String(response2.getContentText()).slice(0, 200),
    };
  } catch (error) {
    result.queryParamAttempt = { fetchError: String(error) };
  }

  try {
    const response3 = UrlFetchApp.fetch(base + "/auth/v1/user", {
      method: "get",
      headers: { Authorization: "Bearer " + accessToken, apikey: getServiceRoleKey() },
      muteHttpExceptions: true,
    });
    result.serviceRoleAttempt = {
      httpCode: response3.getResponseCode(),
      bodySnippet: String(response3.getContentText()).slice(0, 200),
    };
  } catch (error) {
    result.serviceRoleAttempt = { fetchError: String(error) };
  }

  return result;
}

/**
 * Verifies the access token AND that the resulting user has an
 * admin_permissions row with is_admin = true. This is the gate every
 * admin-* action must pass before touching any data.
 *
 * @param {string | undefined} accessToken
 * @returns {{email: string, id: string} | null} the verified admin, or null.
 */
function requireAdmin(accessToken) {
  const verifiedUser = getVerifiedUser(accessToken);
  if (!verifiedUser) return null;

  const rows = restGet("admin_permissions", "auth_user_id=eq." + encodeURIComponent(verifiedUser.id) + "&select=is_admin");
  if (!rows || rows.length === 0 || !rows[0].is_admin) return null;

  return verifiedUser;
}

function isConfigured(value) {
  return !!value && String(value).indexOf("PASTE_") !== 0;
}

function getServiceRoleKey() {
  return PropertiesService.getScriptProperties().getProperty("SUPABASE_SERVICE_ROLE_KEY");
}

function getBootstrapKey() {
  return PropertiesService.getScriptProperties().getProperty("BOOTSTRAP_KEY");
}

/**
 * Decodes a base64 string back to plain text. The browser side base64-
 * encodes email/password/bootstrap_key before sending them here — some
 * corporate network security tools inspect outgoing requests for a
 * plaintext "your own corporate email + a password" pair (a known
 * credential-phishing pattern) and block ones sent to script.google.com,
 * even though this is a legitimate first-party request. Encoding avoids
 * that false-positive block; it is not a security boundary (this endpoint
 * is only ever reached over HTTPS).
 *
 * @param {string | undefined} value
 * @returns {string | undefined}
 */
function b64Decode(value) {
  if (value === undefined || value === null || value === "") return value;
  try {
    return Utilities.newBlob(Utilities.base64Decode(String(value))).getDataAsString("UTF-8");
  } catch (e) {
    return value; // not valid base64 — pass through unchanged
  }
}

// =============================================================================
// Sign In
// =============================================================================

/**
 * Resolves the ROLE for an already-authenticated caller (a valid
 * access_token means Supabase Auth already confirmed the password —
 * this function only ever answers "what is this verified person allowed to
 * see", never "is this password correct").
 *
 * Admin permission is orthogonal to the primary role, not a replacement for
 * it: an account with both a users row AND an admin_permissions row gets
 * back its PRIMARY role (Manager/HRBP/OD) plus isAdmin: true as a separate
 * field — Admin never overrides the primary role as the post-login landing
 * page (see js/auth.js's loginWithPassword()/ROLE_REDIRECT_MAP and
 * app.js's guardPage("Admin"), which gates the Admin Panel on the isAdmin
 * flag, not on role === "Admin"). "Admin" is only ever the role itself for
 * an account with no primary Manager/HRBP/OD row at all. A deactivated
 * account (is_active = false) is treated as unauthorized, same as a non-
 * existent one — it deliberately doesn't get a distinct "deactivated"
 * message, so this endpoint can't be used to probe whether a given email is
 * a real, disabled account.
 *
 * @param {string | undefined} accessToken
 * @returns {{authorized: boolean, role?: "Admin"|"Manager"|"HRBP"|"OD", isAdmin?: boolean}}
 */
function resolveAccountRole(accessToken) {
  const verifiedUser = getVerifiedUser(accessToken);
  if (!verifiedUser) return { authorized: false };

  const adminRows = restGet(
    "admin_permissions",
    "auth_user_id=eq." + encodeURIComponent(verifiedUser.id) + "&select=is_admin&limit=1"
  );
  const isAdmin = !!(adminRows && adminRows.length > 0 && adminRows[0].is_admin);

  const userRows = restGet(
    "users",
    "id=eq." + encodeURIComponent(verifiedUser.id) + "&select=role,is_active&limit=1"
  );
  if (userRows && userRows.length > 0 && userRows[0].is_active && DB_TO_ROLE[userRows[0].role]) {
    // Admin permission is orthogonal to the primary role — it must never
    // override it as the post-login landing page (only grant the Admin
    // Panel button/route). See js/auth.js's loginWithPassword() and
    // js/app.js's guardPage("Admin"), which already expect {role, isAdmin}
    // as separate fields, not "Admin" itself as a role value.
    return { authorized: true, role: DB_TO_ROLE[userRows[0].role], isAdmin: isAdmin };
  }

  if (isAdmin) {
    // Admin permission with no primary Manager/HRBP/OD row at all (e.g. a
    // pure-Admin account, same shape as elnurasa@ in the dev-mode
    // directory) — "Admin" is the only role available to land on.
    return { authorized: true, role: "Admin", isAdmin: true };
  }

  // A real, password-verified Supabase Auth user with no active users row
  // and no admin_permissions row — e.g. deleted/deactivated from the Admin
  // Panel after their session token was issued. Deny; js/auth.js signs
  // them out.
  return { authorized: false };
}

// =============================================================================
// Admin Panel write actions
// =============================================================================

/**
 * Creates a new Manager/HRBP/OD account: a Supabase Auth user (with the
 * Admin-supplied password) plus the matching "users" row, using the same id
 * for both. If the table insert fails after the Auth user was created, the
 * Auth user is deleted again so no orphaned login is left behind.
 *
 * @param {object} body
 * @returns {{status: "success", id: string} | {status: "error", message: string}}
 */
function handleAdminCreateEmployee(body) {
  const admin = requireAdmin(body.access_token);
  if (!admin) return { status: "error", message: "Unauthorized." };

  const role = body.role;
  if (ROLE_NAMES.indexOf(role) === -1) {
    return { status: "error", message: "Unknown role." };
  }

  const decodedBody = Object.assign({}, body, {
    email: b64Decode(body.email),
    password: b64Decode(body.password) || generateDefaultPassword(body.full_name),
  });

  const validationError = validateEmployeeInput(role, decodedBody, /* passwordRequired */ true);
  if (validationError) return { status: "error", message: validationError };

  const email = String(decodedBody.email).trim().toLowerCase();

  const authResult = authAdminCreateUser(email, decodedBody.password);
  if (authResult.error) {
    return { status: "error", message: authResult.error };
  }

  const row = buildEmployeeRow(role, decodedBody, email);
  row.id = authResult.userId;
  const insertResult = restPost("users", row);

  if (insertResult.error) {
    authAdminDeleteUser(authResult.userId); // best-effort cleanup, don't leak a login with no profile
    return { status: "error", message: friendlyTableError(insertResult.error) };
  }

  return { status: "success", id: insertResult.data[0].id };
}

/**
 * Updates an existing user row. If a new password is supplied, updates the
 * linked Supabase Auth user's password too; if the email changed, updates
 * the Auth user's email as well so sign-in keeps matching.
 *
 * @param {object} body
 * @returns {{status: "success"} | {status: "error", message: string}}
 */
function handleAdminUpdateEmployee(body) {
  const admin = requireAdmin(body.access_token);
  if (!admin) return { status: "error", message: "Unauthorized." };

  const role = body.role;
  if (ROLE_NAMES.indexOf(role) === -1) {
    return { status: "error", message: "Unknown role." };
  }
  if (!body.id) {
    return { status: "error", message: "Missing employee id." };
  }

  const decodedBody = Object.assign({}, body, {
    email: b64Decode(body.email),
    password: b64Decode(body.password),
  });

  const validationError = validateEmployeeInput(role, decodedBody, /* passwordRequired */ false);
  if (validationError) return { status: "error", message: validationError };

  const existingRows = restGet("users", "id=eq." + encodeURIComponent(body.id) + "&select=email&limit=1");
  if (!existingRows || existingRows.length === 0) {
    return { status: "error", message: "Employee not found." };
  }
  const existing = existingRows[0];
  const newEmail = decodedBody.email ? String(decodedBody.email).trim().toLowerCase() : existing.email;

  if (decodedBody.password || newEmail !== existing.email) {
    const authUpdate = {};
    if (decodedBody.password) authUpdate.password = decodedBody.password;
    if (newEmail !== existing.email) authUpdate.email = newEmail;

    const authResult = authAdminUpdateUser(body.id, authUpdate);
    if (authResult.error) {
      return { status: "error", message: authResult.error };
    }
  }

  const row = buildEmployeeRow(role, decodedBody, newEmail);
  const updateResult = restPatch("users", "id=eq." + encodeURIComponent(body.id), row);

  if (updateResult.error) {
    return { status: "error", message: friendlyTableError(updateResult.error) };
  }

  return { status: "success" };
}

/**
 * Deletes a user row and its linked Supabase Auth user.
 *
 * @param {object} body
 * @returns {{status: "success"} | {status: "error", message: string}}
 */
function handleAdminDeleteEmployee(body) {
  const admin = requireAdmin(body.access_token);
  if (!admin) return { status: "error", message: "Unauthorized." };

  if (!body.id) {
    return { status: "error", message: "Missing employee id." };
  }

  const existingRows = restGet("users", "id=eq." + encodeURIComponent(body.id) + "&select=id&limit=1");
  if (!existingRows || existingRows.length === 0) {
    return { status: "error", message: "Employee not found." };
  }

  const deleteResult = restDelete("users", "id=eq." + encodeURIComponent(body.id));
  if (deleteResult.error) {
    return { status: "error", message: friendlyTableError(deleteResult.error) };
  }

  authAdminDeleteUser(body.id); // best-effort; the row is already gone either way

  return { status: "success" };
}

/**
 * Grants or revokes Admin permission for a Supabase Auth user id. An Admin
 * may not remove their own permission — otherwise a lone Admin could lock
 * everyone (including themselves) out with no one left to undo it.
 *
 * @param {{auth_user_id: string, is_admin: boolean, access_token: string}} body
 * @returns {{status: "success"} | {status: "error", message: string}}
 */
function handleAdminSetPermission(body) {
  const admin = requireAdmin(body.access_token);
  if (!admin) return { status: "error", message: "Unauthorized." };

  const targetUserId = body.auth_user_id;
  const grantAdmin = !!body.is_admin;

  if (!targetUserId) {
    return { status: "error", message: "Missing auth_user_id." };
  }
  if (!grantAdmin && targetUserId === admin.id) {
    return { status: "error", message: "You cannot remove your own Admin permission." };
  }

  const upsertResult = restPost(
    "admin_permissions",
    { auth_user_id: targetUserId, is_admin: grantAdmin, granted_by: admin.id, granted_at: new Date().toISOString() },
    { Prefer: "return=representation,resolution=merge-duplicates" }
  );

  if (upsertResult.error) {
    return { status: "error", message: friendlyTableError(upsertResult.error) };
  }

  return { status: "success" };
}

/**
 * Activates or deactivates a user. A deactivated account is denied at Sign
 * In (see resolveAccountRole()) but its Supabase Auth user and users row
 * are left intact — unlike Delete, this is reversible. An Admin may not
 * deactivate their own account, for the same lockout reason as
 * handleAdminSetPermission.
 *
 * @param {{role: string, id: string, is_active: boolean, access_token: string}} body
 * @returns {{status: "success"} | {status: "error", message: string}}
 */
function handleAdminSetActive(body) {
  const admin = requireAdmin(body.access_token);
  if (!admin) return { status: "error", message: "Unauthorized." };

  if (!body.id) {
    return { status: "error", message: "Missing employee id." };
  }
  const setActive = !!body.is_active;
  if (!setActive && body.id === admin.id) {
    return { status: "error", message: "You cannot deactivate your own account." };
  }

  const updateResult = restPatch("users", "id=eq." + encodeURIComponent(body.id), { is_active: setActive });
  if (updateResult.error) {
    return { status: "error", message: friendlyTableError(updateResult.error) };
  }

  return { status: "success" };
}

/**
 * One-time seed path: creates the given employees as Admins. Gated by
 * BOOTSTRAP_KEY (a Script Property you set yourself) rather than an admin
 * session, since no Admin exists yet the first time this runs. Refuses to
 * run a second time (BOOTSTRAP_USED property) even with a correct key —
 * delete BOOTSTRAP_KEY once you've used this so it can never run again.
 *
 * @param {{bootstrap_key: string, employees: Array<object>}} body
 * @returns {{status: "success", results: Array} | {status: "error", message: string}}
 */
function handleBootstrapAdmin(body) {
  const configuredKey = getBootstrapKey();
  if (!configuredKey) {
    return { status: "error", message: "Bootstrap is not enabled (no BOOTSTRAP_KEY script property set)." };
  }
  if (PropertiesService.getScriptProperties().getProperty("BOOTSTRAP_USED") === "true") {
    return { status: "error", message: "Bootstrap has already been used." };
  }
  const suppliedKey = b64Decode(body.bootstrap_key);
  if (String(suppliedKey || "") !== configuredKey) {
    return { status: "error", message: "Invalid bootstrap key." };
  }
  if (!Array.isArray(body.employees) || body.employees.length === 0) {
    return { status: "error", message: "No employees supplied." };
  }

  const results = body.employees.map((employee) => {
    const role = employee.role;
    if (ROLE_NAMES.indexOf(role) === -1) {
      return { email: employee.email, status: "error", message: "Unknown role." };
    }

    const decodedEmployee = Object.assign({}, employee, {
      email: b64Decode(employee.email),
      password: b64Decode(employee.password) || generateDefaultPassword(employee.full_name),
    });

    const validationError = validateEmployeeInput(role, decodedEmployee, /* passwordRequired */ true);
    if (validationError) return { email: decodedEmployee.email, status: "error", message: validationError };

    const email = String(decodedEmployee.email).trim().toLowerCase();
    const authResult = authAdminCreateUser(email, decodedEmployee.password);
    if (authResult.error) return { email: email, status: "error", message: authResult.error };

    const row = buildEmployeeRow(role, decodedEmployee, email);
    row.id = authResult.userId;
    const insertResult = restPost("users", row);
    if (insertResult.error) {
      authAdminDeleteUser(authResult.userId);
      return { email: email, status: "error", message: friendlyTableError(insertResult.error) };
    }

    const permissionResult = restPost("admin_permissions", {
      auth_user_id: authResult.userId,
      is_admin: true,
      granted_by: null,
      granted_at: new Date().toISOString(),
    });
    if (permissionResult.error) {
      return { email: email, status: "error", message: friendlyTableError(permissionResult.error) };
    }

    return { email: email, status: "success" };
  });

  // Only lock the one-time bootstrap path once it actually created at least
  // one account — a run where every employee failed (e.g. a misconfigured
  // Script Property) must stay retryable, not burn the only attempt.
  const anySuccess = results.some((result) => result.status === "success");
  if (anySuccess) {
    PropertiesService.getScriptProperties().setProperty("BOOTSTRAP_USED", "true");
  }
  return { status: "success", results: results };
}

// =============================================================================
// Validation
// =============================================================================

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validates the shared + role-specific fields for a create/update request.
 *
 * @param {string} role
 * @param {object} input
 * @param {boolean} passwordRequired
 * @returns {string | null} an error message, or null if valid.
 */
function validateEmployeeInput(role, input, passwordRequired) {
  if (!input.full_name || !String(input.full_name).trim()) return "Full name is required.";
  if (!input.job_title || !String(input.job_title).trim()) return "Job title is required.";
  if (!input.email || !EMAIL_REGEX.test(String(input.email).trim())) return "A valid email is required.";

  const requiredExtras = ROLE_REQUIRED_EXTRA_FIELDS[role] || [];
  for (let i = 0; i < requiredExtras.length; i++) {
    const field = requiredExtras[i];
    if (!input[field] || !String(input[field]).trim()) {
      return capitalize(field) + " is required.";
    }
  }

  if (passwordRequired && !input.password) return "Password is required.";
  if (input.password) {
    const rules = checkPasswordRulesServer(input.password);
    if (!rules.allValid) {
      return "Password must be at least 6 characters and include a letter, a number, and a special character.";
    }
  }

  return null;
}

/**
 * Mirrors js/password-rules.js's checkPasswordRules() — kept in sync
 * deliberately since this is the server-side re-check for Admin-set
 * passwords (never trust client-side validation alone).
 *
 * @param {string} password
 * @returns {{allValid: boolean}}
 */
function checkPasswordRulesServer(password) {
  const value = password || "";
  const minLength = value.length >= 6;
  const hasLetter = /[a-zA-Z]/.test(value);
  const hasNumber = /[0-9]/.test(value);
  const hasSpecial = /[^a-zA-Z0-9]/.test(value);
  return { allValid: minLength && hasLetter && hasNumber && hasSpecial };
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Builds the row payload to send to PostgREST from a create/update request,
 * whitelisted to exactly the columns "users" has. Does not set "id" — the
 * two callers (create vs. update) attach it differently (a freshly created
 * Auth user id vs. the existing row's id in the URL path).
 *
 * @param {string} role
 * @param {object} input
 * @param {string} email
 * @returns {object}
 */
function buildEmployeeRow(role, input, email) {
  const row = {
    full_name: String(input.full_name).trim(),
    job_title: String(input.job_title).trim(),
    email: email,
    role: ROLE_TO_DB[role],
  };

  if (input.company !== undefined) {
    row.company = input.company === "" ? null : String(input.company).trim();
  }

  (ROLE_EXTRA_FIELDS[role] || []).forEach((field) => {
    if (input[field] !== undefined) {
      row[field] = input[field] === "" ? null : String(input[field]).trim();
    }
  });

  return row;
}

/**
 * Turns a raw PostgREST error into a message safe/useful to show an Admin,
 * recognizing the common "unique constraint violated" case (duplicate
 * email).
 *
 * @param {string} rawMessage
 * @returns {string}
 */
function friendlyTableError(rawMessage) {
  const text = String(rawMessage || "");
  if (text.indexOf("duplicate key") !== -1 && text.indexOf("email") !== -1) {
    return "This email is already in use.";
  }
  if (text.indexOf("violates foreign key constraint") !== -1) {
    return "This person can't be deleted because they have existing requests or history linked to their account. Use the Status toggle to deactivate them instead.";
  }
  return "Could not save the record. Please try again.";
}

// =============================================================================
// Supabase REST (PostgREST) + Auth Admin API helpers — all use the
// service_role key, so every response here bypasses Row Level Security.
// Only ever call these from code that has already checked the CALLER's
// permissions itself (requireAdmin() / resolveAccountRole() above).
// =============================================================================

function restGet(table, queryString) {
  const url = SUPABASE_URL.replace(/\/+$/, "") + "/rest/v1/" + table + "?" + queryString;
  const response = UrlFetchApp.fetch(url, {
    method: "get",
    headers: serviceRoleHeaders(),
    muteHttpExceptions: true,
  });

  if (response.getResponseCode() >= 300) return [];
  try {
    return JSON.parse(response.getContentText());
  } catch (error) {
    return [];
  }
}

function restPost(table, row, extraHeaders) {
  const url = SUPABASE_URL.replace(/\/+$/, "") + "/rest/v1/" + table;
  const headers = serviceRoleHeaders();
  headers["Content-Type"] = "application/json";
  headers["Prefer"] = "return=representation";
  Object.assign(headers, extraHeaders || {});

  const response = UrlFetchApp.fetch(url, {
    method: "post",
    headers: headers,
    payload: JSON.stringify(row),
    muteHttpExceptions: true,
  });

  return parseWriteResponse(response);
}

function restPatch(table, queryString, fields) {
  const url = SUPABASE_URL.replace(/\/+$/, "") + "/rest/v1/" + table + "?" + queryString;
  const headers = serviceRoleHeaders();
  headers["Content-Type"] = "application/json";
  headers["Prefer"] = "return=representation";

  const response = UrlFetchApp.fetch(url, {
    method: "patch",
    headers: headers,
    payload: JSON.stringify(fields),
    muteHttpExceptions: true,
  });

  return parseWriteResponse(response);
}

function restDelete(table, queryString) {
  const url = SUPABASE_URL.replace(/\/+$/, "") + "/rest/v1/" + table + "?" + queryString;
  const response = UrlFetchApp.fetch(url, {
    method: "delete",
    headers: serviceRoleHeaders(),
    muteHttpExceptions: true,
  });

  return parseWriteResponse(response);
}

function parseWriteResponse(response) {
  const code = response.getResponseCode();
  if (code >= 300) {
    let message = response.getContentText();
    try {
      const parsed = JSON.parse(message);
      message = parsed.message || parsed.msg || message;
    } catch (parseError) {
      // keep raw text
    }
    return { error: message };
  }

  try {
    return { data: JSON.parse(response.getContentText()) };
  } catch (parseError) {
    return { data: [] };
  }
}

function serviceRoleHeaders() {
  const key = getServiceRoleKey();
  return { apikey: key, Authorization: "Bearer " + key };
}

/**
 * Creates a Supabase Auth user with a password already set and the email
 * pre-confirmed (Admin-created accounts should be usable immediately, no
 * separate email verification step).
 *
 * @param {string} email
 * @param {string} password
 * @returns {{userId: string} | {error: string}}
 */
function authAdminCreateUser(email, password) {
  const url = SUPABASE_URL.replace(/\/+$/, "") + "/auth/v1/admin/users";
  const headers = serviceRoleHeaders();
  headers["Content-Type"] = "application/json";

  const response = UrlFetchApp.fetch(url, {
    method: "post",
    headers: headers,
    payload: JSON.stringify({ email: email, password: password, email_confirm: true }),
    muteHttpExceptions: true,
  });

  const code = response.getResponseCode();
  const body = safeParseJson(response.getContentText());

  if (code >= 300) {
    const message = (body && (body.msg || body.error_description || body.message)) || "Could not create account.";
    const friendly = /registered|exists/i.test(message) ? "This email is already in use." : message;
    return { error: friendly };
  }

  return { userId: body.id };
}

/**
 * @param {string} userId
 * @param {{password?: string, email?: string}} fields
 * @returns {{ok: true} | {error: string}}
 */
function authAdminUpdateUser(userId, fields) {
  const url = SUPABASE_URL.replace(/\/+$/, "") + "/auth/v1/admin/users/" + encodeURIComponent(userId);
  const headers = serviceRoleHeaders();
  headers["Content-Type"] = "application/json";

  const response = UrlFetchApp.fetch(url, {
    method: "put",
    headers: headers,
    payload: JSON.stringify(fields),
    muteHttpExceptions: true,
  });

  const code = response.getResponseCode();
  if (code >= 300) {
    const body = safeParseJson(response.getContentText());
    const message = (body && (body.msg || body.error_description || body.message)) || "Could not update account.";
    const friendly = /registered|exists/i.test(message) ? "This email is already in use." : message;
    return { error: friendly };
  }

  return { ok: true };
}

/**
 * @param {string} userId
 */
function authAdminDeleteUser(userId) {
  const url = SUPABASE_URL.replace(/\/+$/, "") + "/auth/v1/admin/users/" + encodeURIComponent(userId);
  UrlFetchApp.fetch(url, {
    method: "delete",
    headers: serviceRoleHeaders(),
    muteHttpExceptions: true,
  });
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

/**
 * Wraps a JS value as a JSON TextOutput response. See the note in the
 * original version of this file (preserved here) on why POSTs from the
 * client use Content-Type "text/plain": Apps Script Web Apps cannot answer
 * a CORS preflight (OPTIONS) request, so keeping requests as CORS "simple
 * requests" (GET, or POST with text/plain) is what lets fetch() from the
 * browser work at all against this endpoint.
 *
 * @param {*} data
 * @returns {GoogleAppsScript.Content.TextOutput}
 */
function buildJsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
