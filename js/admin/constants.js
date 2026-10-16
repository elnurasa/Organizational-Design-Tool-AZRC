/**
 * constants.js (Admin Panel)
 * ---------------------------------------------------------------------------
 * Single source of truth for what each entity's table/form looks like, so
 * admin-table.js and admin-modal.js stay generic instead of special-casing
 * Managers/HRBPs/OD throughout. Add a field here once and every renderer
 * picks it up — no hardcoded column lists elsewhere.
 *
 * All three roles now live in the one "users" table (see
 * supabase/migrations/0003_unify_users_and_requests.sql) — `dbRole` is the
 * value stored in users.role that admin-api.js filters by; `role` stays the
 * capitalized name used throughout the client (sessionStorage, guardPage,
 * etc.), unchanged by that migration.
 * ---------------------------------------------------------------------------
 */

// ADMIN_PAGE_SIZE / ADMIN_SEARCH_DEBOUNCE_MS live in js/admin/admin-table.js
// now — that component is shared app-wide (Manager/HRBP/OD pages use it
// too), and those pages don't load this Admin-Panel-specific file.

// Display-only explanation of Code.gs's generateDefaultPassword() rule,
// shown in the Create modal so the Admin knows what to tell a new hire — the
// actual password is always computed and set server-side (see Code.gs) from
// the full name just entered in this form, never sent by this client.
const DEFAULT_PASSWORD_RULE_DISPLAY =
  'New accounts start with a default password generated from their name — the first letter of each of the first three name parts, uppercased, + "_123!" (e.g. "Abbasova Irina Vladimirovna" → AIV_123!). Change it later from this employee’s Edit screen if needed.';

// Shared by every entity's form: Full Name / Company / Job Title, in this
// order, before any role-specific fields — matches the Request Form's
// Section 1 field order (js/request-questions.js), since these are the
// same profile fields it auto-populates from.
const BASE_FIELDS = [
  { key: "full_name", label: "Full Name", type: "text", required: true },
  { key: "company", label: "Company", type: "text", required: false },
  { key: "job_title", label: "Job Title", type: "text", required: true },
];

const CONTACT_FIELDS = [
  { key: "email", label: "Mail", type: "email", required: true },
  { key: "password", label: "Password", type: "password", required: true },
];

const MANAGER_ORG_FIELDS = [
  { key: "division", label: "Division", type: "text", required: true },
  { key: "department", label: "Department", type: "text", required: true },
  { key: "subdepartment", label: "Subdepartment", type: "text", required: false },
  { key: "unit", label: "Unit", type: "text", required: false },
  { key: "subunit", label: "Subunit", type: "text", required: false },
];

const ADMIN_ENTITY_CONFIG = {
  Manager: {
    role: "Manager",
    table: "users",
    dbRole: "manager",
    label: "Managers",
    singular: "Manager",
    fields: BASE_FIELDS.concat(MANAGER_ORG_FIELDS, CONTACT_FIELDS),
    // Columns listEmployees() searches against (admin-api.js) — declared
    // here, not hardcoded in the query builder, so adding a searchable
    // field to an entity never means touching the data layer.
    searchableColumns: ["full_name", "job_title", "email", "division", "department"],
    filters: [
      { key: "division", label: "Division" },
      { key: "department", label: "Department" },
    ],
  },
  HRBP: {
    role: "HRBP",
    table: "users",
    dbRole: "hrbp",
    label: "HRBPs",
    singular: "HRBP",
    fields: BASE_FIELDS.concat(CONTACT_FIELDS),
    searchableColumns: ["full_name", "job_title", "email"],
    filters: [{ key: "job_title", label: "Job Title" }],
  },
  OD: {
    role: "OD",
    table: "users",
    dbRole: "od_team",
    label: "OD",
    singular: "OD",
    fields: BASE_FIELDS.concat(CONTACT_FIELDS),
    searchableColumns: ["full_name", "job_title", "email"],
    filters: [{ key: "job_title", label: "Job Title" }],
  },
};

// Columns shown in each entity's data table, in order. The "password"
// column never carries a real value (the app never stores or fetches one —
// see the note on PASSWORD_COLUMN below); type: "passwordToggle" tells
// admin-table.js to render the masked-value + eye-icon toggle cell instead
// of a plain text cell.
const PASSWORD_COLUMN = { key: "password", label: "Password", sortable: false, type: "passwordToggle" };
const STATUS_COLUMN = { key: "is_active", label: "Status", sortable: false };

const ADMIN_TABLE_COLUMNS = {
  Manager: [
    { key: "full_name", label: "Full Name", sortable: true },
    { key: "company", label: "Company", sortable: true },
    { key: "job_title", label: "Job Title", sortable: true },
    { key: "division", label: "Division", sortable: true },
    { key: "department", label: "Department", sortable: true },
    { key: "subdepartment", label: "Subdepartment", sortable: false },
    { key: "unit", label: "Unit", sortable: false },
    { key: "subunit", label: "Subunit", sortable: false },
    { key: "email", label: "Mail", sortable: true },
    PASSWORD_COLUMN,
    STATUS_COLUMN,
  ],
  HRBP: [
    { key: "full_name", label: "Full Name", sortable: true },
    { key: "company", label: "Company", sortable: true },
    { key: "job_title", label: "Job Title", sortable: true },
    { key: "email", label: "Mail", sortable: true },
    PASSWORD_COLUMN,
    STATUS_COLUMN,
  ],
  OD: [
    { key: "full_name", label: "Full Name", sortable: true },
    { key: "company", label: "Company", sortable: true },
    { key: "job_title", label: "Job Title", sortable: true },
    { key: "email", label: "Mail", sortable: true },
    PASSWORD_COLUMN,
    STATUS_COLUMN,
  ],
};
