/**
 * admin-modal.js
 * ---------------------------------------------------------------------------
 * One generic modal used for Create, Edit, View, and Delete-confirmation
 * across every Admin Panel section — driven by an ENTITY_CONFIG field list
 * (constants.js) rather than one modal per entity.
 *
 * Reuses validateEmail() (js/auth.js) and checkPasswordRules() (js/password-
 * rules.js) instead of re-implementing validation that already exists.
 * ---------------------------------------------------------------------------
 */

let _modalEscListener = null;

function getModalRoot() {
  let root = document.getElementById("modal-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "modal-root";
    document.body.appendChild(root);
  }
  return root;
}

function closeModal() {
  const root = getModalRoot();
  root.innerHTML = "";
  if (_modalEscListener) {
    document.removeEventListener("keydown", _modalEscListener);
    _modalEscListener = null;
  }
}

/**
 * Wraps a password <input> with a show/hide eye-icon toggle — this reveals
 * what the Admin is currently typing (a real, legitimate reveal, unlike the
 * table's Password column: see the note on buildPasswordToggleCell() in
 * admin-table.js for why an existing row's actual password can't be shown).
 *
 * @param {HTMLInputElement} input
 * @returns {HTMLElement}
 */
function buildPasswordInputWrap(input) {
  const wrap = document.createElement("div");
  wrap.className = "password-field-wrap";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "password-eye-toggle";
  toggle.setAttribute("aria-label", "Show password");
  toggle.setAttribute("aria-pressed", "false");
  toggle.textContent = "👁";

  toggle.addEventListener("click", () => {
    const isHidden = input.type === "password";
    input.type = isHidden ? "text" : "password";
    toggle.textContent = isHidden ? "🙈" : "👁";
    toggle.setAttribute("aria-label", isHidden ? "Hide password" : "Show password");
    toggle.setAttribute("aria-pressed", String(isHidden));
  });

  wrap.appendChild(input);
  wrap.appendChild(toggle);
  return wrap;
}

/**
 * @param {{
 *   title: string,
 *   fields: Array<{key: string, label: string, type: string, required: boolean}>,
 *   initialValues?: Record<string, string>,
 *   mode: "create" | "edit" | "view",
 *   submitLabel?: string,
 *   description?: string,
 *   onSubmit?: (values: Record<string, string>) => Promise<void>,
 * }} options
 */
function openFormModal(options) {
  const initialValues = options.initialValues || {};
  const root = getModalRoot();
  root.innerHTML = "";

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";

  const dialog = document.createElement("div");
  dialog.className = "modal-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");

  const header = document.createElement("div");
  header.className = "modal-header";
  const titleEl = document.createElement("h2");
  titleEl.textContent = options.title;
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "modal-close-button";
  closeButton.setAttribute("aria-label", "Close");
  closeButton.textContent = "×";
  closeButton.addEventListener("click", closeModal);
  header.appendChild(titleEl);
  header.appendChild(closeButton);
  dialog.appendChild(header);

  const body = document.createElement("div");
  body.className = "modal-body";

  if (options.description) {
    const description = document.createElement("p");
    description.className = "modal-description";
    description.textContent = options.description;
    body.appendChild(description);
  }

  const form = document.createElement("form");
  form.noValidate = true;
  form.id = "admin-modal-form-" + Date.now() + "-" + Math.floor(Math.random() * 1e6);

  const inputs = {}; // key -> { input, errorEl, field }

  options.fields.forEach((field) => {
    const group = document.createElement("div");
    group.className = "form-group";

    const label = document.createElement("label");
    label.textContent = field.label + (field.required && options.mode !== "view" ? " *" : "");
    group.appendChild(label);

    if (options.mode === "view") {
      const valueEl = document.createElement("p");
      valueEl.className = "view-field-value";
      const raw = initialValues[field.key];
      valueEl.textContent = raw === null || raw === undefined || raw === "" ? "—" : String(raw);
      group.appendChild(valueEl);
    } else {
      const input = document.createElement("input");
      input.type = field.type === "password" ? "password" : field.type || "text";
      input.name = field.key;
      input.autocomplete = field.type === "password" ? "new-password" : "off";

      if (field.type !== "password" && initialValues[field.key] !== undefined) {
        input.value = initialValues[field.key] || "";
      }
      if (field.type === "password" && options.mode === "edit") {
        input.placeholder = "Leave blank to keep unchanged";
      }

      const errorEl = document.createElement("p");
      errorEl.className = "field-error-text hidden";

      if (field.type === "password") {
        group.appendChild(buildPasswordInputWrap(input));
      } else {
        group.appendChild(input);
      }
      group.appendChild(errorEl);
      inputs[field.key] = { input, errorEl, field };
    }

    form.appendChild(group);
  });

  const formError = document.createElement("div");
  formError.className = "form-error-banner hidden";
  form.appendChild(formError);

  body.appendChild(form);
  dialog.appendChild(body);

  const footer = document.createElement("div");
  footer.className = "modal-footer";

  if (options.mode === "view") {
    const closeFooterButton = document.createElement("button");
    closeFooterButton.type = "button";
    closeFooterButton.className = "btn-secondary";
    closeFooterButton.textContent = "Close";
    closeFooterButton.addEventListener("click", closeModal);
    footer.appendChild(closeFooterButton);
  } else {
    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "btn-secondary";
    cancelButton.textContent = "Cancel";
    cancelButton.addEventListener("click", closeModal);

    const submitButton = document.createElement("button");
    submitButton.type = "submit";
    submitButton.setAttribute("form", form.id); // footer is a sibling of <form>, not a descendant — without this, clicking the button never fires the form's submit handler
    submitButton.className = "btn-primary";
    const submitLabel = options.submitLabel || "Save";
    submitButton.textContent = submitLabel;

    footer.appendChild(cancelButton);
    footer.appendChild(submitButton);

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      formError.classList.add("hidden");
      formError.textContent = "";
      Object.values(inputs).forEach(({ errorEl }) => errorEl.classList.add("hidden"));

      const values = {};
      let hasError = false;

      Object.entries(inputs).forEach(([key, { input, errorEl, field }]) => {
        const value = input.value.trim();
        const isBlankOptionalPassword = field.type === "password" && options.mode === "edit" && !value;

        if (field.required && !value && !isBlankOptionalPassword) {
          errorEl.textContent = field.label + " is required.";
          errorEl.classList.remove("hidden");
          hasError = true;
        } else if (field.type === "email" && value && !validateEmail(value)) {
          errorEl.textContent = "Enter a valid email address.";
          errorEl.classList.remove("hidden");
          hasError = true;
        } else if (field.type === "password" && value && !checkPasswordRules(value).allValid) {
          errorEl.textContent = "Must be 6+ characters with a letter, a number, and a special character.";
          errorEl.classList.remove("hidden");
          hasError = true;
        }

        if (!isBlankOptionalPassword) {
          values[key] = value;
        }
      });

      if (hasError) return;

      submitButton.disabled = true;
      submitButton.textContent = "Saving…";
      try {
        await options.onSubmit(values);
        closeModal();
      } catch (error) {
        formError.textContent = error.message || "Something went wrong. Please try again.";
        formError.classList.remove("hidden");
        submitButton.disabled = false;
        submitButton.textContent = submitLabel;
      }
    });
  }

  dialog.appendChild(footer);
  overlay.appendChild(dialog);
  root.appendChild(overlay);

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeModal();
  });

  _modalEscListener = (event) => {
    if (event.key === "Escape") closeModal();
  };
  document.addEventListener("keydown", _modalEscListener);

  const firstField = dialog.querySelector("input");
  if (firstField) firstField.focus();
}

/**
 * @param {{title: string, message: string, confirmLabel?: string,
 *   variant?: "danger" | "primary", onConfirm: () => Promise<void>}} options
 */
function openConfirmModal(options) {
  const root = getModalRoot();
  root.innerHTML = "";

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";

  const dialog = document.createElement("div");
  dialog.className = "modal-dialog modal-dialog-small";
  dialog.setAttribute("role", "alertdialog");
  dialog.setAttribute("aria-modal", "true");

  const header = document.createElement("div");
  header.className = "modal-header";
  const titleEl = document.createElement("h2");
  titleEl.textContent = options.title;
  header.appendChild(titleEl);
  dialog.appendChild(header);

  const body = document.createElement("div");
  body.className = "modal-body";
  const message = document.createElement("p");
  message.textContent = options.message;
  body.appendChild(message);

  const formError = document.createElement("div");
  formError.className = "form-error-banner hidden";
  body.appendChild(formError);
  dialog.appendChild(body);

  const footer = document.createElement("div");
  footer.className = "modal-footer";

  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "btn-secondary";
  cancelButton.textContent = "Cancel";
  cancelButton.addEventListener("click", closeModal);

  const confirmButton = document.createElement("button");
  confirmButton.type = "button";
  confirmButton.className = options.variant === "primary" ? "btn-primary" : "btn-danger";
  confirmButton.textContent = options.confirmLabel || "Delete";
  confirmButton.addEventListener("click", async () => {
    confirmButton.disabled = true;
    confirmButton.textContent = "Please wait…";
    try {
      await options.onConfirm();
      closeModal();
    } catch (error) {
      formError.textContent = error.message || "Something went wrong. Please try again.";
      formError.classList.remove("hidden");
      confirmButton.disabled = false;
      confirmButton.textContent = options.confirmLabel || "Delete";
    }
  });

  footer.appendChild(cancelButton);
  footer.appendChild(confirmButton);
  dialog.appendChild(footer);

  overlay.appendChild(dialog);
  root.appendChild(overlay);

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeModal();
  });

  _modalEscListener = (event) => {
    if (event.key === "Escape") closeModal();
  };
  document.addEventListener("keydown", _modalEscListener);

  confirmButton.focus();
}
