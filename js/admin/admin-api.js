/**
 * admin-api.js
 * ---------------------------------------------------------------------------
 * Data layer for the Admin Panel, backed by Supabase — reads go straight to
 * Postgres (RLS-gated: an Admin's own `users_read`/`admin_permissions` read
 * policies allow this), writes go through the Apps Script Web App
 * (js/google.js), which is the only thing holding the service_role key
 * needed to also manage the matching Supabase Auth user (email/password).
 *
 * Every function keeps the exact shape admin-app.js/admin-table.js/
 * admin-modal.js already call — only what's inside these functions changed
 * from the earlier in-memory mock version.
 * ---------------------------------------------------------------------------
 */

// users.role stores the lowercase DB form ('manager'/'hrbp'/'od_team' — see
// ADMIN_ENTITY_CONFIG's dbRole in constants.js and Code.gs's ROLE_TO_DB);
// the client (sessionStorage, guardPage, this UI) uses the capitalized form
// throughout. Only listAdminProfiles()/getEmployeeById() need this reverse
// lookup — listEmployees() already knows its role from the caller.
const DB_ROLE_TO_CLIENT_ROLE = { manager: "Manager", hrbp: "HRBP", od_team: "OD" };

/**
 * Lists one entity's rows with search, filtering, sorting, and pagination —
 * pushed into the PostgREST query itself.
 *
 * @param {"Manager" | "HRBP" | "OD"} role
 * @param {{page: number, pageSize: number, search: string,
 *   filters: Record<string, string>, sortKey: string, sortAsc: boolean}} options
 * @returns {Promise<{rows: object[], totalCount: number}>}
 */
async function listEmployees(role, options) {
  requireSupabase();
  const config = ADMIN_ENTITY_CONFIG[role];
  const opts = options || {};

  let query = supabaseClient.from("users").select("*", { count: "exact" }).eq("role", config.dbRole);

  const search = (opts.search || "").trim();
  if (search) {
    const escaped = search.replace(/[%,]/g, "");
    query = query.or(config.searchableColumns.map((column) => `${column}.ilike.%${escaped}%`).join(","));
  }

  Object.entries(opts.filters || {}).forEach(([key, value]) => {
    if (value) query = query.eq(key, value);
  });

  const sortKey = opts.sortKey || "full_name";
  const sortAsc = opts.sortAsc !== false;
  const page = opts.page || 1;
  const pageSize = opts.pageSize || ADMIN_PAGE_SIZE;
  const from = (page - 1) * pageSize;

  query = query.order(sortKey, { ascending: sortAsc }).range(from, from + pageSize - 1);

  const { data, error, count } = await query;
  if (error) throw new Error(error.message);

  return { rows: (data || []).map((row) => Object.assign({}, row, { role: role })), totalCount: count || 0 };
}

/**
 * Distinct values for a filter dropdown.
 *
 * @param {"Manager" | "HRBP" | "OD"} role
 * @param {string} column
 * @returns {Promise<string[]>}
 */
async function listFilterOptions(role, column) {
  requireSupabase();
  const config = ADMIN_ENTITY_CONFIG[role];

  const { data, error } = await supabaseClient.from("users").select(column).eq("role", config.dbRole);
  if (error) throw new Error(error.message);

  const values = new Set((data || []).map((row) => row[column]).filter(Boolean));
  return Array.from(values).sort();
}

/**
 * Lists every employee across all three roles for the Admin Profiles page,
 * with each row's Admin status merged in from admin_permissions (a separate
 * table — is_admin is not a column on users itself).
 *
 * @param {{page: number, pageSize: number, search: string}} options
 * @returns {Promise<{rows: object[], totalCount: number}>}
 */
async function listAdminProfiles(options) {
  requireSupabase();
  const opts = options || {};

  let query = supabaseClient.from("users").select("*", { count: "exact" });

  const search = (opts.search || "").trim();
  if (search) {
    const escaped = search.replace(/[%,]/g, "");
    query = query.or(`full_name.ilike.%${escaped}%,job_title.ilike.%${escaped}%,email.ilike.%${escaped}%`);
  }

  const page = opts.page || 1;
  const pageSize = opts.pageSize || ADMIN_PAGE_SIZE;
  const from = (page - 1) * pageSize;

  query = query.order("full_name", { ascending: true }).range(from, from + pageSize - 1);

  const { data, error, count } = await query;
  if (error) throw new Error(error.message);

  const rows = data || [];
  const ids = rows.map((row) => row.id);
  const adminIds = new Set();
  if (ids.length > 0) {
    const { data: adminRows, error: adminError } = await supabaseClient
      .from("admin_permissions")
      .select("auth_user_id, is_admin")
      .in("auth_user_id", ids);
    if (adminError) throw new Error(adminError.message);
    (adminRows || []).forEach((row) => {
      if (row.is_admin) adminIds.add(row.auth_user_id);
    });
  }

  return {
    rows: rows.map((row) =>
      Object.assign({}, row, {
        role: DB_ROLE_TO_CLIENT_ROLE[row.role] || row.role,
        is_admin: adminIds.has(row.id),
      })
    ),
    totalCount: count || 0,
  };
}

/**
 * Fetches one employee's full row by id.
 *
 * @param {"Manager" | "HRBP" | "OD"} role
 * @param {string} id
 * @returns {Promise<object>}
 */
async function getEmployeeById(role, id) {
  requireSupabase();

  const { data, error } = await supabaseClient.from("users").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("This record could not be found. It may have been deleted.");

  return Object.assign({}, data, { role: DB_ROLE_TO_CLIENT_ROLE[data.role] || data.role });
}

/**
 * @param {"Manager" | "HRBP" | "OD"} role
 * @param {object} values
 * @returns {Promise<{id: string}>}
 */
async function createEmployee(role, values) {
  return adminCreateEmployee(role, values);
}

/**
 * @param {"Manager" | "HRBP" | "OD"} role
 * @param {string} id
 * @param {object} values
 * @returns {Promise<void>}
 */
async function updateEmployee(role, id, values) {
  await adminUpdateEmployee(role, id, values);
}

/**
 * @param {"Manager" | "HRBP" | "OD"} role
 * @param {string} id
 * @returns {Promise<void>}
 */
async function deleteEmployee(role, id) {
  await adminDeleteEmployee(role, id);
}

/**
 * Grants or revokes Admin permission.
 *
 * @param {string} userId
 * @param {boolean} isAdmin
 * @returns {Promise<void>}
 */
async function setAdminPermission(userId, isAdmin) {
  await adminSetPermission(userId, isAdmin);
}

/**
 * Activates or deactivates a user.
 *
 * @param {"Manager" | "HRBP" | "OD"} role
 * @param {string} id
 * @param {boolean} isActive
 * @returns {Promise<void>}
 */
async function setEmployeeActive(role, id, isActive) {
  await adminSetActive(role, id, isActive);
}
