/**
 * admin-table.js
 * ---------------------------------------------------------------------------
 * One generic, reusable data table engine — search box, filter dropdowns,
 * sortable sticky header, server-side pagination, loading/empty states —
 * shared by Managers, HRBPs, OD, and Admin Profiles. Each section only
 * supplies its columns and a fetchPage() function; this file never
 * hardcodes an entity.
 *
 * Hard rule: every user-supplied value is written with textContent, never
 * innerHTML, so nothing in a name/title/email can execute as markup.
 * ---------------------------------------------------------------------------
 */

// This component's own defaults — used as fallbacks by every page's
// fetchPage() implementation too (admin-api.js, request-service.js), so a
// page that wants a different page size just passes its own pageSize
// through options instead of overriding this global.
const ADMIN_PAGE_SIZE = 20;
const ADMIN_SEARCH_DEBOUNCE_MS = 300;

/**
 * @param {HTMLElement} containerEl
 * @param {{
 *   columns: Array<{key: string, label: string, sortable?: boolean}>,
 *   fetchPage: (params: {page: number, pageSize: number, search: string,
 *     filters: Record<string,string>, sortKey: string, sortAsc: boolean}) =>
 *     Promise<{rows: object[], totalCount: number}>,
 *   defaultSortKey?: string,
 *   filters?: Array<{key: string, label: string, options: string[]}>,
 *   searchPlaceholder?: string,
 *   emptyMessage?: string,
 *   renderCell?: (row: object, column: object) => string,
 *   renderActions?: (row: object) => HTMLElement | null,
 *   onAddClick?: () => void,
 *   addButtonLabel?: string,
 * }} options
 * @returns {{ refresh: () => void }}
 */
function createDataTable(containerEl, options) {
  const state = {
    page: 1,
    pageSize: ADMIN_PAGE_SIZE,
    search: "",
    filters: {},
    sortKey: options.defaultSortKey || options.columns[0].key,
    sortAsc: true,
    totalCount: 0,
    loading: false,
  };

  containerEl.innerHTML = ""; // one-time structural build, not user data
  containerEl.appendChild(buildToolbar());
  const tableWrap = document.createElement("div");
  tableWrap.className = "data-table-wrap";
  const table = document.createElement("table");
  table.className = "data-table";
  const thead = buildHead();
  const tbody = document.createElement("tbody");
  table.appendChild(thead);
  table.appendChild(tbody);
  tableWrap.appendChild(table);
  containerEl.appendChild(tableWrap);
  const footer = buildFooter();
  containerEl.appendChild(footer);

  function buildToolbar() {
    const toolbar = document.createElement("div");
    toolbar.className = "table-toolbar";

    const searchInput = document.createElement("input");
    searchInput.type = "search";
    searchInput.className = "table-search";
    searchInput.placeholder = options.searchPlaceholder || "Search…";
    let debounceHandle = null;
    searchInput.addEventListener("input", () => {
      clearTimeout(debounceHandle);
      debounceHandle = setTimeout(() => {
        state.search = searchInput.value;
        state.page = 1;
        load();
      }, ADMIN_SEARCH_DEBOUNCE_MS);
    });
    toolbar.appendChild(searchInput);

    (options.filters || []).forEach((filter) => {
      const select = document.createElement("select");
      select.className = "table-filter";
      const allOption = document.createElement("option");
      allOption.value = "";
      allOption.textContent = "All " + filter.label;
      select.appendChild(allOption);
      filter.options.forEach((entry) => {
        // Each entry is either a plain string (value === display text) or
        // a { value, label } pair — e.g. a status filter needs to filter by
        // the raw code ("approved") while showing a nicer label ("Approved").
        const option = document.createElement("option");
        option.value = typeof entry === "string" ? entry : entry.value;
        option.textContent = typeof entry === "string" ? entry : entry.label;
        select.appendChild(option);
      });
      select.addEventListener("change", () => {
        state.filters[filter.key] = select.value;
        state.page = 1;
        load();
      });
      toolbar.appendChild(select);
    });

    if (options.onAddClick) {
      const addButton = document.createElement("button");
      addButton.type = "button";
      addButton.className = "btn-primary table-add-button";
      addButton.textContent = options.addButtonLabel || "+ Add";
      addButton.addEventListener("click", options.onAddClick);
      toolbar.appendChild(addButton);
    }

    return toolbar;
  }

  function buildHead() {
    const thead = document.createElement("thead");
    const row = document.createElement("tr");

    const noHeader = document.createElement("th");
    noHeader.textContent = "No";
    row.appendChild(noHeader);

    options.columns.forEach((column) => {
      const th = document.createElement("th");
      th.textContent = column.label;
      if (column.sortable) {
        th.classList.add("sortable-header");
        th.addEventListener("click", () => {
          if (state.sortKey === column.key) {
            state.sortAsc = !state.sortAsc;
          } else {
            state.sortKey = column.key;
            state.sortAsc = true;
          }
          load();
        });
      }
      row.appendChild(th);
    });

    if (options.renderActions) {
      const actionsHeader = document.createElement("th");
      actionsHeader.textContent = "Actions";
      row.appendChild(actionsHeader);
    }

    thead.appendChild(row);
    thead.className = "sticky-table-head";
    return thead;
  }

  function refreshSortIndicators() {
    thead.querySelectorAll("th.sortable-header").forEach((th, index) => {
      const column = options.columns[index];
      th.classList.toggle("sort-active", column.key === state.sortKey);
      th.dataset.sortDir = column.key === state.sortKey ? (state.sortAsc ? "asc" : "desc") : "";
    });
  }

  function buildFooter() {
    const footer = document.createElement("div");
    footer.className = "table-footer";

    const summary = document.createElement("span");
    summary.className = "table-summary";
    footer.appendChild(summary);

    const pager = document.createElement("div");
    pager.className = "table-pager";

    const prevButton = document.createElement("button");
    prevButton.type = "button";
    prevButton.className = "btn-secondary";
    prevButton.textContent = "Previous";
    prevButton.addEventListener("click", () => {
      if (state.page > 1) {
        state.page -= 1;
        load();
      }
    });

    const pageLabel = document.createElement("span");
    pageLabel.className = "table-page-label";

    const nextButton = document.createElement("button");
    nextButton.type = "button";
    nextButton.className = "btn-secondary";
    nextButton.textContent = "Next";
    nextButton.addEventListener("click", () => {
      const totalPages = Math.max(1, Math.ceil(state.totalCount / state.pageSize));
      if (state.page < totalPages) {
        state.page += 1;
        load();
      }
    });

    pager.appendChild(prevButton);
    pager.appendChild(pageLabel);
    pager.appendChild(nextButton);
    footer.appendChild(pager);

    footer._summary = summary;
    footer._pageLabel = pageLabel;
    footer._prevButton = prevButton;
    footer._nextButton = nextButton;
    return footer;
  }

  function renderLoading() {
    tbody.innerHTML = "";
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = options.columns.length + 1 + (options.renderActions ? 1 : 0);
    cell.className = "table-loading-cell";
    cell.textContent = "Loading…";
    row.appendChild(cell);
    tbody.appendChild(row);
  }

  function renderEmpty() {
    tbody.innerHTML = "";
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = options.columns.length + 1 + (options.renderActions ? 1 : 0);
    cell.className = "table-empty-cell";

    const emptyState = document.createElement("div");
    emptyState.className = "empty-state";
    const icon = document.createElement("div");
    icon.className = "empty-state-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "\u{1F4ED}"; // empty inbox glyph — no image asset needed
    const message = document.createElement("p");
    message.textContent = options.emptyMessage || "No records found.";
    emptyState.appendChild(icon);
    emptyState.appendChild(message);
    cell.appendChild(emptyState);
    row.appendChild(cell);
    tbody.appendChild(row);
  }

  function renderRows(rows) {
    tbody.innerHTML = "";
    rows.forEach((row, index) => {
      const tr = document.createElement("tr");
      // Optional per-row styling hook (e.g. the inboxes' "not opened yet" rows).
      const extraClass = options.rowClass ? options.rowClass(row) : "";
      if (extraClass) tr.className = extraClass;

      const noCell = document.createElement("td");
      noCell.textContent = String((state.page - 1) * state.pageSize + index + 1);
      tr.appendChild(noCell);

      options.columns.forEach((column) => {
        const td = document.createElement("td");

        if (column.type === "passwordToggle") {
          td.appendChild(buildPasswordToggleCell(row.full_name));
          tr.appendChild(td);
          return;
        }

        const value = options.renderCell ? options.renderCell(row, column) : row[column.key];

        if (value && typeof value === "object" && "badge" in value) {
          // buildBadgeCell (js/workflow-shared.js) adds the small secondary
          // tag a status cell can carry (see buildStatusCellValue); it isn't
          // loaded on admin.html, which never needs that, so fall back to a
          // single plain badge there.
          if (typeof buildBadgeCell === "function") {
            td.appendChild(buildBadgeCell(value));
          } else {
            const badge = document.createElement("span");
            badge.className = "badge badge-" + value.badge;
            badge.textContent = value.text;
            td.appendChild(badge);
          }
        } else {
          td.textContent = value === null || value === undefined || value === "" ? "—" : String(value);
        }

        tr.appendChild(td);
      });

      if (options.renderActions) {
        const actionsCell = document.createElement("td");
        actionsCell.className = "table-actions-cell";
        const actionsEl = options.renderActions(row);
        if (actionsEl) actionsCell.appendChild(actionsEl);
        tr.appendChild(actionsCell);
      }

      tbody.appendChild(tr);
    });
  }

  function updateFooter() {
    const totalPages = Math.max(1, Math.ceil(state.totalCount / state.pageSize));
    footer._summary.textContent = state.totalCount === 0
      ? "0 records"
      : `Showing ${(state.page - 1) * state.pageSize + 1}–${Math.min(state.page * state.pageSize, state.totalCount)} of ${state.totalCount}`;
    footer._pageLabel.textContent = `Page ${state.page} of ${totalPages}`;
    footer._prevButton.disabled = state.page <= 1;
    footer._nextButton.disabled = state.page >= totalPages;
  }

  async function load() {
    state.loading = true;
    renderLoading();
    try {
      const { rows, totalCount } = await options.fetchPage({
        page: state.page,
        pageSize: state.pageSize,
        search: state.search,
        filters: state.filters,
        sortKey: state.sortKey,
        sortAsc: state.sortAsc,
      });
      state.totalCount = totalCount;
      refreshSortIndicators();
      updateFooter();
      if (rows.length === 0) {
        renderEmpty();
      } else {
        renderRows(rows);
      }
    } catch (error) {
      renderEmpty();
      showErrorToast(error.message || "Could not load records.");
    } finally {
      state.loading = false;
    }
  }

  load();

  return { refresh: load };
}

/**
 * Builds a small action-button element for a table row's Actions cell.
 * Kept here so every section's action bar looks/behaves identically.
 *
 * Every action button is disabled (and shows "…") for the duration of its
 * onClick — this covers both fast, synchronous actions (open a modal) and
 * slow, async ones (e.g. Admin Profiles' Edit, which fetches the full row
 * first) with the same guard against a double-click firing the action
 * twice. The button is only restored if it's still attached afterward,
 * since a refresh can replace the whole row out from under it.
 *
 * @param {Array<{label: string, className?: string, onClick: () => void | Promise<void>}>} actions
 * @returns {HTMLElement}
 */
function buildRowActions(actions) {
  const wrap = document.createElement("div");
  wrap.className = "row-actions";
  actions.forEach((action) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "row-action-button " + (action.className || "");
    button.textContent = action.label;
    button.addEventListener("click", async () => {
      if (button.disabled) return;
      const originalLabel = button.textContent;
      button.disabled = true;
      button.textContent = "…";
      try {
        await action.onClick();
      } finally {
        if (button.isConnected) {
          button.disabled = false;
          button.textContent = originalLabel;
        }
      }
    });
    wrap.appendChild(button);
  });
  return wrap;
}

/**
 * Mirrors Code.gs's generateDefaultPassword(): first letter of each of the
 * first three whitespace-separated name parts, uppercased, + "_123!" (e.g.
 * "Abbasova Irina Vladimirovna" -> "AIV_123!"). Parenthetical asides (a
 * former/maiden name some employees' full_name carries, e.g. "(ex.
 * Allahverdiyeva)") are stripped first so they never contribute an initial.
 *
 * @param {string} fullName
 * @returns {string}
 */
function computeDefaultPassword(fullName) {
  const withoutParens = String(fullName || "").replace(/\([^)]*\)/g, " ");
  const nameParts = withoutParens.split(/\s+/).filter(Boolean).slice(0, 3);
  const initials = nameParts.map((part) => part.charAt(0).toUpperCase()).join("");
  return initials + "_123!";
}

/**
 * Builds a Password cell with a per-row, independent show/hide toggle.
 *
 * IMPORTANT: this app never stores or fetches a real password anywhere —
 * Supabase Auth hashes it on creation and never returns it again, by
 * design (see apps-script/Code.gs's file header), and this project
 * deliberately never stores a plaintext password anywhere to work around
 * that. What CAN be shown honestly, with nothing new stored, is each
 * account's DEFAULT password — deterministic from full_name (see
 * computeDefaultPassword() above, mirroring Code.gs's server-side
 * generateDefaultPassword()), which is exactly what Supabase Auth was given
 * at account creation unless an Admin has since changed it via Edit. It's
 * labeled "Default", not "Current", for exactly that reason: if the
 * password WAS changed via Edit, this app has no way to know that or to
 * know the new value, so this cell would show the no-longer-accurate
 * original default rather than silently pretending to know the real one.
 *
 * @param {string} fullName
 * @returns {HTMLElement}
 */
function buildPasswordToggleCell(fullName) {
  const wrap = document.createElement("span");
  wrap.className = "password-cell";

  const valueEl = document.createElement("span");
  valueEl.className = "password-cell-value";
  valueEl.textContent = "••••••••";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "password-eye-toggle";
  toggle.setAttribute("aria-label", "Show password");
  toggle.setAttribute("aria-pressed", "false");
  toggle.textContent = "👁";

  let revealed = false;
  toggle.addEventListener("click", () => {
    revealed = !revealed;
    valueEl.textContent = revealed ? `Default: ${computeDefaultPassword(fullName)}` : "••••••••";
    valueEl.title = revealed
      ? "This is the account's original default password, computed from its name. If it was changed via Edit since, this will no longer match — this app never stores the real current password."
      : "";
    toggle.textContent = revealed ? "🙈" : "👁";
    toggle.setAttribute("aria-label", revealed ? "Hide password" : "Show password");
    toggle.setAttribute("aria-pressed", String(revealed));
  });

  wrap.appendChild(valueEl);
  wrap.appendChild(toggle);
  return wrap;
}
