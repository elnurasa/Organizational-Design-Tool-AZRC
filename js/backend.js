/**
 * backend.js
 * ---------------------------------------------------------------------------
 * The app's ONLY channel to the privileged backend — the Supabase Edge
 * Function `admin-api` (supabase/functions/admin-api/index.ts), which holds
 * the service_role key and is therefore the one place allowed to create
 * accounts, set passwords, and grant Admin permission.
 *
 * Replaces js/google.js, which called a Google Apps Script Web App. Nothing
 * about the app's shape changed — same function names, same arguments, same
 * return values — only the host. The move was forced by the corporate
 * network: Azerconnect blocks the `google-app-script-base` application at
 * the proxy, so script.google.com was unreachable for every user and sign-in
 * itself failed with "Unable to reach the authorization service". The Edge
 * Function answers on the same *.supabase.co origin the app already uses for
 * Auth, which the network already permits.
 *
 * Exposes:
 *   - getAccessToken() -> the current Supabase session's access token
 *   - resolveAccountRole(accessToken) -> the verified caller's role
 *     (Admin/Manager/HRBP/OD), used right after a successful sign-in
 *
 * Admin Panel writes (all require the caller to already be signed in as an
 * Admin — the Edge Function re-verifies this server-side, never trusts the
 * client):
 *   - adminCreateEmployee(role, fields)
 *   - adminUpdateEmployee(role, id, fields)
 *   - adminDeleteEmployee(role, id)
 *   - adminSetPermission(authUserId, isAdmin)
 *   - adminSetActive(role, id, isActive)
 * ---------------------------------------------------------------------------
 */

/**
 * The deployed Edge Function's URL. Derived from SUPABASE_URL rather than
 * configured separately, since every Supabase project serves its functions
 * at the same fixed path — one less value to keep in sync. CONFIG.ADMIN_API_URL
 * overrides it if the function is ever hosted somewhere else.
 *
 * @returns {string}
 */
function getAdminApiUrl() {
  if (CONFIG.ADMIN_API_URL && !CONFIG.ADMIN_API_URL.startsWith("PASTE_")) {
    return CONFIG.ADMIN_API_URL;
  }
  return `${String(CONFIG.SUPABASE_URL).replace(/\/+$/, "")}/functions/v1/admin-api`;
}

/**
 * Reads the current Supabase session (if any) and returns its access token,
 * for attaching to backend requests that need server-side verification.
 *
 * @returns {Promise<string | null>}
 */
async function getAccessToken() {
  if (!supabaseClient) return null;

  const { data, error } = await supabaseClient.auth.getSession();
  if (error || !data || !data.session) return null;

  return data.session.access_token || null;
}

/**
 * Base64-encodes a string (UTF-8 safe). Used to obscure the email/password
 * of the account being created or updated before it's sent to the backend —
 * some corporate network security tools inspect outgoing requests for a
 * plaintext "email + password" pair (a known credential-phishing pattern)
 * and block them even for a legitimate first-party request. The Edge
 * Function decodes it server-side (see b64Decode there). Not a security
 * boundary — this endpoint is only ever reached over HTTPS.
 *
 * @param {string | undefined} value
 * @returns {string | undefined}
 */
function b64Encode(value) {
  if (value === undefined || value === null || value === "") return value;
  return btoa(unescape(encodeURIComponent(String(value))));
}

/**
 * Shared transport for every backend call. The Edge Function answers all
 * actions on one POST endpoint and always replies HTTP 200 with the outcome
 * in the body, so a non-200 here means the request never reached the
 * handler (network, deploy, or platform problem) — worth a distinct message
 * from a handler that ran and refused.
 *
 * @param {object} body - must include an "action" key.
 * @param {string} serviceLabel - what to call the backend in error messages,
 *   so a failure during sign-in doesn't mention the "admin service".
 * @returns {Promise<object>} the parsed JSON response.
 * @throws {Error} if the request can't be sent or the response can't be read.
 */
async function postBackendAction(body, serviceLabel) {
  if (!CONFIG.SUPABASE_URL || CONFIG.SUPABASE_URL.startsWith("PASTE_")) {
    throw new Error(
      "SUPABASE_URL is not configured. Update js/config.js with your Supabase project URL."
    );
  }

  let response;
  try {
    response = await fetch(getAdminApiUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (networkError) {
    throw new Error(`Unable to reach the ${serviceLabel}. Please check your connection.`);
  }

  if (!response.ok) {
    throw new Error(`The ${serviceLabel} returned an error (HTTP ${response.status}).`);
  }

  try {
    return await response.json();
  } catch (parseError) {
    throw new Error(`The ${serviceLabel} returned an unexpected response.`);
  }
}

/**
 * Asks the backend what role the holder of this access token has. The token
 * is verified server-side (the client's own claim about who it is, or
 * whether it's an Admin, is never trusted).
 *
 * Returns the PRIMARY role and the Admin permission separately — Admin is an
 * extra permission, never a replacement for the primary role (and never the
 * post-login landing page) — see the Edge Function's resolveAccountRole()
 * and js/auth.js's loginWithPassword()/getIsAdmin().
 *
 * @param {string} accessToken
 * @returns {Promise<{authorized: boolean, role: string | null, isAdmin: boolean}>}
 * @throws {Error} if the network request fails or the response is invalid.
 */
async function resolveAccountRole(accessToken) {
  const data = await postBackendAction(
    { action: "resolveRole", access_token: accessToken || "" },
    "authorization service"
  );

  if (!data || typeof data !== "object" || typeof data.authorized !== "boolean") {
    throw new Error("Authorization service returned malformed data.");
  }

  return { authorized: data.authorized, role: data.role || null, isAdmin: !!data.isAdmin };
}

/**
 * Shared helper for the Admin Panel write actions below. Attaches the
 * caller's access token automatically and turns a refusal by the backend
 * (status !== "success") into a thrown Error the UI can show.
 *
 * @param {object} body - must include an "action" key.
 * @returns {Promise<object>} the parsed JSON response.
 * @throws {Error} if no session exists, the request fails, or the action was
 *   refused.
 */
async function postAdminAction(body) {
  const accessToken = await getAccessToken();
  if (!accessToken) {
    throw new Error("Your session has expired. Please sign in again.");
  }

  const data = await postBackendAction(
    Object.assign({}, body, { access_token: accessToken }),
    "admin service"
  );

  if (!data || data.status !== "success") {
    throw new Error((data && data.message) || "The request could not be completed.");
  }

  return data;
}

/**
 * Creates a new Manager/HRBP/OD account (Supabase Auth user + users row).
 *
 * @param {"Manager" | "HRBP" | "OD"} role
 * @param {{full_name: string, job_title: string, email: string,
 *   password: string, company?: string, division?: string,
 *   department?: string, subdepartment?: string, unit?: string,
 *   subunit?: string}} fields
 * @returns {Promise<{id: string}>}
 * @throws {Error} if validation fails server-side or the request fails.
 */
async function adminCreateEmployee(role, fields) {
  const encodedFields = Object.assign({}, fields, {
    email: b64Encode(fields.email),
    password: b64Encode(fields.password),
  });
  const data = await postAdminAction(Object.assign({ action: "adminCreateEmployee", role: role }, encodedFields));
  return { id: data.id };
}

/**
 * Updates an existing user row. Fields omitted (undefined) are left
 * unchanged; pass password only when the Admin actually entered a new one.
 *
 * @param {"Manager" | "HRBP" | "OD"} role
 * @param {string} id
 * @param {object} fields
 * @returns {Promise<void>}
 */
async function adminUpdateEmployee(role, id, fields) {
  const encodedFields = Object.assign({}, fields, {
    email: b64Encode(fields.email),
    password: b64Encode(fields.password),
  });
  await postAdminAction(Object.assign({ action: "adminUpdateEmployee", role: role, id: id }, encodedFields));
}

/**
 * Deletes a user row and its linked Supabase Auth user.
 *
 * @param {"Manager" | "HRBP" | "OD"} role
 * @param {string} id
 * @returns {Promise<void>}
 */
async function adminDeleteEmployee(role, id) {
  await postAdminAction({ action: "adminDeleteEmployee", role: role, id: id });
}

/**
 * Grants or revokes Admin permission for a Supabase Auth user id.
 *
 * @param {string} authUserId
 * @param {boolean} isAdmin
 * @returns {Promise<void>}
 */
async function adminSetPermission(authUserId, isAdmin) {
  await postAdminAction({ action: "adminSetPermission", auth_user_id: authUserId, is_admin: isAdmin });
}

/**
 * Activates or deactivates a user. A deactivated account is denied at Sign
 * In but otherwise left intact (reversible, unlike Delete).
 *
 * @param {"Manager" | "HRBP" | "OD"} role
 * @param {string} id
 * @param {boolean} isActive
 * @returns {Promise<void>}
 */
async function adminSetActive(role, id, isActive) {
  await postAdminAction({ action: "adminSetActive", role: role, id: id, is_active: isActive });
}
