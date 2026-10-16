/**
 * admin-api (Supabase Edge Function)
 * ---------------------------------------------------------------------------
 * Authorization + Admin Panel backend for the Organizational Design Tool.
 *
 * Replaces the Google Apps Script Web App this app used to call
 * (apps-script/Code.gs, deleted). The logic is a faithful port — same
 * actions, same request/response shapes, same server-side checks — only the
 * host changed. The move was forced by the corporate network: Azerconnect
 * blocks the `google-app-script-base` application at the proxy, so
 * script.google.com was unreachable for EVERY user, not just Admins, which
 * made sign-in itself impossible. This function lives on the same
 * *.supabase.co origin the app already talks to for Auth, so it inherits
 * whatever access the browser already has to Supabase.
 *
 * WHY A SERVER AT ALL: creating accounts, changing passwords and granting
 * Admin permission need Supabase's service_role key, which must never reach
 * a browser. This function holds it (from the environment, never in source)
 * and performs those writes only after verifying the caller.
 *
 * The Structural Change Request workflow (requests / request_answers /
 * request_history) does NOT go through here — those writes need no elevated
 * privilege and the browser calls Postgres functions directly under Row
 * Level Security (see js/request-service.js and
 * supabase/migrations/0004_request_workflow_rpcs.sql). This function's scope
 * is exactly: sign-in role resolution, and Admin Panel user CRUD.
 *
 * AUTHENTICATION ARCHITECTURE (passwords live in Supabase Auth, never here):
 * this function never stores or compares a raw password — Admin Panel writes
 * hand it straight to Supabase Auth's Admin API (GoTrue), which hashes it.
 * Nothing in the app database ever holds a password or a hash.
 *
 * SERVER-SIDE VERIFICATION: deployed with --no-verify-jwt, so a caller's
 * email/role/id can never be trusted just because they claim it. Every
 * action except bootstrapAdmin requires an `access_token` (a Supabase
 * session token from a successful signInWithPassword() — see js/auth.js);
 * getVerifiedUser() confirms it with Supabase itself before anything
 * happens, and every admin* action additionally confirms that verified user
 * has an admin_permissions row (requireAdmin()) — the isAdmin flag a client
 * sends is never trusted.
 *
 * Why --no-verify-jwt rather than letting the platform gate it: this
 * function verifies tokens itself (as above, exactly as Code.gs did), and
 * bootstrapAdmin must be callable with no session at all — there is no
 * Admin yet the first time it runs.
 *
 * ENVIRONMENT (Edge Functions inject the first two automatically — nothing
 * to configure):
 *   SUPABASE_URL               - the project URL.
 *   SUPABASE_SERVICE_ROLE_KEY  - full database + Auth admin access.
 *   BOOTSTRAP_KEY              - OPTIONAL, and only for the one-time seed
 *                                path. Set it as a secret solely while
 *                                running bootstrapAdmin, then delete it;
 *                                while unset, bootstrap is disabled.
 *
 * Actions (POST, JSON body, `action` selects the handler):
 *   - resolveRole         { access_token }
 *       -> { authorized: true, role: "Manager"|"HRBP"|"OD"|"Admin", isAdmin }
 *          { authorized: false }
 *       Admin permission is orthogonal to the primary role and never
 *       overrides it; "Admin" is the role itself only for an account with
 *       Admin permission and no Manager/HRBP/OD row at all. A deactivated
 *       (is_active = false) account resolves as unauthorized.
 *   - adminCreateEmployee { role, full_name, job_title, email, password,
 *                           company?, division?, department?, subdepartment?,
 *                           unit?, subunit?, access_token }
 *   - adminUpdateEmployee { role, id, ...same optional fields, access_token }
 *   - adminDeleteEmployee { role, id, access_token }
 *   - adminSetPermission  { auth_user_id, is_admin, access_token }
 *   - adminSetActive      { role, id, is_active, access_token }
 *   - bootstrapAdmin      { bootstrap_key, employees: [...] }
 *       One-time seed, gated by BOOTSTRAP_KEY instead of an admin session.
 *       Refuses to run once ANY admin_permissions row exists — a stronger
 *       guard than Code.gs's "used once" flag, and one that needs no stored
 *       state: the condition it protects is precisely "no Admin exists yet".
 * ---------------------------------------------------------------------------
 */

const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// Any origin may call: every action authenticates by bearer token and
// re-checks permissions server-side, so the calling page's origin grants
// nothing on its own. This also keeps the app working from a file:// page,
// a local dev server, and wherever it is eventually hosted, without a
// redeploy for each.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Role name (as used throughout the client/session, e.g. sessionStorage,
// guardPage()) <-> the value stored in users.role. Kept as an explicit
// mapping at this one boundary rather than changing the client's role
// vocabulary, so nothing outside this file needs to know the DB uses
// lowercase/underscored values.
const ROLE_TO_DB: Record<string, string> = { Manager: "manager", HRBP: "hrbp", OD: "od_team" };
const DB_TO_ROLE: Record<string, string> = { manager: "Manager", hrbp: "HRBP", od_team: "OD" };
const ROLE_NAMES = Object.keys(ROLE_TO_DB);

// Extra fields accepted from the client beyond the shared full_name/
// job_title/email/company, whitelisted per role so a caller can never write
// an unexpected column just by naming it in the request body.
const ROLE_EXTRA_FIELDS: Record<string, string[]> = {
  Manager: ["division", "department", "subdepartment", "unit", "subunit"],
  HRBP: [],
  OD: [],
};

// Extra fields that are REQUIRED (beyond full_name/job_title/email, which
// are always required) for each role.
const ROLE_REQUIRED_EXTRA_FIELDS: Record<string, string[]> = {
  Manager: ["division", "department"],
  HRBP: [],
  OD: [],
};

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type VerifiedUser = { email: string; id: string };
type ActionResult = Record<string, unknown>;

// =============================================================================
// Request routing
// =============================================================================

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (request.method !== "POST") {
    return json({ status: "error", message: "Unknown request." });
  }

  let body: Record<string, any>;
  try {
    body = await request.json();
  } catch {
    return json({ status: "error", message: "Invalid request body." });
  }

  switch (body.action) {
    case "resolveRole":
      return json(await resolveAccountRole(body.access_token));
    case "adminCreateEmployee":
      return json(await handleAdminCreateEmployee(body));
    case "adminUpdateEmployee":
      return json(await handleAdminUpdateEmployee(body));
    case "adminDeleteEmployee":
      return json(await handleAdminDeleteEmployee(body));
    case "adminSetPermission":
      return json(await handleAdminSetPermission(body));
    case "adminSetActive":
      return json(await handleAdminSetActive(body));
    case "bootstrapAdmin":
      return json(await handleBootstrapAdmin(body));
    default:
      return json({ status: "error", message: "Unknown action." });
  }
});

/**
 * Every response is HTTP 200 with the outcome in the body, exactly as the
 * Apps Script version behaved — js/backend.js reads `status`/`authorized`
 * from the body and treats a non-200 as a transport failure, so handler-level
 * failures must not surface as HTTP errors.
 */
function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// =============================================================================
// Auth verification
// =============================================================================

/**
 * Verifies a Supabase access token by asking Supabase itself who it belongs
 * to, rather than trusting any email/id the caller claims. Fails closed
 * (returns null) on a missing token, an invalid/expired one, or any network
 * error.
 */
async function getVerifiedUser(accessToken: string | undefined): Promise<VerifiedUser | null> {
  if (!accessToken) return null;
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return null;

  try {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        // service_role as the apikey, carried over from the Apps Script
        // version where the anon key was being rejected on this endpoint.
        // Safe either way: this only confirms who a token belongs to, and no
        // elevated action is taken on the strength of the response beyond
        // that.
        apikey: SERVICE_ROLE_KEY,
      },
    });

    if (!response.ok) return null;

    const user = await response.json();
    if (!user || !user.email || !user.id) return null;

    return { email: String(user.email).trim().toLowerCase(), id: user.id };
  } catch {
    return null;
  }
}

/**
 * Verifies the access token AND that the resulting user has an
 * admin_permissions row with is_admin = true. This is the gate every
 * admin* action must pass before touching any data.
 */
async function requireAdmin(accessToken: string | undefined): Promise<VerifiedUser | null> {
  const verifiedUser = await getVerifiedUser(accessToken);
  if (!verifiedUser) return null;

  const rows = await restGet(
    "admin_permissions",
    `auth_user_id=eq.${encodeURIComponent(verifiedUser.id)}&select=is_admin`,
  );
  if (!rows || rows.length === 0 || !rows[0].is_admin) return null;

  return verifiedUser;
}

/**
 * Decodes a base64 string back to plain text. The browser base64-encodes
 * email/password/bootstrap_key before sending them — some corporate network
 * security tools inspect outgoing requests for a plaintext "corporate email
 * + password" pair (a known credential-phishing pattern) and block them even
 * for a legitimate first-party request. Encoding avoids that false positive;
 * it is not a security boundary (this endpoint is only reached over HTTPS).
 */
function b64Decode(value: string | undefined): string | undefined {
  if (value === undefined || value === null || value === "") return value;
  try {
    const bytes = Uint8Array.from(atob(String(value)), (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return value; // not valid base64 — pass through unchanged
  }
}

// =============================================================================
// Sign In
// =============================================================================

/**
 * Resolves the ROLE for an already-authenticated caller (a valid
 * access_token means Supabase Auth already confirmed the password — this
 * only ever answers "what is this verified person allowed to see", never
 * "is this password correct").
 *
 * Admin permission is orthogonal to the primary role, not a replacement for
 * it: an account with both a users row AND an admin_permissions row gets
 * back its PRIMARY role plus isAdmin: true as a separate field — Admin never
 * overrides the primary role as the post-login landing page (see
 * js/auth.js's loginWithPassword()/ROLE_REDIRECT_MAP and app.js's
 * guardPage("Admin"), which gates the Admin Panel on the isAdmin flag, not
 * on role === "Admin"). A deactivated account is treated as unauthorized,
 * same as a non-existent one — deliberately without a distinct message, so
 * this endpoint can't be used to probe whether an email is a real, disabled
 * account.
 */
async function resolveAccountRole(accessToken: string | undefined): Promise<ActionResult> {
  const verifiedUser = await getVerifiedUser(accessToken);
  if (!verifiedUser) return { authorized: false };

  const adminRows = await restGet(
    "admin_permissions",
    `auth_user_id=eq.${encodeURIComponent(verifiedUser.id)}&select=is_admin&limit=1`,
  );
  const isAdmin = !!(adminRows && adminRows.length > 0 && adminRows[0].is_admin);

  const userRows = await restGet(
    "users",
    `id=eq.${encodeURIComponent(verifiedUser.id)}&select=role,is_active&limit=1`,
  );
  if (userRows && userRows.length > 0 && userRows[0].is_active && DB_TO_ROLE[userRows[0].role]) {
    return { authorized: true, role: DB_TO_ROLE[userRows[0].role], isAdmin };
  }

  if (isAdmin) {
    // Admin permission with no primary Manager/HRBP/OD row at all (a
    // pure-Admin account) — "Admin" is the only role available to land on.
    return { authorized: true, role: "Admin", isAdmin: true };
  }

  // A real, password-verified Supabase Auth user with no active users row
  // and no admin_permissions row — e.g. deleted/deactivated from the Admin
  // Panel after their session token was issued. Deny; js/auth.js signs them
  // out.
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
 */
async function handleAdminCreateEmployee(body: Record<string, any>): Promise<ActionResult> {
  const admin = await requireAdmin(body.access_token);
  if (!admin) return { status: "error", message: "Unauthorized." };

  const role = body.role;
  if (ROLE_NAMES.indexOf(role) === -1) {
    return { status: "error", message: "Unknown role." };
  }

  const decodedBody = {
    ...body,
    email: b64Decode(body.email),
    password: b64Decode(body.password) || generateDefaultPassword(body.full_name),
  };

  const validationError = validateEmployeeInput(role, decodedBody, /* passwordRequired */ true);
  if (validationError) return { status: "error", message: validationError };

  const email = String(decodedBody.email).trim().toLowerCase();

  const authResult = await authAdminCreateUser(email, decodedBody.password);
  if (authResult.error) {
    return { status: "error", message: authResult.error };
  }

  const row = buildEmployeeRow(role, decodedBody, email);
  row.id = authResult.userId;
  const insertResult = await restPost("users", row);

  if (insertResult.error) {
    await authAdminDeleteUser(authResult.userId!); // don't leak a login with no profile
    return { status: "error", message: friendlyTableError(insertResult.error) };
  }

  return { status: "success", id: insertResult.data[0].id };
}

/**
 * Updates an existing user row. If a new password is supplied, updates the
 * linked Supabase Auth user's password too; if the email changed, updates
 * the Auth user's email as well so sign-in keeps matching.
 */
async function handleAdminUpdateEmployee(body: Record<string, any>): Promise<ActionResult> {
  const admin = await requireAdmin(body.access_token);
  if (!admin) return { status: "error", message: "Unauthorized." };

  const role = body.role;
  if (ROLE_NAMES.indexOf(role) === -1) {
    return { status: "error", message: "Unknown role." };
  }
  if (!body.id) {
    return { status: "error", message: "Missing employee id." };
  }

  const decodedBody = {
    ...body,
    email: b64Decode(body.email),
    password: b64Decode(body.password),
  };

  const validationError = validateEmployeeInput(role, decodedBody, /* passwordRequired */ false);
  if (validationError) return { status: "error", message: validationError };

  const existingRows = await restGet("users", `id=eq.${encodeURIComponent(body.id)}&select=email&limit=1`);
  if (!existingRows || existingRows.length === 0) {
    return { status: "error", message: "Employee not found." };
  }
  const existing = existingRows[0];
  const newEmail = decodedBody.email ? String(decodedBody.email).trim().toLowerCase() : existing.email;

  if (decodedBody.password || newEmail !== existing.email) {
    const authUpdate: Record<string, string> = {};
    if (decodedBody.password) authUpdate.password = decodedBody.password;
    if (newEmail !== existing.email) authUpdate.email = newEmail;

    const authResult = await authAdminUpdateUser(body.id, authUpdate);
    if (authResult.error) {
      return { status: "error", message: authResult.error };
    }
  }

  const row = buildEmployeeRow(role, decodedBody, newEmail);
  const updateResult = await restPatch("users", `id=eq.${encodeURIComponent(body.id)}`, row);

  if (updateResult.error) {
    return { status: "error", message: friendlyTableError(updateResult.error) };
  }

  return { status: "success" };
}

/**
 * Deletes a user row and its linked Supabase Auth user.
 */
async function handleAdminDeleteEmployee(body: Record<string, any>): Promise<ActionResult> {
  const admin = await requireAdmin(body.access_token);
  if (!admin) return { status: "error", message: "Unauthorized." };

  if (!body.id) {
    return { status: "error", message: "Missing employee id." };
  }

  const existingRows = await restGet("users", `id=eq.${encodeURIComponent(body.id)}&select=id&limit=1`);
  if (!existingRows || existingRows.length === 0) {
    return { status: "error", message: "Employee not found." };
  }

  const deleteResult = await restDelete("users", `id=eq.${encodeURIComponent(body.id)}`);
  if (deleteResult.error) {
    return { status: "error", message: friendlyTableError(deleteResult.error) };
  }

  await authAdminDeleteUser(body.id); // best-effort; the row is already gone either way

  return { status: "success" };
}

/**
 * Grants or revokes Admin permission for a Supabase Auth user id. An Admin
 * may not remove their own permission — otherwise a lone Admin could lock
 * everyone (including themselves) out with no one left to undo it.
 */
async function handleAdminSetPermission(body: Record<string, any>): Promise<ActionResult> {
  const admin = await requireAdmin(body.access_token);
  if (!admin) return { status: "error", message: "Unauthorized." };

  const targetUserId = body.auth_user_id;
  const grantAdmin = !!body.is_admin;

  if (!targetUserId) {
    return { status: "error", message: "Missing auth_user_id." };
  }
  if (!grantAdmin && targetUserId === admin.id) {
    return { status: "error", message: "You cannot remove your own Admin permission." };
  }

  const upsertResult = await restPost(
    "admin_permissions",
    {
      auth_user_id: targetUserId,
      is_admin: grantAdmin,
      granted_by: admin.id,
      granted_at: new Date().toISOString(),
    },
    { Prefer: "return=representation,resolution=merge-duplicates" },
  );

  if (upsertResult.error) {
    return { status: "error", message: friendlyTableError(upsertResult.error) };
  }

  return { status: "success" };
}

/**
 * Activates or deactivates a user. A deactivated account is denied at Sign
 * In (see resolveAccountRole()) but its Supabase Auth user and users row are
 * left intact — unlike Delete, this is reversible. An Admin may not
 * deactivate their own account, for the same lockout reason as
 * handleAdminSetPermission.
 */
async function handleAdminSetActive(body: Record<string, any>): Promise<ActionResult> {
  const admin = await requireAdmin(body.access_token);
  if (!admin) return { status: "error", message: "Unauthorized." };

  if (!body.id) {
    return { status: "error", message: "Missing employee id." };
  }
  const setActive = !!body.is_active;
  if (!setActive && body.id === admin.id) {
    return { status: "error", message: "You cannot deactivate your own account." };
  }

  const updateResult = await restPatch("users", `id=eq.${encodeURIComponent(body.id)}`, {
    is_active: setActive,
  });
  if (updateResult.error) {
    return { status: "error", message: friendlyTableError(updateResult.error) };
  }

  return { status: "success" };
}

/**
 * One-time seed path: creates the given employees as Admins. Gated by the
 * BOOTSTRAP_KEY secret rather than an admin session, since no Admin exists
 * yet the first time this runs.
 *
 * Code.gs guarded re-runs with a "used once" script property; there is no
 * equivalent per-function storage here, so the guard asks the database the
 * question it actually cares about instead: if ANY admin_permissions row
 * exists, bootstrapping is over and this refuses. Delete the BOOTSTRAP_KEY
 * secret once you've used this so it can never run again at all.
 */
async function handleBootstrapAdmin(body: Record<string, any>): Promise<ActionResult> {
  const configuredKey = Deno.env.get("BOOTSTRAP_KEY");
  if (!configuredKey) {
    return { status: "error", message: "Bootstrap is not enabled (no BOOTSTRAP_KEY secret set)." };
  }

  const suppliedKey = b64Decode(body.bootstrap_key);
  if (String(suppliedKey || "") !== configuredKey) {
    return { status: "error", message: "Invalid bootstrap key." };
  }

  const existingAdmins = await restGet("admin_permissions", "is_admin=is.true&select=auth_user_id&limit=1");
  if (existingAdmins && existingAdmins.length > 0) {
    return { status: "error", message: "Bootstrap has already been used (an Admin already exists)." };
  }

  if (!Array.isArray(body.employees) || body.employees.length === 0) {
    return { status: "error", message: "No employees supplied." };
  }

  const results: ActionResult[] = [];
  for (const employee of body.employees) {
    const role = employee.role;
    if (ROLE_NAMES.indexOf(role) === -1) {
      results.push({ email: employee.email, status: "error", message: "Unknown role." });
      continue;
    }

    const decodedEmployee = {
      ...employee,
      email: b64Decode(employee.email),
      password: b64Decode(employee.password) || generateDefaultPassword(employee.full_name),
    };

    const validationError = validateEmployeeInput(role, decodedEmployee, /* passwordRequired */ true);
    if (validationError) {
      results.push({ email: decodedEmployee.email, status: "error", message: validationError });
      continue;
    }

    const email = String(decodedEmployee.email).trim().toLowerCase();
    const authResult = await authAdminCreateUser(email, decodedEmployee.password);
    if (authResult.error) {
      results.push({ email, status: "error", message: authResult.error });
      continue;
    }

    const row = buildEmployeeRow(role, decodedEmployee, email);
    row.id = authResult.userId;
    const insertResult = await restPost("users", row);
    if (insertResult.error) {
      await authAdminDeleteUser(authResult.userId!);
      results.push({ email, status: "error", message: friendlyTableError(insertResult.error) });
      continue;
    }

    const permissionResult = await restPost("admin_permissions", {
      auth_user_id: authResult.userId,
      is_admin: true,
      granted_by: null,
      granted_at: new Date().toISOString(),
    });
    if (permissionResult.error) {
      results.push({ email, status: "error", message: friendlyTableError(permissionResult.error) });
      continue;
    }

    results.push({ email, status: "success" });
  }

  return { status: "success", results };
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Validates the shared + role-specific fields for a create/update request.
 * Returns an error message, or null if valid.
 */
function validateEmployeeInput(
  role: string,
  input: Record<string, any>,
  passwordRequired: boolean,
): string | null {
  if (!input.full_name || !String(input.full_name).trim()) return "Full name is required.";
  if (!input.job_title || !String(input.job_title).trim()) return "Job title is required.";
  if (!input.email || !EMAIL_REGEX.test(String(input.email).trim())) return "A valid email is required.";

  for (const field of ROLE_REQUIRED_EXTRA_FIELDS[role] || []) {
    if (!input[field] || !String(input[field]).trim()) {
      return capitalize(field) + " is required.";
    }
  }

  if (passwordRequired && !input.password) return "Password is required.";
  if (input.password && !checkPasswordRulesServer(input.password).allValid) {
    return "Password must be at least 6 characters and include a letter, a number, and a special character.";
  }

  return null;
}

/**
 * Mirrors js/password-rules.js's checkPasswordRules() — kept in sync
 * deliberately since this is the server-side re-check for Admin-set
 * passwords (never trust client-side validation alone).
 */
function checkPasswordRulesServer(password: string): { allValid: boolean } {
  const value = password || "";
  return {
    allValid:
      value.length >= 6 &&
      /[a-zA-Z]/.test(value) &&
      /[0-9]/.test(value) &&
      /[^a-zA-Z0-9]/.test(value),
  };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Generates this employee's starting password from their own full_name, so
 * every newly created account gets a password unique to them instead of one
 * shared default. Only ever the STARTING password: Supabase Auth hashes and
 * stores it like any other, and an Admin can overwrite it per-account at any
 * time via Edit. Only used when the caller supplies no password at all.
 *
 * Rule: first letter of each of the first three whitespace-separated name
 * parts, uppercased, + "_123!" — e.g. "Abbasova Irina Vladimirovna" (the
 * full_name convention throughout this app is surname first, given name,
 * then patronymic) -> "AIV_123!". The schema has no separate first/last
 * columns, so this parses the one full_name field. Parenthetical asides some
 * names carry (e.g. "Islamova (ex. Allahverdiyeva) Ulviyya Vahid") are
 * stripped first so they never contribute an initial. Falls back to fewer
 * initials if fewer than three parts are present — never zero, since
 * full_name is already required by validateEmployeeInput().
 */
function generateDefaultPassword(fullName: string): string {
  const withoutParens = String(fullName || "").replace(/\([^)]*\)/g, " ");
  const nameParts = withoutParens.split(/\s+/).filter(Boolean).slice(0, 3);
  return nameParts.map((part) => part.charAt(0).toUpperCase()).join("") + "_123!";
}

/**
 * Builds the row payload to send to PostgREST from a create/update request,
 * whitelisted to exactly the columns "users" has. Does not set "id" — the
 * two callers attach it differently (a freshly created Auth user id vs. the
 * existing row's id in the URL query).
 */
function buildEmployeeRow(role: string, input: Record<string, any>, email: string): Record<string, any> {
  const row: Record<string, any> = {
    full_name: String(input.full_name).trim(),
    job_title: String(input.job_title).trim(),
    email,
    role: ROLE_TO_DB[role],
  };

  if (input.company !== undefined) {
    row.company = input.company === "" ? null : String(input.company).trim();
  }

  for (const field of ROLE_EXTRA_FIELDS[role] || []) {
    if (input[field] !== undefined) {
      row[field] = input[field] === "" ? null : String(input[field]).trim();
    }
  }

  return row;
}

/**
 * Turns a raw PostgREST error into a message safe/useful to show an Admin,
 * recognizing the common "unique constraint violated" case (duplicate email).
 */
function friendlyTableError(rawMessage: string): string {
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

function serviceRoleHeaders(): Record<string, string> {
  return { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` };
}

async function restGet(table: string, queryString: string): Promise<any[]> {
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${queryString}`, {
      headers: serviceRoleHeaders(),
    });
    if (!response.ok) return [];
    return await response.json();
  } catch {
    return [];
  }
}

async function restPost(
  table: string,
  row: Record<string, any>,
  extraHeaders?: Record<string, string>,
): Promise<{ data?: any; error?: string }> {
  return await writeRequest(`${SUPABASE_URL}/rest/v1/${table}`, "POST", row, extraHeaders);
}

async function restPatch(
  table: string,
  queryString: string,
  fields: Record<string, any>,
): Promise<{ data?: any; error?: string }> {
  return await writeRequest(`${SUPABASE_URL}/rest/v1/${table}?${queryString}`, "PATCH", fields);
}

async function restDelete(table: string, queryString: string): Promise<{ data?: any; error?: string }> {
  return await writeRequest(`${SUPABASE_URL}/rest/v1/${table}?${queryString}`, "DELETE");
}

async function writeRequest(
  url: string,
  method: string,
  payload?: Record<string, any>,
  extraHeaders?: Record<string, string>,
): Promise<{ data?: any; error?: string }> {
  const headers: Record<string, string> = {
    ...serviceRoleHeaders(),
    Prefer: "return=representation",
    ...(extraHeaders || {}),
  };
  if (payload) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: payload ? JSON.stringify(payload) : undefined,
    });
  } catch (error) {
    return { error: String(error) };
  }

  const text = await response.text();

  if (!response.ok) {
    let message = text;
    try {
      const parsed = JSON.parse(text);
      message = parsed.message || parsed.msg || text;
    } catch {
      // keep raw text
    }
    return { error: message };
  }

  try {
    return { data: JSON.parse(text) };
  } catch {
    return { data: [] };
  }
}

/**
 * Creates a Supabase Auth user with a password already set and the email
 * pre-confirmed (Admin-created accounts should be usable immediately, with
 * no separate email verification step — which also matters because this
 * project has no custom SMTP configured, so confirmation mail to a
 * non-project address would never arrive).
 */
async function authAdminCreateUser(
  email: string,
  password: string,
): Promise<{ userId?: string; error?: string }> {
  try {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
      method: "POST",
      headers: { ...serviceRoleHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, email_confirm: true }),
    });

    const body = await response.json().catch(() => null);

    if (!response.ok) {
      const message = (body && (body.msg || body.error_description || body.message)) ||
        "Could not create account.";
      return { error: /registered|exists/i.test(message) ? "This email is already in use." : message };
    }

    return { userId: body.id };
  } catch (error) {
    return { error: String(error) };
  }
}

async function authAdminUpdateUser(
  userId: string,
  fields: Record<string, string>,
): Promise<{ ok?: true; error?: string }> {
  try {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      method: "PUT",
      headers: { ...serviceRoleHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const message = (body && (body.msg || body.error_description || body.message)) ||
        "Could not update account.";
      return { error: /registered|exists/i.test(message) ? "This email is already in use." : message };
    }

    return { ok: true };
  } catch (error) {
    return { error: String(error) };
  }
}

async function authAdminDeleteUser(userId: string): Promise<void> {
  try {
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      method: "DELETE",
      headers: serviceRoleHeaders(),
    });
  } catch {
    // best-effort, same as the Apps Script version — the caller has already
    // decided the users row is going away either way
  }
}
