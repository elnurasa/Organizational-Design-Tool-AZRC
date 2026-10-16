/**
 * hrbp-review.js
 * ---------------------------------------------------------------------------
 * Controller for hrbp-review.html — an HRBP's per-answer Sufficient /
 * Insufficient review of a single request, or a read-only view if it's
 * already moved past their action (returned_to_requester / od_review /
 * approved / rejected).
 * ---------------------------------------------------------------------------
 */

// 'submitted' never appears here — markRequestInReview() (called before the
// request is fetched, below) always advances it to 'hrbp_review' first.
const HRBP_ACTIONABLE_STATUSES = ["hrbp_review", "returned_to_hrbp"];

const hrbpReviewState = {
  request: null,
  verdicts: {}, // question_key -> { verdict: "sufficient" | "insufficient" | null, comment: string }
  saving: false,
};

async function initHrbpReviewPage() {
  guardPage("HRBP");
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
    await markRequestInReview(requestId); // no-op unless status is currently 'submitted'
    hrbpReviewState.request = await getRequestById(requestId);
  } catch (error) {
    renderLoadError(error.message || "Could not load this request.");
    return;
  }

  hrbpReviewState.request.answers.forEach((answer) => {
    hrbpReviewState.verdicts[answer.question_key] = { verdict: null, comment: "" };
  });

  if (HRBP_ACTIONABLE_STATUSES.indexOf(hrbpReviewState.request.status) !== -1) {
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
// Interactive review (status: hrbp_review or returned_to_hrbp)
// =============================================================================

function renderInteractiveReview() {
  const request = hrbpReviewState.request;
  const main = document.getElementById("review-main");
  main.innerHTML = "";
  main.className = "app-content review-layout";

  const backLink = document.createElement("a");
  backLink.href = "hrbp.html";
  backLink.className = "back-to-list-link";
  backLink.textContent = "← HRBP Inbox";
  main.appendChild(backLink);

  const heading = document.createElement("h1");
  heading.className = "content-heading";
  heading.textContent = `${CATEGORY_LABELS[request.category]} — ${request.requester_name}`;
  main.appendChild(heading);

  main.appendChild(buildReviewMetaBar(request));

  if (request.status === "returned_to_hrbp") {
    main.appendChild(buildOdReturnBanner(request));
  }

  const detailsCard = document.createElement("section");
  detailsCard.className = "card";
  detailsCard.appendChild(buildReviewSectionTitle("Business Reason"));
  detailsCard.appendChild(buildReadOnlyParagraph("Change Description", request.change_description));
  detailsCard.appendChild(buildReadOnlyParagraph("Reason", request.justification));
  main.appendChild(detailsCard);

  // Earlier insufficient verdicts (this HRBP's own prior rounds, and OD's if
  // OD returned it) — the answer text and comment exactly as they stood at
  // that time, before the requester's edit overwrote them. Shown as a
  // "History" toggle on the question it belongs to (buildInteractiveAnswerCard
  // below), not as a separate list, so it's where whoever is reading it
  // (manager, HRBP, OD) is already looking.
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
  generalComment.placeholder = "Any additional context for the requester or OD…";
  generalCommentCard.appendChild(generalComment);
  main.appendChild(generalCommentCard);

  main.appendChild(buildDecisionBar());
}

function buildOdReturnBanner(request) {
  const lastReturn = request.history.slice().reverse().find((entry) => entry.to_status === "returned_to_hrbp");
  const wrap = document.createElement("div");
  wrap.className = "card";
  wrap.style.padding = "16px 20px";
  const banner = document.createElement("div");
  banner.className = "error-message";
  banner.style.marginBottom = "0";
  const strong = document.createElement("strong");
  strong.textContent = "OD returned this request. ";
  banner.appendChild(strong);
  const span = document.createElement("span");
  span.textContent = lastReturn && lastReturn.comment ? lastReturn.comment : "See the flagged answer(s) below.";
  banner.appendChild(span);
  wrap.appendChild(banner);
  return wrap;
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

  if (answer.od_verdict) {
    card.appendChild(buildReadOnlyVerdictRow("OD (previous round)", answer.od_verdict, answer.od_comment));
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
    hrbpReviewState.verdicts[answer.question_key].comment = commentTextarea.value;
  });
  commentField.appendChild(commentTextarea);

  function setVerdict(value) {
    hrbpReviewState.verdicts[answer.question_key].verdict = value;
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
  bar.id = "decision-bar";

  const statusText = document.createElement("span");
  statusText.className = "decision-status-text";
  statusText.id = "decision-status-text";
  bar.appendChild(statusText);

  const actions = document.createElement("div");
  actions.className = "review-decision-actions";

  const returnButton = document.createElement("button");
  returnButton.type = "button";
  returnButton.className = "btn-danger";
  returnButton.id = "return-to-requester-button";
  returnButton.textContent = "Return to Requester";
  returnButton.disabled = true;
  returnButton.addEventListener("click", () => submitHrbpDecision("returned_to_requester"));

  const forwardButton = document.createElement("button");
  forwardButton.type = "button";
  forwardButton.className = "btn-primary";
  forwardButton.id = "submit-to-od-button";
  forwardButton.textContent = "Submit to OD";
  forwardButton.disabled = true;
  forwardButton.addEventListener("click", () => submitHrbpDecision("od_review"));

  actions.appendChild(returnButton);
  actions.appendChild(forwardButton);
  bar.appendChild(actions);

  setTimeout(updateDecisionBar, 0);
  return bar;
}

function updateDecisionBar() {
  const verdicts = Object.values(hrbpReviewState.verdicts);
  const allSet = verdicts.every((v) => v.verdict !== null);
  const allSufficient = allSet && verdicts.every((v) => v.verdict === "sufficient");
  const anyInsufficient = allSet && verdicts.some((v) => v.verdict === "insufficient");

  const statusText = document.getElementById("decision-status-text");
  const returnButton = document.getElementById("return-to-requester-button");
  const forwardButton = document.getElementById("submit-to-od-button");
  if (!statusText || !returnButton || !forwardButton) return;

  // Mutually exclusive, whether this is the first review round or a
  // follow-up after OD sent it back (status "returned_to_hrbp"): all
  // sufficient activates only "Submit to OD"; any insufficient activates
  // only "Return to Requester". Never both at once.
  returnButton.disabled = !anyInsufficient;
  forwardButton.disabled = !allSufficient;

  if (!allSet) {
    statusText.textContent = "Mark every answer as Sufficient or Insufficient to continue.";
  } else if (allSufficient) {
    statusText.textContent = "All answers marked sufficient — ready to forward to OD.";
  } else {
    statusText.textContent = "One or more answers marked insufficient — ready to return to the requester.";
  }
}

async function submitHrbpDecision(target) {
  if (hrbpReviewState.saving) return;

  const verdictEntries = Object.entries(hrbpReviewState.verdicts);
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

  hrbpReviewState.saving = true;
  const returnButton = document.getElementById("return-to-requester-button");
  const forwardButton = document.getElementById("submit-to-od-button");
  returnButton.disabled = true;
  forwardButton.disabled = true;

  try {
    const payload = verdictEntries.map(([questionKey, v]) => ({
      question_key: questionKey,
      verdict: v.verdict,
      comment: v.comment,
    }));
    const generalComment = document.getElementById("general-comment").value;
    const result = await hrbpSubmitReview(hrbpReviewState.request.id, payload, generalComment, target);

    showSuccessToast(result.newStatus === "od_review" ? "Forwarded to OD." : "Returned to the requester.");
    setTimeout(() => {
      window.location.href = "hrbp.html";
    }, 700);
  } catch (error) {
    showErrorToast(error.message || "Could not submit your review.");
    hrbpReviewState.saving = false;
    updateDecisionBar();
  }
}

// =============================================================================
// Read-only view (already forwarded / returned / resolved)
// =============================================================================

function renderReadOnlyReview() {
  const request = hrbpReviewState.request;
  const main = document.getElementById("review-main");
  main.innerHTML = "";
  main.className = "app-content review-layout";

  const backLink = document.createElement("a");
  backLink.href = "hrbp.html";
  backLink.className = "back-to-list-link";
  backLink.textContent = "← HRBP Inbox";
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
