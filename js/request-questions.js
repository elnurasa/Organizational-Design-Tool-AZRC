/**
 * request-questions.js
 * ---------------------------------------------------------------------------
 * Data-only definitions for the Structural Change Request form's Phase 2
 * dynamic question engine. js/create-request.js reads this data to render
 * the category selector and the question set for whichever category is
 * selected — no category-specific logic lives outside this file.
 *
 * Each question renders as a free-text description textarea. A question that
 * also has `hints` offers them as predefined options: a searchable multi-
 * select dropdown, a field showing the selected options as chips, then the
 * description textarea (see buildOptionPicker() in js/workflow-shared.js).
 * The selected options are stored separately from the description
 * (request_answers.selected_options).
 * ---------------------------------------------------------------------------
 */

const REQUEST_CATEGORY_ORDER = [
  "new_department",
  "new_unit",
  "new_position",
  "reporting_line_change",
  "closure_removal",
  "merge_split",
  "name_change",
];

const CATEGORY_LABELS = {
  new_department: "New department",
  new_unit: "New unit",
  new_position: "New position / Headcount increase",
  reporting_line_change: "Reporting line or scope change",
  closure_removal: "Closure or removal (position, unit, department)",
  merge_split: "Merge or Split (position, unit, department)",
  name_change: "Official name change (position, unit, department)",
};

const CATEGORY_DESCRIPTIONS = {
  new_department: "Establish a new department within the organization.",
  new_unit: "Establish a new unit within an existing department.",
  new_position: "Create a new position or increase headcount.",
  reporting_line_change: "Change a reporting line, ownership, or scope of responsibility.",
  closure_removal: "Close or remove an existing position, unit, or department.",
  merge_split: "Merge two structures together or split one into multiple.",
  name_change: "Officially rename an existing position, unit, or department.",
};

// Status display labels + badge color variant, shared by every page that
// shows a request's status (manager's list, HRBP/OD inboxes, review pages).
//
// Labels say where the request IS, not what was done to it: a request in the
// 'submitted' status is already with its HRBP (who simply hasn't opened it
// yet), so it reads "HRBP Review" — not the vaguer "Submitted" — and shares
// that stage's colour. (The HRBP's own inbox still shows it as "New".)
const STATUS_LABELS = {
  draft: "Draft",
  submitted: "HRBP Review",
  hrbp_review: "HRBP Review",
  returned_to_requester: "Returned to Requester",
  od_review: "OD Review",
  returned_to_hrbp: "Returned to HRBP",
  approved: "Approved",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};

// Manager-only override: on the requester's own list/view, "returned to
// requester" reads better as "Returned to You" (it's addressed to the
// person looking at it). Everywhere else (HRBP/OD inboxes, review pages)
// the viewer isn't the requester, so STATUS_LABELS' third-person text is
// the correct one there.
const MANAGER_STATUS_LABELS = Object.assign({}, STATUS_LABELS, {
  returned_to_requester: "Returned to You",
});

// One distinct colour per lifecycle stage (see the badge-* rules in
// css/admin.css right after .badge-danger) — not grouped by outcome
// category. 'submitted' and 'hrbp_review' are the same stage (the request is
// with the HRBP), so they share a colour, matching their shared label.
const STATUS_BADGE_VARIANT = {
  draft: "draft",
  submitted: "hrbp-review",
  hrbp_review: "hrbp-review",
  returned_to_requester: "returned-requester",
  od_review: "od-review",
  returned_to_hrbp: "returned-hrbp",
  approved: "success",
  rejected: "danger",
  withdrawn: "withdrawn",
};

const QUESTION_BANK = {
  new_department: [
    { key: "nd_business_need", text: "What business need or strategic objective requires establishing a new department?", hints: ["Company's long-term strategy", "Efficient value creation", "Revenue impact", "Increase productivity"] },
    { key: "nd_alternatives", text: "Have non-headcount alternatives been considered?", hints: ["Process simplification", "Automation", "Outsourcing", "Redistribution of work"] },
    { key: "nd_overlaps", text: "Have potential overlaps or duplications with existing departments been assessed?", hints: [] },
    { key: "nd_risks", text: "What risks would arise if this department were not established?", hints: ["Business", "Legal", "Financial", "Operational", "Reputational impact"] },
    { key: "nd_leadership", text: "Does the proposed department require dedicated leadership, governance and decision-making authority?", hints: [] },
  ],
  new_unit: [
    { key: "nu_operational_need", text: "What operational need or workload justifies establishing a new unit?", hints: [] },
    { key: "nu_existing_structure", text: "Why can't these responsibilities continue within the existing unit structure?", hints: [] },
    { key: "nu_improvements", text: "What are the improvement areas of the new unit?", hints: ["Scope of responsibility", "Accountability", "Service quality"] },
    { key: "nu_alternatives", text: "Have non-headcount alternatives been considered?", hints: ["Process redesign", "Automation", "Redistribution of work"] },
    { key: "nu_overlaps", text: "Have potential overlaps or duplication with existing units been assessed?", hints: [] },
    { key: "nu_span_of_control", text: "Does the current manager's span of control justify creating a separate unit?", hints: [] },
    { key: "nu_risks", text: "What operational risks would arise if the unit were not established?", hints: [] },
    { key: "nu_measurable", text: "What measurable operational improvements are expected after the unit is established?", hints: [] },
  ],
  new_position: [
    { key: "np_alternatives", text: "Have non-headcount options been considered before creating this position?", hints: ["Simplifying", "Automating", "Outsourcing", "Reallocating"] },
    { key: "np_new_accountabilities", text: "Does the position introduce new or expanded accountabilities that cannot be assigned to existing roles?", hints: [] },
    { key: "np_differentiation", text: "Are the responsibilities and decision rights clearly differentiated from existing positions?", hints: [] },
    { key: "np_longevity", text: "Is the proposed position expected to remain necessary for at least the next strategy year based on business plans and projected workload?", hints: [] },
    { key: "np_workload", text: "Can the expected workload be quantified through volume, complexity, SLA requirements, business growth, or regulatory obligations?", hints: [] },
    { key: "np_scope", text: "Does the proposed position reflect the actual scope, complexity, accountability, and decision-making authority, while avoiding additional layers or structural complexity?", hints: [] },
  ],
  reporting_line_change: [
    { key: "rl_span", text: "Will the proposed reporting line improve managerial effectiveness and maintain an appropriate span of control?", hints: [] },
    { key: "rl_alignment", text: "Does the proposed reporting relationship align with where strategic decisions, resources, and accountability are managed?", hints: [] },
    { key: "rl_business_need", text: "Is there a clear business need for the proposed change?", hints: ["Reporting line", "Parent structure or ownership", "Improved accountability", "Efficiency", "Governance", "Service", "Business alignment"] },
  ],
  closure_removal: [
    { key: "cr_reason", text: "Why is the position/unit/department no longer required due to changes in business model, strategy, workload, or operating structure?", hints: [] },
    { key: "cr_compliance", text: "Have all regulatory, compliance, audit, and governance obligations associated with this role or unit been identified and reassigned to an accountable owner?", hints: [] },
    { key: "cr_transfer_plan", text: "Is there a clear plan for transferring remaining responsibilities, processes, systems access, and pending tasks before closure/removal?", hints: [] },
    { key: "cr_risks", text: "Will the closure/removal avoid creating service gaps, control risks, compliance issues, or business continuity problems?", hints: [] },
  ],
  merge_split: [
    { key: "ms_reason", text: "Is there a clearly identified business reason that requires merging or splitting this position, unit, or department?", hints: [] },
    { key: "ms_improvements", text: "Will the proposed merge or split result in measurable improvements?", hints: ["Accountability", "Efficiency", "Service quality", "Cost optimization", "Business performance"] },
    { key: "ms_handoffs", text: "Have handoffs and dependencies between teams been reviewed to avoid new silos or coordination issues?", hints: [] },
  ],
  name_change: [
    { key: "nc_accuracy", text: "Does the proposed name accurately reflect the actual scope, accountability, purpose, and organizational level of the position or unit?", hints: [] },
  ],
};
