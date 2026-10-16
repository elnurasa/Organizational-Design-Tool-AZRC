/**
 * request-form-ux.js
 * ---------------------------------------------------------------------------
 * Guidance layer for create-request.html. It READS pageState (from
 * create-request.js) to show progress, and calls the page's own renderStep()
 * only for the same "go back to an earlier step" action the Back button
 * performs. It never writes to pageState, never validates, saves or submits —
 * every rule and every data path stays exactly as create-request.js has it.
 *
 * What it adds:
 *   - "n of 5 required fields" meter on step 1, "n of N answered" on step 2
 *   - answered state on each question card, and a question navigator rail
 *   - a status line in the footer (step, progress)
 *   - completed steps in the stepper are clickable (same as Back)
 *   - "Edit" shortcuts on the review step (same as Back)
 *   - textareas grow with their content
 *   - after Next / Submit, the first field with an error is scrolled to and focused
 * ---------------------------------------------------------------------------
 */
(function () {
  const main = document.getElementById("request-main");
  const footer = document.getElementById("sticky-footer");
  const track = document.getElementById("progress-track");
  if (!main || typeof pageState === "undefined") return;

  let statusEl = null;
  let rail = null;
  let railSignature = "";
  let scheduled = false;

  const observer = new MutationObserver(schedule);

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      refresh();
    });
  }

  function questions() {
    return (typeof QUESTION_BANK !== "undefined" && QUESTION_BANK[pageState.form.category]) || [];
  }

  // Same rule the form enforces on Next / Submit (unansweredQuestions() in
  // create-request.js): a question counts as answered once it has a written
  // answer. Picked options alone don't, so the counter never says "8 of 8"
  // while Next is still blocked.
  function isAnswered(question) {
    return (pageState.form.answers[question.key] || "").trim().length > 0;
  }

  function requiredFieldsFilled() {
    const f = pageState.form;
    return [f.category, (f.change_description || "").trim(), (f.justification || "").trim(), f.requested_effective_date, f.assigned_hrbp_id].filter(Boolean).length;
  }

  function grow(textarea) {
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight + 2, 520) + "px";
  }

  function meter(className, done, total, label) {
    const percent = total ? Math.round((done / total) * 100) : 0;
    const el = document.createElement("div");
    el.className = className;
    const bar = document.createElement("div");
    bar.className = "ux-meter-bar";
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", String(total));
    bar.setAttribute("aria-valuenow", String(done));
    const fill = document.createElement("i");
    fill.style.width = percent + "%";
    bar.appendChild(fill);
    const text = document.createElement("span");
    text.textContent = label;
    el.appendChild(bar);
    el.appendChild(text);
    el.classList.toggle("is-done", total > 0 && done === total);
    return el;
  }

  function upsertMeter(card, className, done, total, label) {
    const existing = card.querySelector("." + className);
    if (existing) {
      existing.querySelector(".ux-meter-bar i").style.width = (total ? Math.round((done / total) * 100) : 0) + "%";
      existing.querySelector(".ux-meter-bar").setAttribute("aria-valuenow", String(done));
      existing.querySelector("span").textContent = label;
      existing.classList.toggle("is-done", total > 0 && done === total);
      return;
    }
    const heading = card.querySelector("h2");
    const el = meter(className, done, total, label);
    if (heading) heading.insertAdjacentElement("afterend", el);
    else card.prepend(el);
  }

  function ensureStatus() {
    if (!footer || statusEl) return;
    statusEl = document.createElement("div");
    statusEl.className = "ux-status";
    statusEl.setAttribute("aria-live", "polite");
    footer.insertBefore(statusEl, footer.firstChild);
  }

  function setStatus(parts) {
    if (!statusEl) return;
    statusEl.textContent = "";
    parts.forEach((part, index) => {
      if (index > 0) statusEl.appendChild(document.createElement("i"));
      const span = document.createElement(index === 0 ? "b" : "span");
      span.textContent = part;
      statusEl.appendChild(span);
    });
  }

  function buildRail(list) {
    const signature = list.map((q) => q.key + (isAnswered(q) ? "1" : "0")).join("|");
    if (!rail) {
      rail = document.createElement("nav");
      rail.className = "ux-rail";
      rail.setAttribute("aria-label", "Question navigator");
      document.body.appendChild(rail);
    }
    rail.classList.add("is-visible");
    if (signature === railSignature) return;
    railSignature = signature;
    rail.textContent = "";
    list.forEach((question, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = String(index + 1);
      button.dataset.question = question.key;
      const answered = isAnswered(question);
      button.classList.toggle("is-answered", answered);
      button.setAttribute("aria-label", `Question ${index + 1}${answered ? ", answered" : ""}`);
      rail.appendChild(button);
    });
  }

  function hideRail() {
    if (rail) rail.classList.remove("is-visible");
  }

  function decorateStepper() {
    if (!track) return;
    track.querySelectorAll(".progress-step").forEach((step) => {
      const clickable = step.classList.contains("completed");
      step.classList.toggle("ux-clickable", clickable);
      if (clickable) {
        step.setAttribute("role", "button");
        step.setAttribute("tabindex", "0");
        step.setAttribute("aria-label", "Go back to step " + step.dataset.step);
      } else {
        step.removeAttribute("role");
        step.removeAttribute("tabindex");
        step.removeAttribute("aria-label");
      }
    });
  }

  function decorateReviewEdits() {
    const goto = { "Request Details": 1, "Business Reason": 1, "Questions & Answers": 2 };
    main.querySelectorAll(".review-section-title").forEach((title) => {
      if (title.querySelector(".ux-edit")) return;
      const label = title.textContent.trim();
      const step = goto[label];
      if (!step) return;
      if (step === 2 && questions().length === 0) return;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ux-edit";
      button.textContent = "Edit";
      button.setAttribute("aria-label", "Edit " + label);
      button.addEventListener("click", () => renderStep(step));
      title.appendChild(button);
    });
  }

  function refresh() {
    if (pageState.mode === "view" || !main.firstElementChild) return;
    observer.disconnect();
    try {
      ensureStatus();
      decorateStepper();
      const step = pageState.step;
      const list = questions();

      if (step === 1) {
        hideRail();
        const form = main.querySelector(".justification-form");
        const card = form && form.closest(".card");
        const filled = requiredFieldsFilled();
        if (card) upsertMeter(card, "ux-meter", filled, 5, `${filled} of 5 required fields`);
        setStatus(["Step 1 of 3", `${filled} of 5 required fields`]);
      } else if (step === 2) {
        const answered = list.filter(isAnswered).length;
        main.querySelectorAll(".question-field").forEach((field) => {
          const key = field.id.replace(/^question-/, "");
          const question = list.find((q) => q.key === key);
          if (question) field.classList.toggle("is-answered", isAnswered(question));
        });
        const card = main.querySelector(".card");
        if (card && list.length) upsertMeter(card, "ux-progress", answered, list.length, `${answered} of ${list.length} answered`);
        if (list.length) buildRail(list);
        setStatus(["Step 2 of 3", `${answered} of ${list.length} answered`]);
      } else {
        hideRail();
        decorateReviewEdits();
        setStatus(["Step 3 of 3", "Review and submit"]);
      }

      main.querySelectorAll("textarea").forEach(grow);
    } finally {
      observer.observe(main, { childList: true, subtree: true });
    }
  }

  // Typing, picking and re-rendering all feed the same refresh.
  main.addEventListener("input", (event) => {
    if (event.target.tagName === "TEXTAREA") grow(event.target);
    schedule();
  });
  main.addEventListener("change", schedule);

  // Completed steps are clickable, same action as the Back button.
  if (track) {
    const back = (event) => {
      const step = event.target.closest(".progress-step.completed");
      if (!step) return;
      if (event.type === "keydown" && event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      renderStep(Number(step.dataset.step));
    };
    track.addEventListener("click", back);
    track.addEventListener("keydown", back);
  }

  // Question navigator.
  document.addEventListener("click", (event) => {
    const button = event.target.closest(".ux-rail button");
    if (button) {
      const field = document.getElementById("question-" + button.dataset.question);
      if (field) {
        field.scrollIntoView({ behavior: "smooth", block: "center" });
        const control = field.querySelector("textarea, .option-picker-input");
        if (control) control.focus({ preventScroll: true });
      }
      return;
    }

    // After Next / Submit, bring the first error into view and focus it.
    if (event.target.closest("#next-step-button, #submit-button")) {
      setTimeout(() => {
        const first = main.querySelector(".field-error");
        if (!first) return;
        first.scrollIntoView({ behavior: "smooth", block: "center" });
        const control = first.querySelector("select, textarea, input");
        if (control) control.focus({ preventScroll: true });
      }, 90);
    }
  });

  observer.observe(main, { childList: true, subtree: true });
  schedule();
})();
