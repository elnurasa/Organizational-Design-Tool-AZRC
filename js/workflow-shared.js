/**
 * workflow-shared.js
 * ---------------------------------------------------------------------------
 * Small presentational helpers shared by every Structural Change Request
 * page (manager's list + form, HRBP/OD inboxes + review pages) — pulled out
 * here instead of copy-pasted into each controller.
 * ---------------------------------------------------------------------------
 */

/**
 * @param {string} isoString
 * @returns {string} e.g. "Jul 21, 2026"
 */
function formatDate(isoString) {
  try {
    return new Date(isoString).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  } catch (error) {
    return isoString;
  }
}

/**
 * @param {string} isoString
 * @returns {string} e.g. "Jul 21, 2026, 2:05 PM"
 */
function formatDateTime(isoString) {
  try {
    return new Date(isoString).toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch (error) {
    return isoString;
  }
}

/**
 * The short, human-friendly request identifier shown in every table and in
 * the exported PDF: "ORG-0001" (request_number, added by
 * supabase/migrations/0011) instead of the 36-character UUID primary key.
 * Falls back to the first 8 characters of the UUID if a row has no number
 * yet (e.g. the migration hasn't been applied), so nothing renders blank.
 *
 * @param {{request_number?: number, id?: string}} request
 * @returns {string} e.g. "ORG-0007"
 */
function formatRequestNumber(request) {
  if (request && request.request_number != null) {
    return "ORG-" + String(request.request_number).padStart(4, "0");
  }
  return request && request.id ? String(request.id).slice(0, 8) : "—";
}

const HISTORY_ACTION_DESCRIPTIONS = {
  created: "created this request as a draft",
  submitted: "submitted this request",
  opened: "started reviewing this request",
  forwarded_to_od: "forwarded this request to OD",
  returned_to_requester: "returned this request to the requester",
  return_to_hrbp: "returned this request to HRBP",
  approve: "approved this request",
  reject: "rejected this request",
  withdrawn: "withdrew this request",
};

/**
 * @param {{action: string}} entry
 * @returns {string}
 */
function describeHistoryAction(entry) {
  return HISTORY_ACTION_DESCRIPTIONS[entry.action] || entry.action;
}

// The two actions that hand a request between HRBP and OD without it ever
// reaching the requester. The requester may see that these happened (the
// request's status already says "Returned to HRBP" / "OD Review"), but not
// what was said — that comment is HRBP and OD talking to each other, not to
// the requester. HRBP's and OD's own pages keep full, unredacted history.
const REVIEWER_INTERNAL_HISTORY_ACTIONS = ["forwarded_to_od", "return_to_hrbp"];

/**
 * The requester-safe version of a request's Approval Trail: the same rows,
 * in the same order, with the comment removed from any HRBP<->OD handoff.
 * Used only by create-request.js (the requester's own view of their
 * request) — never by the HRBP/OD review pages.
 *
 * @param {Array<object>} history
 * @returns {Array<object>}
 */
function historyForRequester(history) {
  return (history || []).map((entry) =>
    REVIEWER_INTERNAL_HISTORY_ACTIONS.indexOf(entry.action) === -1 ? entry : Object.assign({}, entry, { comment: null })
  );
}

/**
 * The requester-safe version of a request's per-round verdict_history (see
 * groupVerdictHistoryByQuestion): only rounds HRBP actually sent back to the
 * requester (outcome "returned_to_requester"). A round HRBP instead forwarded
 * on to OD (outcome "od_review") — even one where an answer was marked
 * insufficient — was never addressed to the requester, so it's left out. So is
 * every OD round (outcomes returned_to_hrbp / rejected / approved): OD talks to
 * HRBP, never to the requester. The database already refuses to return OD
 * rounds to a requester (od_verdict_history's read policy, migration 0014);
 * this keeps the page correct on its own too.
 * Used only by create-request.js.
 *
 * @param {Array<object>} rounds
 * @returns {Array<object>}
 */
function verdictHistoryForRequester(rounds) {
  return (rounds || []).filter((round) => round.actor !== "OD" && round.outcome === "returned_to_requester");
}

/**
 * @param {string} text
 * @returns {HTMLElement}
 */
function buildReviewSectionTitle(text) {
  const h3 = document.createElement("h3");
  h3.className = "review-section-title";
  h3.textContent = text;
  return h3;
}

/**
 * @param {string} label
 * @param {string} value
 * @returns {HTMLElement}
 */
function buildReadOnlyKeyValue(label, value) {
  const field = document.createElement("div");
  field.className = "info-field";
  const labelEl = document.createElement("label");
  labelEl.textContent = label;
  const valueEl = document.createElement("p");
  valueEl.className = "readonly-value";
  valueEl.textContent = value || "—";
  field.appendChild(labelEl);
  field.appendChild(valueEl);
  return field;
}

/**
 * @param {string} label
 * @param {string} value
 * @returns {HTMLElement}
 */
function buildReadOnlyParagraph(label, value) {
  const wrap = document.createElement("div");
  wrap.className = "readonly-paragraph";
  const labelEl = document.createElement("p");
  labelEl.className = "readonly-paragraph-label";
  labelEl.textContent = label;
  const valueEl = document.createElement("p");
  valueEl.className = "readonly-paragraph-value";
  valueEl.textContent = value || "—";
  wrap.appendChild(labelEl);
  wrap.appendChild(valueEl);
  return wrap;
}

/**
 * A read-only "HRBP: Sufficient" / "OD: Insufficient" badge + optional
 * comment, used wherever a verdict is being displayed rather than set.
 *
 * @param {"HRBP" | "OD"} actor
 * @param {"sufficient" | "insufficient"} verdict
 * @param {string} [comment]
 * @returns {HTMLElement}
 */
function buildReadOnlyVerdictRow(actor, verdict, comment) {
  const wrap = document.createElement("div");
  wrap.className = "verdict-row";
  const badge = document.createElement("span");
  badge.className = "verdict-readonly-badge " + (verdict === "sufficient" ? "badge-success" : "badge-danger");
  badge.textContent = `${actor}: ${verdict === "sufficient" ? "Sufficient" : "Insufficient"}`;
  wrap.appendChild(badge);
  if (comment) {
    const commentEl = document.createElement("span");
    commentEl.textContent = comment;
    commentEl.style.fontSize = "13px";
    commentEl.style.color = "var(--color-text-muted)";
    wrap.appendChild(commentEl);
  }
  return wrap;
}

/**
 * Status cell content for a request row/detail page: the main lifecycle
 * badge (STATUS_BADGE_VARIANT), plus a small "After OD review" tag when the
 * request has already been through OD at least once (requests.od_reviewed —
 * set permanently true the first time a request reaches od_review, see
 * enforce_request_transition() in supabase/migrations/0003) and is
 * currently back with the requester. Without this, "Returned to Requester"
 * looks identical whether it's a first-round HRBP return or a return after
 * a full HRBP -> OD -> HRBP loop — a real difference the requester and HRBP
 * both need at a glance. Every other status is already unambiguous on its
 * own (e.g. "Returned to HRBP" only ever means OD just sent it back) and
 * gets no tag.
 *
 * @param {{status: string, od_reviewed?: boolean}} row
 * @param {Record<string, string>} labels STATUS_LABELS or MANAGER_STATUS_LABELS
 * @returns {{text: string, badge: string, secondaryText?: string}}
 */
function buildStatusCellValue(row, labels) {
  const value = { text: labels[row.status] || row.status, badge: STATUS_BADGE_VARIANT[row.status] };
  if (row.status === "returned_to_requester" && row.od_reviewed) {
    value.secondaryText = "After OD review";
  }
  return value;
}

/**
 * The colour class for a table row's primary action button (View / Edit /
 * Review), matching the colour of that same row's Status badge
 * (STATUS_BADGE_VARIANT / the "row-action-status-*" rules in admin.css) so
 * the Status and Actions columns read as one glance instead of the Actions
 * column being a flat, unrelated colour: approved rows' action is green,
 * rejected red, a brand-new submission blue, and so on.
 *
 * Secondary, destructive row actions (Delete, Withdraw) are left with their
 * own fixed "row-action-danger" red regardless of status — that colour is
 * warning about the action itself (it's irreversible), not describing the
 * request's current state, so it doesn't change here.
 *
 * @param {string} status
 * @returns {string}
 */
function rowActionClassForStatus(status) {
  return "row-action-status-" + (STATUS_BADGE_VARIANT[status] || "draft");
}

/**
 * Builds a table-cell-ready badge, with an optional small secondary tag
 * beside it (see buildStatusCellValue()) — the one place that turns a
 * {text, badge, secondaryText?} value into DOM, shared by admin-table.js's
 * generic cell renderer and buildReviewMetaBar() below so both look and
 * behave identically.
 *
 * @param {{text: string, badge: string, secondaryText?: string}} value
 * @returns {HTMLElement}
 */
function buildBadgeCell(value) {
  const wrap = document.createElement("span");
  wrap.className = "badge-cell";

  const badge = document.createElement("span");
  badge.className = "badge badge-" + value.badge;
  badge.textContent = value.text;
  wrap.appendChild(badge);

  if (value.secondaryText) {
    const secondary = document.createElement("span");
    secondary.className = "badge-secondary-tag";
    secondary.textContent = value.secondaryText;
    wrap.appendChild(secondary);
  }

  return wrap;
}

/**
 * Renders the shared "meta bar" (status / requester / HRBP / submitted /
 * effective date) at the top of a review or view-mode page.
 *
 * @param {object} request
 * @param {Record<string, string>} [labels] STATUS_LABELS by default — pass
 *   MANAGER_STATUS_LABELS on the requester's own view mode.
 * @returns {HTMLElement}
 */
function buildReviewMetaBar(request, labels) {
  const metaBar = document.createElement("div");
  metaBar.className = "review-meta-bar";

  const statusItem = document.createElement("div");
  statusItem.className = "review-meta-item";
  const statusLabelEl = document.createElement("span");
  statusLabelEl.className = "review-meta-label";
  statusLabelEl.textContent = "Status";
  statusItem.appendChild(statusLabelEl);
  statusItem.appendChild(buildBadgeCell(buildStatusCellValue(request, labels || STATUS_LABELS)));
  metaBar.appendChild(statusItem);

  [
    ["Requester", request.requester_name],
    ["Assigned HRBP", request.hrbp_name],
    ["Submitted", request.submitted_at ? formatDate(request.submitted_at) : "Not yet submitted"],
    ["Requested Effective Date", request.requested_effective_date || "—"],
  ].forEach(([label, value]) => {
    const item = document.createElement("div");
    item.className = "review-meta-item";
    const labelEl = document.createElement("span");
    labelEl.className = "review-meta-label";
    labelEl.textContent = label;
    const valueEl = document.createElement("span");
    valueEl.textContent = value;
    item.appendChild(labelEl);
    item.appendChild(valueEl);
    metaBar.appendChild(item);
  });
  return metaBar;
}

/**
 * A multi-select option picker for questions that offer predefined options:
 *
 *   1. a searchable dropdown — type to filter, click (or Enter) to tick and
 *      untick as many options as needed; the list stays open while picking;
 *   2. a "selected" field directly below it, showing each pick as a chip with
 *      a remove button;
 *
 * The free-text description field is NOT part of this component — the caller
 * puts its own textarea after it, so the picks and the description are
 * separate pieces of data.
 *
 * @param {string[]} options
 * @param {{
 *   selected?: string[],
 *   placeholder?: string,
 *   onChange: (selected: string[]) => void
 * }} config
 * @returns {HTMLElement}
 */
function buildOptionPicker(options, config) {
  let selected = (config.selected || []).slice();
  let activeIndex = -1;
  let visibleOptions = options.slice();
  const listId = "option-list-" + Math.random().toString(36).slice(2, 9);

  const wrap = document.createElement("div");
  wrap.className = "option-picker";

  // ----- 1. search / select field -----
  const searchCaption = document.createElement("p");
  searchCaption.className = "field-caption";
  searchCaption.textContent = "Choose from the options (you can select more than one)";
  wrap.appendChild(searchCaption);

  const searchWrap = document.createElement("div");
  searchWrap.className = "option-picker-search";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "option-picker-input";
  input.placeholder = config.placeholder || "Search and select options…";
  input.autocomplete = "off";
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-controls", listId);
  input.setAttribute("aria-autocomplete", "list");
  searchWrap.appendChild(input);

  const caret = document.createElement("span");
  caret.className = "option-picker-caret";
  caret.setAttribute("aria-hidden", "true");
  searchWrap.appendChild(caret);

  const list = document.createElement("ul");
  list.className = "option-picker-list hidden";
  list.id = listId;
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-multiselectable", "true");
  searchWrap.appendChild(list);

  wrap.appendChild(searchWrap);

  // ----- 2. selected options field -----
  const chipsCaption = document.createElement("p");
  chipsCaption.className = "field-caption field-caption-spaced";
  wrap.appendChild(chipsCaption);

  const chipsBox = document.createElement("div");
  chipsBox.className = "option-chips";
  chipsBox.setAttribute("aria-live", "polite");
  wrap.appendChild(chipsBox);

  function notify() {
    config.onChange(selected.slice());
  }

  function isSelected(option) {
    return selected.indexOf(option) !== -1;
  }

  function toggle(option) {
    selected = isSelected(option) ? selected.filter((item) => item !== option) : selected.concat(option);
    renderChips();
    renderList();
    notify();
  }

  function renderChips() {
    chipsCaption.textContent = selected.length > 0 ? `Selected options (${selected.length})` : "Selected options";
    chipsBox.innerHTML = "";

    if (selected.length === 0) {
      const empty = document.createElement("span");
      empty.className = "option-chips-placeholder";
      empty.textContent = "No options selected yet";
      chipsBox.appendChild(empty);
      return;
    }

    selected.forEach((option) => {
      const chip = document.createElement("span");
      chip.className = "option-chip";

      const label = document.createElement("span");
      label.textContent = option;
      chip.appendChild(label);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "option-chip-remove";
      remove.setAttribute("aria-label", "Remove " + option);
      remove.textContent = "×";
      remove.addEventListener("click", () => toggle(option));
      chip.appendChild(remove);

      chipsBox.appendChild(chip);
    });
  }

  function renderList() {
    const query = input.value.trim().toLowerCase();
    visibleOptions = query ? options.filter((option) => option.toLowerCase().includes(query)) : options.slice();
    if (activeIndex >= visibleOptions.length) activeIndex = visibleOptions.length - 1;
    list.innerHTML = "";

    if (visibleOptions.length === 0) {
      const empty = document.createElement("li");
      empty.className = "option-picker-empty";
      empty.textContent = "No matching options";
      list.appendChild(empty);
      return;
    }

    visibleOptions.forEach((option, index) => {
      const item = document.createElement("li");
      item.className = "option-picker-option";
      item.setAttribute("role", "option");
      const picked = isSelected(option);
      item.setAttribute("aria-selected", String(picked));
      if (picked) item.classList.add("is-selected");
      if (index === activeIndex) item.classList.add("is-active");

      const box = document.createElement("span");
      box.className = "option-check";
      box.setAttribute("aria-hidden", "true");
      item.appendChild(box);

      const text = document.createElement("span");
      text.textContent = option;
      item.appendChild(text);

      // mousedown (not click) fires before the input's blur closes the list,
      // so the pick registers and the input keeps focus for further picks.
      item.addEventListener("mousedown", (event) => {
        event.preventDefault();
        toggle(option);
      });
      list.appendChild(item);
    });
  }

  function openList() {
    renderList();
    list.classList.remove("hidden");
    input.setAttribute("aria-expanded", "true");
    searchWrap.classList.add("is-open");
  }

  function closeList() {
    list.classList.add("hidden");
    input.setAttribute("aria-expanded", "false");
    searchWrap.classList.remove("is-open");
    activeIndex = -1;
  }

  input.addEventListener("focus", openList);
  input.addEventListener("click", () => {
    if (list.classList.contains("hidden")) openList();
  });
  input.addEventListener("input", () => {
    activeIndex = -1;
    if (list.classList.contains("hidden")) openList();
    else renderList();
  });
  input.addEventListener("blur", () => {
    setTimeout(closeList, 120); // let a pending option mousedown register first
  });
  caret.addEventListener("mousedown", (event) => {
    event.preventDefault();
    if (list.classList.contains("hidden")) {
      input.focus();
    } else {
      closeList();
    }
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (list.classList.contains("hidden")) openList();
      if (visibleOptions.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      activeIndex = (activeIndex + step + visibleOptions.length) % visibleOptions.length;
      renderList();
      const activeItem = list.querySelector(".is-active");
      if (activeItem) activeItem.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter") {
      // Never let Enter submit or advance the surrounding form.
      event.preventDefault();
      if (activeIndex >= 0 && visibleOptions[activeIndex] !== undefined) toggle(visibleOptions[activeIndex]);
    } else if (event.key === "Escape") {
      closeList();
      input.blur();
    } else if (event.key === "Backspace" && input.value === "" && selected.length > 0) {
      toggle(selected[selected.length - 1]);
    }
  });

  renderChips();
  return wrap;
}

/**
 * Read-only chips for a list of selected options — the display counterpart of
 * the picker's "selected options" field, used on the review step, the
 * requester's view mode, the HRBP/OD review pages.
 *
 * @param {string[]} options
 * @returns {HTMLElement}
 */
function buildAnswerChips(options) {
  const row = document.createElement("span");
  row.className = "answer-chips";
  options.forEach((option) => {
    const chip = document.createElement("span");
    chip.className = "option-chip option-chip-readonly";
    chip.textContent = option;
    row.appendChild(chip);
  });
  return row;
}

/**
 * Fills an element with one answer's content: its selected options as chips,
 * then its free-text description. Shows an em dash if it has neither.
 * Older answers (saved before options were stored separately) simply have no
 * selected options and render as plain text, exactly as before.
 *
 * @param {HTMLElement} el
 * @param {{answer?: string, selected_options?: string[]}} answer
 */
function fillAnswerContent(el, answer) {
  el.textContent = "";
  const options = (answer && answer.selected_options) || [];
  const text = ((answer && answer.answer) || "").trim();

  if (options.length === 0 && !text) {
    el.textContent = "—";
    return;
  }
  if (options.length > 0) el.appendChild(buildAnswerChips(options));
  if (text) {
    const description = document.createElement("span");
    description.className = "answer-description";
    description.textContent = text;
    el.appendChild(description);
  }
}

/**
 * Plain-text form of an answer for places that can't render chips (the PDF).
 *
 * @param {{answer?: string, selected_options?: string[]}} answer
 * @returns {string}
 */
function formatAnswerPlainText(answer) {
  const options = (answer && answer.selected_options) || [];
  const text = ((answer && answer.answer) || "").trim();
  const parts = [];
  if (options.length > 0) parts.push("Selected: " + options.join("; "));
  if (text) parts.push(text);
  return parts.length > 0 ? parts.join("\n") : "—";
}

/**
 * A labelled read-only answer for the requester's review step: same look as
 * buildReadOnlyParagraph, but showing options as chips plus the description.
 *
 * @param {string} label
 * @param {{answer?: string, selected_options?: string[]}} answer
 * @returns {HTMLElement}
 */
function buildReadOnlyAnswer(label, answer) {
  const wrap = document.createElement("div");
  wrap.className = "readonly-paragraph";
  const labelEl = document.createElement("p");
  labelEl.className = "readonly-paragraph-label";
  labelEl.textContent = label;
  const valueEl = document.createElement("p");
  valueEl.className = "readonly-paragraph-value";
  fillAnswerContent(valueEl, answer);
  wrap.appendChild(labelEl);
  wrap.appendChild(valueEl);
  return wrap;
}

/**
 * Renders the shared "Approval Trail" card from a request's history array.
 *
 * @param {Array<object>} history
 * @returns {HTMLElement}
 */
function buildApprovalTrailCard(history) {
  const card = document.createElement("section");
  card.className = "card";
  card.appendChild(buildReviewSectionTitle("Approval Trail"));

  const list = document.createElement("div");
  list.className = "history-list";
  history.forEach((entry) => {
    const row = document.createElement("div");
    row.className = "history-row";
    const text = document.createElement("p");
    text.textContent = `${entry.actor_name} — ${describeHistoryAction(entry)}`;
    const time = document.createElement("span");
    time.className = "history-time";
    time.textContent = formatDateTime(entry.created_at);
    row.appendChild(text);
    row.appendChild(time);
    if (entry.comment) {
      const comment = document.createElement("p");
      comment.className = "history-comment";
      comment.textContent = `"${entry.comment}"`;
      row.appendChild(comment);
    }
    list.appendChild(row);
  });
  card.appendChild(list);
  return card;
}


// Where a reviewer's insufficient round went, by who made it. HRBP rounds end
// in returned_to_requester / od_review (hrbp_verdict_history, 0013); OD rounds
// in returned_to_hrbp / rejected / approved (od_verdict_history, 0014).
const VERDICT_OUTCOME_LABELS = {
  returned_to_requester: "Returned to requester",
  od_review: "Forwarded to OD",
  returned_to_hrbp: "Returned to HRBP",
  rejected: "Rejected",
  approved: "Approved",
};

const VERDICT_OUTCOME_BADGE = {
  returned_to_requester: "warning",
  od_review: "info",
  returned_to_hrbp: "returned-hrbp",
  rejected: "danger",
  approved: "success",
};

/**
 * Re-indexes a request's per-round insufficient-verdict history (the
 * `verdict_history` array from getRequestById — HRBP rounds from
 * hrbp_verdict_history, migration 0013, and OD rounds from od_verdict_history,
 * migration 0014) by question instead of by round. Same source rows, just
 * grouped so each question can show its own history where it's actually
 * asked, instead of one separate list grouped by round.
 *
 * @param {Array<{round: number, actor?: "HRBP" | "OD", actor_name: string, outcome: string, created_at: string, items: object[]}>} rounds
 * @returns {Map<string, Array<{round: number, actor: "HRBP" | "OD", actor_name: string, outcome: string, created_at: string, answer: string, selected_options: string[], comment: string}>>}
 *   keyed by question_key, oldest entry first.
 */
function groupVerdictHistoryByQuestion(rounds) {
  const byQuestion = new Map();
  (rounds || []).forEach((round) => {
    round.items.forEach((item) => {
      if (!byQuestion.has(item.question_key)) byQuestion.set(item.question_key, []);
      byQuestion.get(item.question_key).push({
        round: round.round,
        actor: round.actor || "HRBP",
        actor_name: round.actor_name,
        outcome: round.outcome,
        created_at: item.created_at || round.created_at,
        answer: item.answer,
        selected_options: item.selected_options,
        comment: item.comment,
      });
    });
  });
  return byQuestion;
}

/**
 * A small "History" toggle for one question — placed on that question's
 * answer card wherever it's shown (manager's request view, HRBP's and OD's
 * review pages, interactive or read-only) whenever that question was marked
 * insufficient in an earlier round. Collapsed by default; clicking it
 * reveals every earlier round for this question, oldest first, exactly as
 * it stood before the requester's edit replaced it. Returns null when the
 * question has no recorded history, so callers can skip adding it.
 *
 * @param {Array<{round: number, actor: "HRBP" | "OD", actor_name: string, outcome: string, created_at: string, answer: string, selected_options: string[], comment: string}> | undefined} entries
 * @returns {HTMLElement | null}
 */
function buildQuestionHistoryToggle(entries) {
  if (!entries || entries.length === 0) return null;

  const wrap = document.createElement("div");
  wrap.className = "q-history";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "q-history-toggle";
  toggle.setAttribute("aria-expanded", "false");
  const caret = document.createElement("span");
  caret.className = "q-history-caret";
  caret.setAttribute("aria-hidden", "true");
  toggle.appendChild(caret);
  toggle.appendChild(
    document.createTextNode(entries.length === 1 ? "History · 1 earlier answer" : `History · ${entries.length} earlier answers`)
  );
  wrap.appendChild(toggle);

  const panel = document.createElement("div");
  panel.className = "q-history-panel";
  panel.hidden = true;

  entries.forEach((entry) => {
    const entryEl = document.createElement("div");
    entryEl.className = "q-history-entry";

    const meta = document.createElement("div");
    meta.className = "q-history-entry-meta";
    const outcome = document.createElement("span");
    outcome.className = "badge badge-" + (VERDICT_OUTCOME_BADGE[entry.outcome] || "warning");
    outcome.textContent = VERDICT_OUTCOME_LABELS[entry.outcome] || entry.outcome;
    meta.appendChild(outcome);
    const who = document.createElement("span");
    who.className = "q-history-entry-who";
    who.textContent = `${entry.actor_name} · ${formatDateTime(entry.created_at)}`;
    meta.appendChild(who);
    entryEl.appendChild(meta);

    const answerText = document.createElement("p");
    answerText.className = "review-answer-text q-history-answer";
    fillAnswerContent(answerText, entry);
    entryEl.appendChild(answerText);

    entryEl.appendChild(buildReadOnlyVerdictRow(entry.actor || "HRBP", "insufficient", entry.comment));
    panel.appendChild(entryEl);
  });

  wrap.appendChild(panel);

  toggle.addEventListener("click", () => {
    const expanded = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", String(!expanded));
    panel.hidden = expanded;
  });

  return wrap;
}
