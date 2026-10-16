/**
 * od-inbox.js
 * ---------------------------------------------------------------------------
 * Controller for od.html — the OD team's final-review inbox. Lists every
 * request currently in od_review via js/request-service.js (mock-backed).
 * ---------------------------------------------------------------------------
 */

// In OD review and nobody on the OD team has opened it yet (od_opened_at,
// migration 0018). Strictly `=== null`: if 0018 isn't applied the column is
// missing (undefined) and nothing is highlighted rather than everything.
function isUnopenedForOd(row) {
  return row.status === "od_review" && row.od_opened_at === null;
}

function initOdInboxPage() {
  guardPage("OD");

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
      { key: "hrbp_name", label: "HRBP", sortable: false },
      { key: "submitted_at", label: "Submitted", sortable: false },
    ],
    searchPlaceholder: "Search inbox…",
    emptyMessage: "No requests awaiting OD review right now.",
    fetchPage: (params) => listOdInbox({ page: params.page, pageSize: params.pageSize, search: params.search }),
    rowClass: (row) => (isUnopenedForOd(row) ? "row-unopened" : ""),
    renderCell: (row, column) => {
      if (column.key === "request_number") return formatRequestNumber(row);
      if (column.key === "category") return CATEGORY_LABELS[row.category] || row.category;
      if (column.key === "status") {
        // Blue "New" for a request no OD member has opened yet (same blue as
        // the HRBP inbox's "New"); once opened it reads as the usual OD Review.
        if (isUnopenedForOd(row)) return { text: "New", badge: "submitted" };
        return buildStatusCellValue(row, STATUS_LABELS);
      }
      if (column.key === "requester_name") return row.requester_name;
      if (column.key === "submitted_at") return row.submitted_at ? formatDate(row.submitted_at) : "—";
      return row[column.key];
    },
    renderActions: (row) =>
      buildRowActions([
        {
          label: row.status === "od_review" ? "Review" : "View",
          className: isUnopenedForOd(row) ? "row-action-status-submitted" : rowActionClassForStatus(row.status),
          onClick: () => {
            window.location.href = `od-review.html?id=${encodeURIComponent(row.id)}`;
          },
        },
      ]),
  });
}
