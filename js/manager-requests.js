/**
 * manager-requests.js
 * ---------------------------------------------------------------------------
 * Controller for manager.html — "My Requests". Lists the signed-in
 * Manager's own requests via js/request-service.js (mock-backed for now)
 * using the same generic createDataTable() component the Admin Panel uses.
 * ---------------------------------------------------------------------------
 */

function initManagerRequestsPage() {
  guardPage("Manager");

  const emailLabel = document.getElementById("user-email");
  if (emailLabel) emailLabel.textContent = getCurrentUser();

  document.getElementById("logout-button").addEventListener("click", logout);

  const container = document.getElementById("requests-table-container");
  container.innerHTML = "";

  const table = createDataTable(container, {
    columns: [
      { key: "request_number", label: "Request ID", sortable: false },
      { key: "category", label: "Category", sortable: false },
      { key: "status", label: "Status", sortable: false },
      { key: "submitted_at", label: "Submitted", sortable: false },
      { key: "hrbp_name", label: "Assigned HRBP", sortable: false },
    ],
    filters: [
      {
        key: "status",
        label: "Statuses",
        // 'submitted' and 'hrbp_review' read identically ("HRBP Review"), so
        // they are one option that matches both (listMyRequests takes a
        // comma-separated list).
        options: Object.keys(MANAGER_STATUS_LABELS)
          .filter((value) => value !== "submitted")
          .map((value) => ({
            value: value === "hrbp_review" ? "submitted,hrbp_review" : value,
            label: MANAGER_STATUS_LABELS[value],
          })),
      },
    ],
    searchPlaceholder: "Search my requests…",
    emptyMessage: 'No requests yet. Click "+ New Request" to create one.',
    fetchPage: (params) =>
      listMyRequests({
        page: params.page,
        pageSize: params.pageSize,
        search: params.search,
        status: params.filters.status,
      }),
    renderCell: (row, column) => {
      if (column.key === "request_number") return formatRequestNumber(row);
      if (column.key === "category") return CATEGORY_LABELS[row.category] || row.category;
      if (column.key === "status") return buildStatusCellValue(row, MANAGER_STATUS_LABELS);
      if (column.key === "submitted_at") return row.submitted_at ? formatDate(row.submitted_at) : "—";
      return row[column.key];
    },
    renderActions: (row) => {
      const actions = [
        {
          label: row.status === "draft" || row.status === "returned_to_requester" ? "Edit" : "View",
          className: rowActionClassForStatus(row.status),
          onClick: () => {
            window.location.href = `create-request.html?id=${encodeURIComponent(row.id)}`;
          },
        },
      ];
      if (row.status === "draft") {
        actions.push({
          label: "Delete",
          className: "row-action-danger",
          onClick: () =>
            openConfirmModal({
              title: "Delete Draft",
              message: `Delete this draft ${CATEGORY_LABELS[row.category] || "request"}? This cannot be undone.`,
              confirmLabel: "Delete",
              onConfirm: async () => {
                await deleteDraftRequest(row.id);
                showSuccessToast("Draft deleted.");
                table.refresh();
              },
            }),
        });
      }
      if (row.status === "returned_to_requester") {
        actions.push({
          label: "Withdraw",
          className: "row-action-danger",
          onClick: () =>
            openConfirmModal({
              title: "Withdraw Request",
              message: `Withdraw this ${CATEGORY_LABELS[row.category] || "request"}? It will be marked Withdrawn and can no longer be edited or resubmitted. This cannot be undone.`,
              confirmLabel: "Withdraw",
              onConfirm: async () => {
                await withdrawRequest(row.id);
                showSuccessToast("Request withdrawn.");
                table.refresh();
              },
            }),
        });
      }
      return buildRowActions(actions);
    },
  });
}
