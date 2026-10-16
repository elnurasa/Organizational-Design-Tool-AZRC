/**
 * admin-app.js
 * ---------------------------------------------------------------------------
 * Admin Panel bootstrap: sidebar navigation and the four section renderers
 * (Managers / HRBPs / OD / Admin Profiles), each built from the generic
 * createDataTable() + openFormModal()/openConfirmModal() components plus
 * ADMIN_ENTITY_CONFIG — no per-entity table/modal code.
 *
 * The page itself is guarded by guardPage("Admin") (js/app.js) — the exact
 * same route guard every other protected page uses, not a bespoke check —
 * since Sign In already resolved "Admin" as this account's role before a
 * session could even exist (see js/auth.js's loginWithPassword()).
 * ---------------------------------------------------------------------------
 */

// Labels the "Back to ___" button by the signed-in admin's own primary role
// — e.g. an OD team member with Admin permission sees "Back to OD Workspace",
// matching od.html's own purpose (view/review/manage/process OD requests).
const ROLE_WORKSPACE_LABEL = {
  Manager: "My Requests",
  HRBP: "HRBP Inbox",
  OD: "OD Workspace",
};

function wireSidebarNav() {
  document.querySelectorAll("[data-section]").forEach((button) => {
    button.addEventListener("click", () => {
      setActiveNavItem(button.dataset.section);
      renderSection(button.dataset.section);
    });
  });

  const accessesToggle = document.querySelector('[data-nav="accesses"]');
  const submenu = document.getElementById("accesses-submenu");
  if (accessesToggle && submenu) {
    accessesToggle.addEventListener("click", () => {
      const expanded = accessesToggle.getAttribute("aria-expanded") === "true";
      accessesToggle.setAttribute("aria-expanded", String(!expanded));
      submenu.classList.toggle("submenu-collapsed", expanded);
    });
  }
}

function setActiveNavItem(section) {
  document.querySelectorAll("[data-section]").forEach((button) => {
    button.classList.toggle("sidebar-submenu-item-active", button.dataset.section === section);
  });
}

function renderSection(section) {
  // renderEmployeeSection()/renderAdminProfilesSection() are async — wrapping
  // this in try/catch alone would only catch a SYNCHRONOUS throw, not a
  // rejected promise from later in the function. Routing every render
  // through Promise.resolve().catch() means any failure anywhere in a
  // section's render path surfaces as a toast instead of silently leaving
  // the sidebar highlighted with nothing changing underneath it.
  const renderResult = section === "AdminProfiles" ? renderAdminProfilesSection() : renderEmployeeSection(section);

  Promise.resolve(renderResult).catch((error) => {
    showErrorToast(error.message || "Could not open this section. Please try again.");
  });
}

// =============================================================================
// Managers / HRBPs / OD — one renderer, driven by ADMIN_ENTITY_CONFIG
// =============================================================================

async function renderEmployeeSection(role) {
  const config = ADMIN_ENTITY_CONFIG[role];
  const content = document.getElementById("admin-content");
  content.innerHTML = "";

  const heading = document.createElement("h1");
  heading.className = "content-heading";
  heading.textContent = config.label;
  content.appendChild(heading);

  const tableContainer = document.createElement("div");
  content.appendChild(tableContainer);

  let filterOptions = [];
  try {
    filterOptions = await Promise.all(
      (config.filters || []).map(async (filter) => ({
        key: filter.key,
        label: filter.label,
        options: await listFilterOptions(role, filter.key),
      }))
    );
  } catch (error) {
    showErrorToast(error.message || "Could not load filters.");
  }

  const table = createDataTable(tableContainer, {
    columns: ADMIN_TABLE_COLUMNS[role],
    filters: filterOptions,
    searchPlaceholder: `Search ${config.label.toLowerCase()}…`,
    emptyMessage: `No ${config.label.toLowerCase()} yet. Click "+ Add ${config.singular}" to create one.`,
    defaultSortKey: "full_name",
    fetchPage: (params) => listEmployees(role, params),
    renderCell: (row, column) =>
      column.key === "is_active"
        ? { text: row.is_active ? "Active" : "Inactive", badge: row.is_active ? "success" : "neutral" }
        : row[column.key],
    onAddClick: () => openCreateEmployeeModal(role, table),
    addButtonLabel: `+ Add ${config.singular}`,
    renderActions: (row) =>
      buildRowActions([
        { label: "View", onClick: () => openViewEmployeeModal(role, row) },
        { label: "Edit", onClick: () => openEditEmployeeModal(role, row, table) },
        {
          label: row.is_active ? "Deactivate" : "Activate",
          className: row.is_active ? "row-action-danger" : "row-action-primary",
          onClick: () => toggleEmployeeActive(role, row, table),
        },
        { label: "Delete", className: "row-action-danger", onClick: () => openDeleteEmployeeModal(role, row, table) },
      ]),
  });
}

function toggleEmployeeActive(role, row, table) {
  const activate = !row.is_active;
  openConfirmModal({
    title: activate ? "Activate" : "Deactivate",
    message: activate
      ? `Activate ${row.full_name}? They will be able to sign in again.`
      : `Deactivate ${row.full_name}? They will no longer be able to sign in, but their record is kept.`,
    confirmLabel: activate ? "Activate" : "Deactivate",
    variant: activate ? "primary" : "danger",
    onConfirm: async () => {
      await setEmployeeActive(role, row.id, activate);
      showSuccessToast(`${row.full_name} ${activate ? "activated" : "deactivated"}.`);
      table.refresh();
    },
  });
}

function openCreateEmployeeModal(role, table) {
  const config = ADMIN_ENTITY_CONFIG[role];
  // New accounts start with a per-employee default password generated
  // server-side from their name (set server-side — see Code.gs's
  // generateDefaultPassword()) instead of one the Admin types in here.
  const createFields = config.fields.filter((field) => field.type !== "password");
  openFormModal({
    title: `Add ${config.singular}`,
    fields: createFields,
    mode: "create",
    submitLabel: "Create",
    description: DEFAULT_PASSWORD_RULE_DISPLAY,
    onSubmit: async (values) => {
      await createEmployee(role, values);
      showSuccessToast(`${config.singular} created.`);
      table.refresh();
    },
  });
}

function openEditEmployeeModal(role, row, table) {
  const config = ADMIN_ENTITY_CONFIG[role];
  openFormModal({
    title: `Edit ${config.singular}`,
    fields: config.fields,
    initialValues: row,
    mode: "edit",
    submitLabel: "Save Changes",
    onSubmit: async (values) => {
      await updateEmployee(role, row.id, values);
      showSuccessToast(`${config.singular} updated.`);
      table.refresh();
    },
  });
}

function openViewEmployeeModal(role, row) {
  const config = ADMIN_ENTITY_CONFIG[role];
  const viewFields = config.fields.filter((field) => field.type !== "password");
  openFormModal({
    title: `${config.singular} Details`,
    fields: viewFields,
    initialValues: row,
    mode: "view",
  });
}

function openDeleteEmployeeModal(role, row, table) {
  const config = ADMIN_ENTITY_CONFIG[role];
  openConfirmModal({
    title: `Delete ${config.singular}`,
    message: `Delete ${row.full_name}? This also removes their sign-in access immediately. This cannot be undone.`,
    confirmLabel: "Delete",
    onConfirm: async () => {
      await deleteEmployee(role, row.id);
      showSuccessToast(`${config.singular} deleted.`);
      table.refresh();
    },
  });
}

// =============================================================================
// Admin Profiles
// =============================================================================

async function renderAdminProfilesSection() {
  const content = document.getElementById("admin-content");
  content.innerHTML = "";

  const heading = document.createElement("h1");
  heading.className = "content-heading";
  heading.textContent = "Admin Profiles";
  content.appendChild(heading);

  const tableContainer = document.createElement("div");
  content.appendChild(tableContainer);

  const table = createDataTable(tableContainer, {
    columns: [
      { key: "full_name", label: "Full Name" },
      { key: "job_title", label: "Job Title" },
      { key: "email", label: "Mail" },
      { key: "is_admin", label: "Admin Status" },
    ],
    searchPlaceholder: "Search employees…",
    emptyMessage: "No employees found.",
    fetchPage: (params) => listAdminProfiles(params),
    renderCell: (row, column) =>
      column.key === "is_admin"
        ? { text: row.is_admin ? "Admin" : "Standard User", badge: row.is_admin ? "success" : "neutral" }
        : row[column.key],
    renderActions: (row) =>
      buildRowActions([
        {
          label: row.is_admin ? "Remove Admin" : "Grant Admin",
          className: row.is_admin ? "row-action-danger" : "row-action-primary",
          onClick: () => toggleAdminPermission(row, table),
        },
        { label: "Edit", onClick: () => openEditFromAdminProfiles(row, table) },
        {
          label: "Delete",
          className: "row-action-danger",
          onClick: () => openDeleteEmployeeModal(row.role, row, table),
        },
      ]),
  });
}

/**
 * The Admin Profiles view's rows come from the admin_all_employees UNION
 * view, which only carries the fields common to every role (not a
 * Manager's Division/Department/etc.) — fetch the full row before opening
 * Edit so nothing appears blank/gets accidentally cleared on save.
 */
async function openEditFromAdminProfiles(row, table) {
  try {
    const fullRow = await getEmployeeById(row.role, row.id);
    openEditEmployeeModal(row.role, fullRow, table);
  } catch (error) {
    showErrorToast(error.message || "Could not load this employee.");
  }
}

function toggleAdminPermission(row, table) {
  const grantAdmin = !row.is_admin;
  openConfirmModal({
    title: grantAdmin ? "Grant Admin" : "Remove Admin",
    message: `${grantAdmin ? "Grant" : "Remove"} Admin permission ${grantAdmin ? "to" : "from"} ${row.full_name}?`,
    confirmLabel: grantAdmin ? "Grant Admin" : "Remove Admin",
    variant: grantAdmin ? "primary" : "danger",
    onConfirm: async () => {
      await setAdminPermission(row.id, grantAdmin);
      showSuccessToast(`Admin permission ${grantAdmin ? "granted" : "removed"}.`);
      table.refresh();
    },
  });
}

// =============================================================================
// Bootstrap
// =============================================================================

function initAdminPanel() {
  guardPage("Admin"); // same route guard every protected page uses (app.js)
  if (!getIsAdmin()) return; // guardPage() is redirecting away

  wireSidebarNav();
  setActiveNavItem("Manager");
  renderSection("Manager");

  const logoutButton = document.getElementById("logout-button");
  if (logoutButton) logoutButton.addEventListener("click", logout);

  // Requirement: Admin users must be able to return to their primary
  // dashboard from the Admin Panel. Only shown when the signed-in account
  // actually has a primary Manager/HRBP/OD role — a dev-mode account with
  // no primary role at all (role === "Admin" itself) has nowhere to
  // "return" to, so the button stays hidden for that edge case. Label
  // matches the destination page, e.g. "Back to OD Workspace" for OD.
  const backButton = document.getElementById("back-to-dashboard-link");
  const primaryRole = getCurrentRole();
  const dashboardTarget = primaryRole !== "Admin" ? ROLE_REDIRECT_MAP[primaryRole] : null;
  if (backButton && dashboardTarget) {
    backButton.textContent = "Back to " + (ROLE_WORKSPACE_LABEL[primaryRole] || "My Dashboard");
    backButton.href = dashboardTarget;
    backButton.classList.remove("hidden");
  }
}
