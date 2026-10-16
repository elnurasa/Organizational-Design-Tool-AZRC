/**
 * admin-toast.js
 * ---------------------------------------------------------------------------
 * Success/error toast notifications for the Admin Panel. Expects a
 * `<div id="toast-container">` in admin.html; creates it lazily if missing
 * so this file has no hard dependency on page structure.
 * ---------------------------------------------------------------------------
 */

const ADMIN_TOAST_DURATION_MS = 4000;

function getToastContainer() {
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    container.className = "toast-container";
    document.body.appendChild(container);
  }
  return container;
}

/**
 * @param {string} message
 * @param {"success" | "error"} [type]
 */
function showToast(message, type) {
  const container = getToastContainer();

  const toast = document.createElement("div");
  toast.className = "toast toast-" + (type || "success");
  toast.setAttribute("role", "status");
  toast.textContent = message; // textContent only — never render raw HTML here

  container.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add("toast-visible"));

  setTimeout(() => {
    toast.classList.remove("toast-visible");
    setTimeout(() => toast.remove(), 250);
  }, ADMIN_TOAST_DURATION_MS);
}

function showSuccessToast(message) {
  showToast(message, "success");
}

function showErrorToast(message) {
  showToast(message, "error");
}
