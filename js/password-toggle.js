/**
 * password-toggle.js
 * ---------------------------------------------------------------------------
 * Wires a show/hide eye-icon button to a password input. Used by the Sign
 * In page (index.html) so its behavior stays consistent if reused
 * elsewhere.
 * ---------------------------------------------------------------------------
 */

/**
 * @param {string} toggleId - id of the toggle <button>.
 * @param {HTMLInputElement} input - the password input it controls.
 */
function wirePasswordToggle(toggleId, input) {
  const toggle = document.getElementById(toggleId);

  toggle.addEventListener("click", () => {
    const isPassword = input.type === "password";
    input.type = isPassword ? "text" : "password";
    toggle.setAttribute("aria-pressed", String(isPassword));
    toggle.setAttribute("aria-label", isPassword ? "Hide password" : "Show password");
    toggle.classList.toggle("is-visible", isPassword);
  });
}
