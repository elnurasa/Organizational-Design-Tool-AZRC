/**
 * od-review.js
 * ---------------------------------------------------------------------------
 * Controller for od-review.html — OD's final per-answer Sufficient /
 * Insufficient review, with the HRBP's own verdicts shown read-only for
 * context. Approve / Reject / Return to HRBP. Read-only view if the request
 * has already moved past od_review (approved / rejected / returned_to_hrbp
 * not yet re-forwarded).
 * ---------------------------------------------------------------------------
 */

const odReviewState = {
  request: null,
  verdicts: {}, // question_key -> { verdict: "sufficient" | "insufficient" | null, comment: string }
  saving: false,
};

async function initOdReviewPage() {
  guardPage("OD");
  document.getElementById("logout-button").addEventListener("click", logout);

  const emailLabel = document.getElementById("user-email");
  if (emailLabel) emailLabel.textContent = getCurrentUser();

  const params = new URLSearchParams(window.location.search);
  const requestId = params.get("id");
  if (!requestId) {
    renderLoadError("No request specified.");
    return;
  }

  try {
    await odMarkOpened(requestId); // no-op unless it is in od_review and not opened yet
    odReviewState.request = await getRequestById(requestId);
  } catch (error) {
    renderLoadError(error.message || "Could not load this request.");
    return;
  }

  odReviewState.request.answers.forEach((answer) => {
    odReviewState.verdicts[answer.question_key] = { verdict: null, comment: "" };
  });

  if (odReviewState.request.status === "od_review") {
    renderInteractiveReview();
  } else {
    renderReadOnlyReview();
  }
}

function renderLoadError(message) {
  document.getElementById("page-loading").remove();
  const main = document.getElementById("review-main");
  const errorEl = document.createElement("p");
  errorEl.className = "error-message";
  errorEl.textContent = message;
  main.appendChild(errorEl);
}

// =============================================================================
// Interactive review (status: od_review)
// =============================================================================

function renderInteractiveReview() {
  const request = odReviewState.request;
  const main = document.getElementById("review-main");
  main.innerHTML = "";
  main.className = "app-content review-layout";

  const backLink = document.createElement("a");
  backLink.href = "od.html";
  backLink.className = "back-to-list-link";
  backLink.textContent = "← OD Inbox";
  main.appendChild(backLink);

  const heading = document.createElement("h1");
  heading.className = "content-heading";
  heading.textContent = `${CATEGORY_LABELS[request.category]} — ${request.requester_name}`;
  main.appendChild(heading);

  main.appendChild(buildReviewMetaBar(request));

  const detailsCard = document.createElement("section");
  detailsCard.className = "card";
  detailsCard.appendChild(buildReviewSectionTitle("Business Reason"));
  detailsCard.appendChild(buildReadOnlyParagraph("Change Description", request.change_description));
  detailsCard.appendChild(buildReadOnlyParagraph("Reason", request.justification));
  main.appendChild(detailsCard);

  // Everything the HRBP marked insufficient in earlier rounds — shown as a
  // "History" toggle on the question it belongs to (buildInteractiveAnswerCard
  // below), so OD sees what was challenged (and fixed) right where they're
  // already reviewing it, not in a separate list.
  const historyByQuestion = groupVerdictHistoryByQuestion(request.verdict_history);

  const answersCard = document.createElement("section");
  answersCard.className = "card";
  answersCard.appendChild(buildReviewSectionTitle("Questions & Answers"));
  request.answers.forEach((answer) => {
    answersCard.appendChild(buildInteractiveAnswerCard(answer, historyByQuestion.get(answer.question_key)));
  });
  main.appendChild(answersCard);

  const generalCommentCard = document.createElement("section");
  generalCommentCard.className = "card";
  generalCommentCard.appendChild(buildReviewSectionTitle("General Comment (optional)"));
  const generalComment = document.createElement("textarea");
  generalComment.id = "general-comment";
  generalComment.rows = 3;
  generalComment.className = "question-textarea";
  generalComment.placeholder = "Any additional context for the record…";
  generalCommentCard.appendChild(generalComment);
  main.appendChild(generalCommentCard);

  main.appendChild(buildDecisionBar());
}

function buildInteractiveAnswerCard(answer, historyEntries) {
  const card = document.createElement("div");
  card.className = "review-answer-card";
  card.id = `answer-${answer.question_key}`;

  const questionText = document.createElement("p");
  questionText.className = "review-question-text";
  questionText.textContent = answer.question_text;
  card.appendChild(questionText);

  const answerText = document.createElement("p");
  answerText.className = "review-answer-text";
  fillAnswerContent(answerText, answer);
  card.appendChild(answerText);

  if (answer.hrbp_verdict) {
    card.appendChild(buildReadOnlyVerdictRow("HRBP", answer.hrbp_verdict, answer.hrbp_comment));
  }

  const historyToggle = buildQuestionHistoryToggle(historyEntries);
  if (historyToggle) card.appendChild(historyToggle);

  const toggleGroup = document.createElement("div");
  toggleGroup.className = "verdict-toggle-group";

  const sufficientButton = document.createElement("button");
  sufficientButton.type = "button";
  sufficientButton.className = "verdict-toggle verdict-sufficient";
  sufficientButton.textContent = "Sufficient";

  const insufficientButton = document.createElement("button");
  insufficientButton.type = "button";
  insufficientButton.className = "verdict-toggle verdict-insufficient";
  insufficientButton.textContent = "Insufficient";

  const commentField = document.createElement("div");
  commentField.className = "verdict-comment-field hidden";
  const commentTextarea = document.createElement("textarea");
  commentTextarea.rows = 2;
  commentTextarea.placeholder = "Explain what needs to change (required)…";
  commentTextarea.addEventListener("input", () => {
    odReviewState.verdicts[answer.question_key].comment = commentTextarea.value;
  });
  commentField.appendChild(commentTextarea);

  function setVerdict(value) {
    odReviewState.verdicts[answer.question_key].verdict = value;
    sufficientButton.classList.toggle("is-active", value === "sufficient");
    insufficientButton.classList.toggle("is-active", value === "insufficient");
    commentField.classList.toggle("hidden", value !== "insufficient");
    updateDecisionBar();
  }

  sufficientButton.addEventListener("click", () => setVerdict("sufficient"));
  insufficientButton.addEventListener("click", () => setVerdict("insufficient"));

  toggleGroup.appendChild(sufficientButton);
  toggleGroup.appendChild(insufficientButton);
  const verdictRow = document.createElement("div");
  verdictRow.className = "verdict-row";
  verdictRow.appendChild(toggleGroup);
  card.appendChild(verdictRow);
  card.appendChild(commentField);

  const errorText = document.createElement("p");
  errorText.className = "error-text hidden";
  card.appendChild(errorText);

  return card;
}

function buildDecisionBar() {
  const bar = document.createElement("div");
  bar.className = "review-decision-bar";

  const statusText = document.createElement("span");
  statusText.className = "decision-status-text";
  statusText.id = "decision-status-text";
  bar.appendChild(statusText);

  const actions = document.createElement("div");
  actions.className = "review-decision-actions";

  const rejectButton = document.createElement("button");
  rejectButton.type = "button";
  rejectButton.className = "btn-danger";
  rejectButton.id = "reject-button";
  rejectButton.textContent = "Reject";
  rejectButton.disabled = true;
  rejectButton.addEventListener("click", () => confirmAndSubmit("reject", "Reject Request", "Reject this request outright? This is final and cannot be undone."));

  const returnButton = document.createElement("button");
  returnButton.type = "button";
  returnButton.className = "btn-secondary";
  returnButton.id = "return-to-hrbp-button";
  returnButton.textContent = "Return to HRBP";
  returnButton.disabled = true;
  returnButton.addEventListener("click", () => submitOdDecision("return_to_hrbp"));

  const approveButton = document.createElement("button");
  approveButton.type = "button";
  approveButton.className = "btn-primary";
  approveButton.id = "approve-button";
  approveButton.textContent = "Approve";
  approveButton.disabled = true;
  approveButton.addEventListener("click", () => confirmAndSubmit("approve", "Approve Request", "Approve this request? This is final."));

  actions.appendChild(rejectButton);
  actions.appendChild(returnButton);
  actions.appendChild(approveButton);
  bar.appendChild(actions);

  setTimeout(updateDecisionBar, 0);
  return bar;
}

function confirmAndSubmit(decision, title, message) {
  openConfirmModal({
    title: title,
    message: message,
    confirmLabel: title.split(" ")[0],
    variant: decision === "approve" ? "primary" : "danger",
    onConfirm: () => submitOdDecision(decision),
  });
}

function updateDecisionBar() {
  const verdicts = Object.values(odReviewState.verdicts);
  const allSet = verdicts.every((v) => v.verdict !== null);
  const allSufficient = allSet && verdicts.every((v) => v.verdict === "sufficient");
  const anyInsufficient = allSet && verdicts.some((v) => v.verdict === "insufficient");

  const statusText = document.getElementById("decision-status-text");
  const approveButton = document.getElementById("approve-button");
  const returnButton = document.getElementById("return-to-hrbp-button");
  const rejectButton = document.getElementById("reject-button");
  if (!statusText || !approveButton || !returnButton || !rejectButton) return;

  // Mutually exclusive: all sufficient activates only Approve; any
  // insufficient activates only Return to HRBP and Reject. Never both.
  approveButton.disabled = !allSufficient;
  returnButton.disabled = !anyInsufficient;
  rejectButton.disabled = !anyInsufficient;

  if (!allSet) {
    statusText.textContent = "Mark every answer as Sufficient or Insufficient to continue.";
  } else if (allSufficient) {
    statusText.textContent = "All answers marked sufficient — ready to approve.";
  } else {
    statusText.textContent = "One or more answers marked insufficient — return to HRBP, or reject outright.";
  }
}

async function submitOdDecision(decision) {
  if (odReviewState.saving) return;

  const verdictEntries = Object.entries(odReviewState.verdicts);
  let valid = true;
  verdictEntries.forEach(([questionKey, v]) => {
    const card = document.getElementById(`answer-${questionKey}`);
    const errorEl = card.querySelector(".error-text");
    if (v.verdict === "insufficient" && !v.comment.trim()) {
      errorEl.textContent = "Please explain what needs to change.";
      errorEl.classList.remove("hidden");
      valid = false;
    } else {
      errorEl.classList.add("hidden");
    }
  });
  if (!valid) {
    showErrorToast("Please add a comment for every answer marked insufficient.");
    return;
  }

  odReviewState.saving = true;
  ["approve-button", "return-to-hrbp-button", "reject-button"].forEach((id) => {
    document.getElementById(id).disabled = true;
  });

  try {
    const payload = verdictEntries.map(([questionKey, v]) => ({
      question_key: questionKey,
      verdict: v.verdict,
      comment: v.comment,
    }));
    const generalComment = document.getElementById("general-comment").value;
    const result = await odSubmitReview(odReviewState.request.id, decision, payload, generalComment);

    const messages = { approved: "Request approved.", rejected: "Request rejected.", returned_to_hrbp: "Returned to HRBP." };
    showSuccessToast(messages[result.newStatus] || "Saved.");
    setTimeout(() => {
      window.location.href = "od.html";
    }, 700);
  } catch (error) {
    showErrorToast(error.message || "Could not submit your decision.");
    odReviewState.saving = false;
    updateDecisionBar();
  }
}

// =============================================================================
// Read-only view (approved / rejected / returned_to_hrbp awaiting HRBP)
// =============================================================================

function renderReadOnlyReview() {
  const request = odReviewState.request;
  const main = document.getElementById("review-main");
  main.innerHTML = "";
  main.className = "app-content review-layout";

  const backLink = document.createElement("a");
  backLink.href = "od.html";
  backLink.className = "back-to-list-link";
  backLink.textContent = "← OD Inbox";
  main.appendChild(backLink);

  const heading = document.createElement("h1");
  heading.className = "content-heading";
  heading.textContent = `${CATEGORY_LABELS[request.category]} — ${request.requester_name}`;
  main.appendChild(heading);

  main.appendChild(buildReviewMetaBar(request));

  const historyByQuestion = groupVerdictHistoryByQuestion(request.verdict_history);

  const answersCard = document.createElement("section");
  answersCard.className = "card";
  answersCard.appendChild(buildReviewSectionTitle("Questions & Answers"));
  request.answers.forEach((answer) => {
    const card = document.createElement("div");
    card.className = "review-answer-card";
    const questionText = document.createElement("p");
    questionText.className = "review-question-text";
    questionText.textContent = answer.question_text;
    const answerText = document.createElement("p");
    answerText.className = "review-answer-text";
    fillAnswerContent(answerText, answer);
    card.appendChild(questionText);
    card.appendChild(answerText);
    if (answer.hrbp_verdict) card.appendChild(buildReadOnlyVerdictRow("HRBP", answer.hrbp_verdict, answer.hrbp_comment));
    if (answer.od_verdict) card.appendChild(buildReadOnlyVerdictRow("OD", answer.od_verdict, answer.od_comment));
    const historyToggle = buildQuestionHistoryToggle(historyByQuestion.get(answer.question_key));
    if (historyToggle) card.appendChild(historyToggle);
    answersCard.appendChild(card);
  });
  main.appendChild(answersCard);

  main.appendChild(buildApprovalTrailCard(request.history));

  if (request.status === "approved") {
    const actionsRow = document.createElement("div");
    actionsRow.className = "content-header-row";
    const exportButton = document.createElement("button");
    exportButton.type = "button";
    exportButton.className = "btn-primary";
    exportButton.style.width = "auto";
    exportButton.textContent = "Export PDF";
    exportButton.addEventListener("click", () => exportRequestToPdf(request));
    actionsRow.appendChild(document.createElement("span"));
    actionsRow.appendChild(exportButton);
    main.appendChild(actionsRow);
  }
}
