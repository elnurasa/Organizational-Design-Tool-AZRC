/**
 * hrbp-inbox.js
 * ---------------------------------------------------------------------------
 * Controller for hrbp.html — the HRBP's review inbox. Lists requests
 * assigned to the signed-in HRBP via js/request-service.js (mock-backed).
 * ---------------------------------------------------------------------------
 */

function initHrbpInboxPage() {
  guardPage("HRBP");

  const emailLabel = document.getElementById("user-email");
  if (emailLabel) emailLabel.textContent = getCurrentUser();

  document.getElementById("logout-button").addEventListener("click", logout);

  const container = document.getElementById("inbox-table-container");
  container.innerHTML = "";

  createDataTable(container, {
    columns: [
      { key: "request_number", label: "Request ID", sortable: false },
      { key: "requester_name", label: "Requester", sortable: false },
      { key: "category", label: "Category", sortable: false },
      { key: "status", label: "Status", sortable: false },
      { key: "submitted_at", label: "Submitted", sortable: false },
    ],
    searchPlaceholder: "Search inbox…",
    emptyMessage: "No requests assigned to you right now.",
    fetchPage: (params) => listHrbpInbox({ page: params.page, pageSize: params.pageSize, search: params.search }),
    // 'submitted' = the HRBP has not opened it yet (opening moves it to
    // 'hrbp_review'); such rows get a light "unread" marker (see css/workflow.css).
    rowClass: (row) => (row.status === "submitted" ? "row-unopened" : ""),
    renderCell: (row, column) => {
      if (column.key === "request_number") return formatRequestNumber(row);
      if (column.key === "category") return CATEGORY_LABELS[row.category] || row.category;
      if (column.key === "status") {
        // "New" reads friendlier than "HRBP Review" in the HRBP's own inbox, but
        // keeps the "submitted" badge colour (blue) rather than the generic
        // "info" one — info has meant the brand colour (now teal) since the
        // rebrand, and "New" is specifically a not-yet-reviewed status, not a
        // generic notice.
        if (row.status === "submitted") return { text: "New", badge: "submitted" };
        return buildStatusCellValue(row, STATUS_LABELS);
      }
      if (column.key === "submitted_at") return row.submitted_at ? formatDate(row.submitted_at) : "—";
      return row[column.key];
    },
    renderActions: (row) =>
      buildRowActions([
        {
          label: "Review",
          // "New" is explicitly the blue "submitted" badge (see renderCell
          // above), so its button is blue too — not the HRBP Review teal that
          // rowActionClassForStatus() would now give a 'submitted' request.
          className: row.status === "submitted" ? "row-action-status-submitted" : rowActionClassForStatus(row.status),
          onClick: () => {
            window.location.href = `hrbp-review.html?id=${encodeURIComponent(row.id)}`;
          },
        },
      ]),
  });
}
