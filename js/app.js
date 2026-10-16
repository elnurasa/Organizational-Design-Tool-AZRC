/**
 * app.js
 * ---------------------------------------------------------------------------
 * Application bootstrap / controller.
 *
 * Two responsibilities, split by page:
 *
 *   1. Login page (index.html):
 *        - initLoginPage() checks for an existing session and, if found,
 *          redirects straight to the correct page (so a logged-in user who
 *          reloads/revisits index.html never sees the login form again).
 *        - Runs a single-stage sign-in: email + password are collected and
 *          submitted together, verified via auth.js's loginWithPassword().
 *
 *   2. Every protected page (manager.html / hrbp.html / od.html /
 *      admin.html / create-request.html):
 *        - guardPage(expectedRole) ensures only a logged-in user with the
 *          matching role can view the page. No session at all sends them to
 *          Sign In; the wrong role sends them to the Unauthorized (403)
 *          page — never straight to "their" dashboard, since arriving here
 *          at all means either they aren't signed in or this genuinely
 *          isn't a page they're allowed on.
 * ---------------------------------------------------------------------------
 */

/**
 * Bootstraps the login page. Call this from index.html on DOMContentLoaded.
 */
function initLoginPage() {
  // If a valid session already exists, skip the login form entirely.
  const existingRole = getCurrentRole();
  if (existingRole) {
    redirectByRole(existingRole);
    return;
  }

  const form = document.getElementById("login-form");
  const emailInput = document.getElementById("email-input");
  const passwordInput = document.getElementById("password-input");
  const submitButton = document.getElementById("login-button");
  const buttonLabel = document.getElementById("login-button-label");
  const errorBox = document.getElementById("error-message");
  const emailError = document.getElementById("email-error");
  const passwordError = document.getElementById("password-error");
  const spinner = document.getElementById("loading-spinner");
  const successCheck = document.getElementById("success-check");

  if (!form) return; // Defensive: app.js may be reused elsewhere later.

  wirePasswordToggle("password-toggle", passwordInput);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    hideAllErrors();
    setLoading(true);

    try {
      const role = await loginWithPassword(emailInput.value, passwordInput.value);
      passwordInput.value = ""; // never leave the password sitting in the DOM
      setLoading(false);
      showSuccess();

      // Brief pause so the user sees the success state before navigating.
      setTimeout(() => redirectByRole(role), 500);
    } catch (error) {
      passwordInput.value = ""; // clear on failure too — force a fresh entry
      setLoading(false);
      routeError(error);
    }
  });

  function routeError(error) {
    const message = error.message || "Something went wrong. Please try again.";

    if (error.field === "email") {
      showFieldError(emailError, message);
    } else if (error.field === "password") {
      showFieldError(passwordError, message);
    } else {
      showError(message);
    }
  }

  function setLoading(isLoading) {
    submitButton.disabled = isLoading;
    spinner.classList.toggle("hidden", !isLoading);
    buttonLabel.classList.toggle("hidden", isLoading);
  }

  function showFieldError(el, message) {
    el.textContent = message;
    el.classList.remove("hidden");
  }

  function showError(message) {
    errorBox.textContent = message;
    errorBox.classList.remove("hidden");
    errorBox.classList.add("shake");
    setTimeout(() => errorBox.classList.remove("shake"), 400);
  }

  function hideAllErrors() {
    errorBox.textContent = "";
    errorBox.classList.add("hidden");
    emailError.textContent = "";
    emailError.classList.add("hidden");
    passwordError.textContent = "";
    passwordError.classList.add("hidden");
  }

  function showSuccess() {
    successCheck.classList.remove("hidden");
    successCheck.classList.add("visible");
  }
}

/**
 * Guards a role-specific page. Call this from every protected page on
 * DOMContentLoaded — manager.html/hrbp.html/od.html/admin.html all use
 * this exact same function (with their own role), and any future page
 * should too, rather than growing its own bespoke guard.
 *
 * - No session at all -> send to Sign In.
 * - "Admin" is checked as a PERMISSION (getIsAdmin()), not a primary role
 *   — Admin Panel access no longer requires the account's primary role to
 *   literally be "Admin"; an OD/HRBP/Manager account with Admin permission
 *   passes this check too, since Admin is additive (see js/auth.js's
 *   loginWithPassword() and the file header on js/dev-auth-provider.js).
 * - Any other expected role: session's primary role must match exactly.
 * - Either mismatch -> the Unauthorized (403) page. This deliberately does
 *   NOT redirect to the caller's own correct dashboard — reaching a page
 *   behind the wrong role/permission is treated as a denied access
 *   attempt, not a routing hint.
 *
 * @param {string} expectedRole - "Manager" | "HRBP" | "OD" | "Admin"
 */
function guardPage(expectedRole) {
  const role = getCurrentRole();

  if (!role) {
    window.location.href = "index.html";
    return;
  }

  const allowed = expectedRole === "Admin" ? getIsAdmin() : role === expectedRole;
  if (!allowed) {
    window.location.href = "unauthorized.html";
    return;
  }

  const emailLabel = document.getElementById("user-email");
  if (emailLabel) {
    emailLabel.textContent = getCurrentUser();
  }

  // Admin Panel button — shown on Manager/HRBP/OD dashboards (never on
  // admin.html itself) when the signed-in user also has Admin permission.
  // Requirement: non-admin users must never see this button.
  if (expectedRole !== "Admin") {
    const adminPanelLink = document.getElementById("admin-panel-link");
    if (adminPanelLink) {
      adminPanelLink.classList.toggle("hidden", !getIsAdmin());
    }
  }
}
