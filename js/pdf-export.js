/**
 * pdf-export.js
 * ---------------------------------------------------------------------------
 * Generates the "Structural Change Request — Approved" PDF for a single
 * request, entirely client-side via jsPDF (CDN, no build step, no backend
 * involved at all — this is genuinely a frontend-only feature, so unlike
 * the rest of the data layer, this one isn't a mock: it produces a real
 * PDF today from whatever request object it's given).
 *
 * Exposes:
 *   - exportRequestToPdf(request)
 * ---------------------------------------------------------------------------
 */

const PDF_MARGIN = 40;
const PDF_PAGE_WIDTH = 595.28; // A4 at 72dpi (jsPDF default unit is pt)
const PDF_PAGE_HEIGHT = 841.89;
const PDF_CONTENT_WIDTH = PDF_PAGE_WIDTH - PDF_MARGIN * 2;
const PDF_PRIMARY_RGB = [47, 95, 237];
const PDF_TEXT_RGB = [26, 31, 54];
const PDF_MUTED_RGB = [107, 114, 128];
const PDF_SUCCESS_RGB = [22, 163, 74];
const PDF_ERROR_RGB = [220, 38, 38];
const PDF_ROW_SHADE_RGB = [245, 247, 250];

/**
 * @param {object} request - the shape returned by request-service.js's
 *   getRequestById() (includes resolved requester_name/hrbp_name, answers,
 *   history).
 */
function exportRequestToPdf(request) {
  if (!window.jspdf || !window.jspdf.jsPDF) {
    showErrorToast("PDF export isn't available right now — the PDF library failed to load.");
    return;
  }

  const doc = new window.jspdf.jsPDF({ unit: "pt", format: "a4" });
  const ctx = { doc: doc, y: PDF_MARGIN, page: 1 };

  drawHeader(ctx, request);
  drawKeyValueSection(ctx, "Requester Details", [
    ["Full Name", request.requester_profile ? request.requester_profile.full_name : request.requester_name],
    ["Company", request.requester_profile ? request.requester_profile.company : ""],
    ["Job Title", request.requester_profile ? request.requester_profile.job_title : ""],
    ["Division", request.requester_profile ? request.requester_profile.division : ""],
    ["Department", request.requester_profile ? request.requester_profile.department : ""],
    ["Subdepartment", request.requester_profile ? request.requester_profile.subdepartment : ""],
    ["Unit", request.requester_profile ? request.requester_profile.unit : ""],
    ["Subunit", request.requester_profile ? request.requester_profile.subunit : ""],
  ]);

  drawKeyValueSection(ctx, "Business Reason", [
    ["Category", CATEGORY_LABELS[request.category] || request.category],
    ["Requested Effective Date", request.requested_effective_date || "—"],
    ["Assigned HRBP", request.hrbp_name],
  ]);
  drawWrappedParagraph(ctx, "Change Description", request.change_description);
  drawWrappedParagraph(ctx, "Reason", request.justification);

  drawQuestionsTable(ctx, request.answers);
  drawApprovalTrail(ctx, request.history);
  drawFooters(ctx);

  const fileName = `structural-change-request-${formatRequestNumber(request)}.pdf`;
  doc.save(fileName);
  showSuccessToast("PDF downloaded.");
}

// =============================================================================
// Layout helpers
// =============================================================================

function ensureSpace(ctx, neededHeight) {
  if (ctx.y + neededHeight > PDF_PAGE_HEIGHT - PDF_MARGIN - 30) {
    ctx.doc.addPage();
    ctx.page += 1;
    ctx.y = PDF_MARGIN;
  }
}

function drawHeader(ctx, request) {
  const doc = ctx.doc;

  // Logo placeholder — colored rectangle standing in for a real logo asset.
  doc.setFillColor.apply(doc, PDF_PRIMARY_RGB);
  doc.roundedRect(PDF_MARGIN, ctx.y, 34, 34, 6, 6, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text("OD", PDF_MARGIN + 17, ctx.y + 22, { align: "center" });

  doc.setTextColor.apply(doc, PDF_TEXT_RGB);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.text("Structural Change Request — Approved", PDF_MARGIN + 46, ctx.y + 14);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9.5);
  doc.setTextColor.apply(doc, PDF_MUTED_RGB);
  doc.text(`Request ID: ${formatRequestNumber(request)}    Generated: ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}`, PDF_MARGIN + 46, ctx.y + 29);

  ctx.y += 54;
  doc.setDrawColor(229, 233, 240);
  doc.line(PDF_MARGIN, ctx.y, PDF_MARGIN + PDF_CONTENT_WIDTH, ctx.y);
  ctx.y += 22;
}

function drawSectionTitle(ctx, title) {
  ensureSpace(ctx, 30);
  const doc = ctx.doc;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11.5);
  doc.setTextColor.apply(doc, PDF_TEXT_RGB);
  doc.text(title, PDF_MARGIN, ctx.y);
  ctx.y += 8;
  doc.setDrawColor(229, 233, 240);
  doc.line(PDF_MARGIN, ctx.y, PDF_MARGIN + PDF_CONTENT_WIDTH, ctx.y);
  ctx.y += 16;
}

function drawKeyValueSection(ctx, title, pairs) {
  drawSectionTitle(ctx, title);
  const doc = ctx.doc;
  const columnWidth = PDF_CONTENT_WIDTH / 2;
  const rowHeight = 26;

  pairs.forEach((pair, index) => {
    const column = index % 2;
    if (column === 0) ensureSpace(ctx, rowHeight);
    const x = PDF_MARGIN + column * columnWidth;
    const rowIndex = Math.floor(index / 2);
    const rowY = ctx.y + rowIndex * rowHeight;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor.apply(doc, PDF_MUTED_RGB);
    doc.text(String(pair[0]).toUpperCase(), x, rowY);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(10.5);
    doc.setTextColor.apply(doc, PDF_TEXT_RGB);
    doc.text(pair[1] ? String(pair[1]) : "—", x, rowY + 14);
  });

  const rowCount = Math.ceil(pairs.length / 2);
  ctx.y += rowCount * rowHeight + 8;
}

function drawWrappedParagraph(ctx, label, text) {
  const doc = ctx.doc;
  ensureSpace(ctx, 30);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(9.5);
  doc.setTextColor.apply(doc, PDF_TEXT_RGB);
  doc.text(label, PDF_MARGIN, ctx.y);
  ctx.y += 14;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor.apply(doc, PDF_TEXT_RGB);
  const lines = doc.splitTextToSize(text || "—", PDF_CONTENT_WIDTH);
  lines.forEach((line) => {
    ensureSpace(ctx, 14);
    doc.text(line, PDF_MARGIN, ctx.y);
    ctx.y += 14;
  });
  ctx.y += 10;
}

function drawQuestionsTable(ctx, answers) {
  drawSectionTitle(ctx, "Questions & Answers");
  const doc = ctx.doc;

  const columns = [
    { label: "#", width: 22 },
    { label: "Question", width: 150 },
    { label: "Manager Answer", width: 200 },
    { label: "HRBP", width: 55 },
    { label: "OD", width: 55 },
  ];

  drawTableHeaderRow(ctx, columns);

  answers.forEach((answer, index) => {
    const questionLines = doc.splitTextToSize(answer.question_text, columns[1].width - 8);
    const answerLines = doc.splitTextToSize(formatAnswerPlainText(answer), columns[2].width - 8);
    const rowLines = Math.max(questionLines.length, answerLines.length, 1);
    const rowHeight = rowLines * 11 + 10;

    ensureSpace(ctx, rowHeight);
    if (index % 2 === 1) {
      doc.setFillColor.apply(doc, PDF_ROW_SHADE_RGB);
      doc.rect(PDF_MARGIN, ctx.y - 2, PDF_CONTENT_WIDTH, rowHeight, "F");
    }

    let x = PDF_MARGIN;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor.apply(doc, PDF_TEXT_RGB);
    doc.text(String(index + 1), x + 4, ctx.y + 8);
    x += columns[0].width;

    questionLines.forEach((line, i) => doc.text(line, x + 4, ctx.y + 8 + i * 11));
    x += columns[1].width;

    answerLines.forEach((line, i) => doc.text(line, x + 4, ctx.y + 8 + i * 11));
    x += columns[2].width;

    drawVerdictCell(ctx, x, ctx.y + 8, answer.hrbp_verdict);
    x += columns[3].width;
    drawVerdictCell(ctx, x, ctx.y + 8, answer.od_verdict);

    ctx.y += rowHeight;
  });

  ctx.y += 10;
}

function drawTableHeaderRow(ctx, columns) {
  const doc = ctx.doc;
  ensureSpace(ctx, 20);
  doc.setFillColor(248, 249, 252);
  doc.rect(PDF_MARGIN, ctx.y - 2, PDF_CONTENT_WIDTH, 18, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8.5);
  doc.setTextColor.apply(doc, PDF_MUTED_RGB);

  let x = PDF_MARGIN;
  columns.forEach((column) => {
    doc.text(column.label.toUpperCase(), x + 4, ctx.y + 10);
    x += column.width;
  });
  ctx.y += 20;
}

function drawVerdictCell(ctx, x, y, verdict) {
  const doc = ctx.doc;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8.5);
  if (verdict === "sufficient") {
    doc.setTextColor.apply(doc, PDF_SUCCESS_RGB);
    doc.text("OK", x + 4, y);
  } else if (verdict === "insufficient") {
    doc.setTextColor.apply(doc, PDF_ERROR_RGB);
    doc.text("FLAG", x + 4, y);
  } else {
    doc.setTextColor.apply(doc, PDF_MUTED_RGB);
    doc.text("—", x + 4, y);
  }
}

function drawApprovalTrail(ctx, history) {
  drawSectionTitle(ctx, "Approval Trail");
  const doc = ctx.doc;

  history.forEach((entry) => {
    ensureSpace(ctx, 26);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9.5);
    doc.setTextColor.apply(doc, PDF_TEXT_RGB);
    const timestamp = new Date(entry.created_at).toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    doc.text(`${entry.actor_name}`, PDF_MARGIN, ctx.y);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor.apply(doc, PDF_MUTED_RGB);
    doc.text(timestamp, PDF_MARGIN + PDF_CONTENT_WIDTH - 140, ctx.y, { align: "left" });

    ctx.y += 13;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.5);
    doc.setTextColor.apply(doc, PDF_TEXT_RGB);
    doc.text(describeHistoryAction(entry), PDF_MARGIN, ctx.y);
    ctx.y += 16;

    if (entry.comment) {
      doc.setFont("helvetica", "italic");
      doc.setFontSize(9);
      doc.setTextColor.apply(doc, PDF_MUTED_RGB);
      const lines = doc.splitTextToSize(`"${entry.comment}"`, PDF_CONTENT_WIDTH - 10);
      lines.forEach((line) => {
        ensureSpace(ctx, 12);
        doc.text(line, PDF_MARGIN + 10, ctx.y);
        ctx.y += 12;
      });
    }
    ctx.y += 6;
  });
}

function drawFooters(ctx) {
  const doc = ctx.doc;
  const pageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor.apply(doc, PDF_MUTED_RGB);
    doc.text("Confidential", PDF_MARGIN, PDF_PAGE_HEIGHT - 20);
    doc.text(`Page ${i} of ${pageCount}`, PDF_PAGE_WIDTH - PDF_MARGIN, PDF_PAGE_HEIGHT - 20, { align: "right" });
  }
}
