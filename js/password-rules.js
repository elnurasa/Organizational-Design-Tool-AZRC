/**
 * password-rules.js
 * ---------------------------------------------------------------------------
 * Password rule checking — the one place that defines what "valid" means
 * for an Admin-set password, shared between the client-side check in
 * js/admin/admin-modal.js and the server-side re-check in
 * apps-script/Code.gs's checkPasswordRulesServer() (kept in sync
 * deliberately; never trust the client-side check alone).
 *
 * Rules:
 *   - Minimum length: 6 characters
 *   - At least one letter (upper or lower case)
 *   - At least one number
 *   - At least one special character
 *
 * Exposes:
 *   - checkPasswordRules(password)
 * ---------------------------------------------------------------------------
 */

/**
 * @param {string} password
 * @returns {{minLength: boolean, hasLetter: boolean, hasNumber: boolean,
 *            hasSpecial: boolean, allValid: boolean}}
 */
function checkPasswordRules(password) {
  const value = password || "";

  const rules = {
    minLength: value.length >= 6,
    hasLetter: /[a-zA-Z]/.test(value),
    hasNumber: /[0-9]/.test(value),
    hasSpecial: /[^a-zA-Z0-9]/.test(value),
  };

  rules.allValid = rules.minLength && rules.hasLetter && rules.hasNumber && rules.hasSpecial;

  return rules;
}
