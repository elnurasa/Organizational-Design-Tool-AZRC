/**
 * request-service.js
 * ---------------------------------------------------------------------------
 * Data layer for the whole Structural Change Request workflow (Manager /
 * HRBP / OD modules), backed by real Supabase — direct reads/writes for
 * single-row operations (Row Level Security scopes what each role can see),
 * RPC calls (supabase/migrations/0004 + 0005) for anything that needs to
 * write more than one row atomically (save a draft + its answers, submit +
 * snapshot the requester's profile, a review's verdicts + status change +
 * history entry together).
 *
 * Every function keeps the exact shape the pages already call — only what's
 * inside these functions changed from the earlier in-memory mock version.
 * ---------------------------------------------------------------------------
 */

const REQUEST_PAGE_SIZE = 10;

/**
 * @returns {Promise<string>} the signed-in user's Supabase Auth id.
 * @throws {Error} if there's no active Supabase session.
 */
async function getCurrentAuthUserId() {
  const { data, error } = await supabaseClient.auth.getSession();
  if (error || !data || !data.session || !data.session.user) {
    throw new Error("Your session has expired. Please sign in again.");
  }
  return data.session.user.id;
}

/**
 * Batch-resolves full_name for a set of user ids in one query (avoids an
 * N+1 query per row when displaying "Requester"/"Assigned HRBP" names).
 *
 * @param {Array<string|null|undefined>} ids
 * @returns {Promise<Map<string, string>>}
 */
async function resolveUserNames(ids) {
  const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
  if (uniqueIds.length === 0) return new Map();

  const { data, error } = await supabaseClient.from("users").select("id, full_name").in("id", uniqueIds);
  if (error) throw new Error(error.message);

  return new Map((data || []).map((row) => [row.id, row.full_name]));
}

/**
 * Attaches display-friendly resolved names to a request row, and
 * reconstructs a requester_profile object (used by js/pdf-export.js) from
 * the requester_* snapshot columns taken at submit time — or, for a draft
 * that's never been submitted, falls back to a live name lookup since no
 * snapshot exists yet.
 *
 * @param {object} row
 * @param {Map<string, string>} nameById
 * @returns {object}
 */
function withResolvedNames(row, nameById) {
  return Object.assign({}, row, {
    requester_name: row.requester_full_name || nameById.get(row.requester_id) || "—",
    hrbp_name: row.assigned_hrbp_id ? nameById.get(row.assigned_hrbp_id) || "—" : "—",
    requester_profile: row.requester_full_name
      ? {
          full_name: row.requester_full_name,
          company: row.requester_company,
          job_title: row.requester_job_title,
          division: row.requester_division,
          department: row.requester_department,
          subdepartment: row.requester_subdepartment,
          unit: row.requester_unit,
          subunit: row.requester_subunit,
        }
      : null,
  });
}

/**
 * The category keys whose display label (CATEGORY_LABELS, js/request-
 * questions.js) contains the given search text — used so list search can
 * match on the label a user actually sees ("New department") even though
 * the database stores the raw key ("new_department").
 *
 * @param {string} search
 * @returns {string[]}
 */
function categoryKeysMatchingSearch(search) {
  const lower = search.toLowerCase();
  return REQUEST_CATEGORY_ORDER.filter((key) => (CATEGORY_LABELS[key] || key).toLowerCase().includes(lower));
}

function paginationRange(page, pageSize) {
  const from = ((page || 1) - 1) * (pageSize || REQUEST_PAGE_SIZE);
  return { from: from, to: from + (pageSize || REQUEST_PAGE_SIZE) - 1 };
}

// =============================================================================
// Profile / directory reads
// =============================================================================

/**
 * @returns {Promise<object>} the signed-in Manager's own profile fields, for
 *   Section 1 of the request form.
 */
async function getMyProfile() {
  requireSupabase();
  const userId = await getCurrentAuthUserId();

  const { data, error } = await supabaseClient.from("users").select("*").eq("id", userId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Your session has expired. Please sign in again.");

  return data;
}

/**
 * @returns {Promise<Array<{id: string, full_name: string}>>} every active
 *   HRBP, for the Assigned HRBP dropdown.
 */
async function listActiveHrbps() {
  requireSupabase();

  const { data, error } = await supabaseClient
    .from("users")
    .select("id, full_name")
    .eq("role", "hrbp")
    .eq("is_active", true)
    .order("full_name", { ascending: true });
  if (error) throw new Error(error.message);

  return data || [];
}

/**
 * PostgREST .or() filter part that matches a search string against the
 * human-friendly request number: "ORG-0007", "org7" and "7" all match
 * request 7. Non-numeric text matches no request number — the
 * "request_number.lt.0" part is always false, and is only there so the
 * caller's .or() list is never empty.
 *
 * @param {string} escaped the already-escaped search text
 * @returns {string[]}
 */
function requestNumberSearchParts(escaped) {
  const digits = escaped.replace(/^org[-\s]*/i, "");
  return /^\d+$/.test(digits) ? ["request_number.eq." + Number(digits)] : ["request_number.lt.0"];
}

// =============================================================================
// Manager: my requests
// =============================================================================

/**
 * @param {{page?: number, pageSize?: number, search?: string, status?: string}} options
 * @returns {Promise<{rows: object[], totalCount: number}>}
 */
async function listMyRequests(options) {
  requireSupabase();
  const opts = options || {};
  const range = paginationRange(opts.page, opts.pageSize);

  // Row Level Security (requests_manager_read) already scopes this to the
  // signed-in manager's own rows — no explicit requester_id filter needed.
  let query = supabaseClient.from("requests").select("*", { count: "exact" });

  const search = (opts.search || "").trim();
  if (search) {
    const escaped = search.replace(/[%,]/g, "");
    const orParts = requestNumberSearchParts(escaped).concat(
      categoryKeysMatchingSearch(escaped).map((key) => "category.eq." + key)
    );
    query = query.or(orParts.join(","));
  }

  // One status, or several as a comma-separated list ("submitted,hrbp_review":
  // two statuses that are shown under the same name).
  if (opts.status) {
    const statuses = opts.status.split(",");
    query = statuses.length > 1 ? query.in("status", statuses) : query.eq("status", opts.status);
  }

  query = query.order("updated_at", { ascending: false }).range(range.from, range.to);

  const { data, error, count } = await query;
  if (error) throw new Error(error.message);

  const rows = data || [];
  const nameById = await resolveUserNames(rows.flatMap((row) => [row.requester_id, row.assigned_hrbp_id]));
  return { rows: rows.map((row) => withResolvedNames(row, nameById)), totalCount: count || 0 };
}

/**
 * Loads one request. Permission is enforced by Row Level Security
 * (requester, assigned HRBP once non-draft, OD once od_review/resolved, or
 * an Admin) — RLS silently omits a row the caller isn't allowed to see
 * rather than erroring, so a denied id and a nonexistent id both surface
 * as the same "not found" message here (there is no way to tell them apart
 * from the client, which is the more secure behavior anyway).
 *
 * @param {string} id
 * @returns {Promise<object>}
 */
async function getRequestById(id) {
  requireSupabase();
  await getCurrentAuthUserId(); // throws if not signed in

  const { data: request, error } = await supabaseClient.from("requests").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!request) throw new Error("This request could not be found.");

  const [answersResult, historyResult, verdictHistoryResult, odVerdictHistoryResult] = await Promise.all([
    supabaseClient.from("request_answers").select("*").eq("request_id", id).order("sort_order", { ascending: true }),
    supabaseClient.from("request_history").select("*").eq("request_id", id).order("created_at", { ascending: true }),
    supabaseClient
      .from("hrbp_verdict_history")
      .select("*")
      .eq("request_id", id)
      .order("review_round", { ascending: true })
      .order("sort_order", { ascending: true }),
    supabaseClient
      .from("od_verdict_history")
      .select("*")
      .eq("request_id", id)
      .order("review_round", { ascending: true })
      .order("sort_order", { ascending: true }),
  ]);
  if (answersResult.error) throw new Error(answersResult.error.message);
  if (historyResult.error) throw new Error(historyResult.error.message);
  // The HRBP and OD decision histories are supplementary: if one can't be read
  // (e.g. its table hasn't been created yet) the request itself must still open.
  if (verdictHistoryResult.error) console.warn("HRBP decision history unavailable:", verdictHistoryResult.error.message);
  if (odVerdictHistoryResult.error) console.warn("OD decision history unavailable:", odVerdictHistoryResult.error.message);
  const verdictRows = verdictHistoryResult.error ? [] : verdictHistoryResult.data || [];
  // Row Level Security (0014) only returns these to the assigned HRBP, the OD
  // team and Admins — a requester's query comes back empty, not an error.
  const odVerdictRows = odVerdictHistoryResult.error ? [] : odVerdictHistoryResult.data || [];

  const history = historyResult.data || [];
  const nameById = await resolveUserNames(
    [request.requester_id, request.assigned_hrbp_id]
      .concat(history.map((entry) => entry.actor_id))
      .concat(verdictRows.map((row) => row.hrbp_id))
      .concat(odVerdictRows.map((row) => row.od_id))
  );

  const resolvedHistory = history.map((entry) =>
    Object.assign({}, entry, { actor_name: entry.actor_id ? nameById.get(entry.actor_id) || "—" : "—" })
  );

  // HRBP and OD rounds are numbered independently, so merge them by when they
  // happened — that is the order a question's History toggle should read in.
  const verdictHistory = groupVerdictHistory(verdictRows, nameById, "HRBP")
    .concat(groupVerdictHistory(odVerdictRows, nameById, "OD"))
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  return Object.assign(withResolvedNames(request, nameById), {
    answers: answersResult.data || [],
    history: resolvedHistory,
    verdict_history: verdictHistory,
  });
}

/**
 * Groups hrbp_verdict_history / od_verdict_history rows (one row per answer a
 * reviewer marked insufficient) into review rounds, oldest first.
 *
 * @param {Array<object>} rows
 * @param {Map<string, string>} nameById
 * @param {"HRBP" | "OD"} actor which reviewer's table these rows came from
 * @returns {Array<{round: number, actor: "HRBP" | "OD", actor_name: string, outcome: string, created_at: string, items: object[]}>}
 */
function groupVerdictHistory(rows, nameById, actor) {
  const rounds = new Map();
  rows.forEach((row) => {
    if (!rounds.has(row.review_round)) {
      rounds.set(row.review_round, {
        round: row.review_round,
        actor: actor,
        actor_name: nameById.get(actor === "OD" ? row.od_id : row.hrbp_id) || "—",
        outcome: row.outcome,
        created_at: row.created_at,
        items: [],
      });
    }
    rounds.get(row.review_round).items.push(row);
  });
  return Array.from(rounds.values());
}

/**
 * Creates (id omitted) or updates (id given) a draft, fully replacing its
 * answer set — save_request_draft() (supabase/migrations/0004, wording-
 * fixed in 0005) does this as one transaction, the same "replace, don't
 * merge" approach that avoids orphaned answers from a previous category
 * selection.
 *
 * @param {{id?: string, category: string, change_description: string,
 *   justification: string, requested_effective_date: string | null,
 *   assigned_hrbp_id: string | null,
 *   answers: Array<{question_key: string, question_text: string, answer: string, sort_order: number}>}} draft
 * @returns {Promise<string>} the request id.
 */
async function saveRequestDraft(draft) {
  requireSupabase();

  const { data, error } = await supabaseClient.rpc("save_request_draft", {
    p_request_id: draft.id || null,
    p_category: draft.category,
    p_change_description: draft.change_description,
    p_justification: draft.justification,
    p_requested_effective_date: draft.requested_effective_date,
    p_assigned_hrbp_id: draft.assigned_hrbp_id,
    p_answers: draft.answers,
  });
  if (error) throw new Error(error.message);

  return data;
}

/**
 * Just the fields needed to tell whether a request changed since it was
 * loaded (see assertNotChangedElsewhere() in create-request.js).
 * requests.updated_at moves on every write to the row, so it changes whenever
 * another tab saves or a reviewer acts.
 *
 * @param {string} id
 * @returns {Promise<{updated_at: string, status: string} | null>}
 */
async function getRequestUpdatedAt(id) {
  requireSupabase();

  const { data, error } = await supabaseClient.from("requests").select("updated_at, status").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * @param {string} id
 * @returns {Promise<void>}
 */
async function submitStructuralRequest(id) {
  requireSupabase();

  const { error } = await supabaseClient.rpc("submit_structural_request", { p_request_id: id });
  if (error) throw new Error(error.message);
}

/**
 * Withdraws a request that's currently sitting back with the requester
 * (status returned_to_requester) — a terminal action, same family as
 * approve/reject, via withdraw_request() (supabase/migrations/0007).
 *
 * @param {string} id
 * @param {string} [comment]
 * @returns {Promise<void>}
 */
async function withdrawRequest(id, comment) {
  requireSupabase();

  const { error } = await supabaseClient.rpc("withdraw_request", {
    p_request_id: id,
    p_comment: comment || null,
  });
  if (error) throw new Error(error.message);
}

/**
 * @param {string} id
 * @returns {Promise<void>}
 */
async function deleteDraftRequest(id) {
  requireSupabase();

  // Mirrors the mock's two distinct error cases (not found vs. not a
  // draft) by checking status before deleting, rather than relying on a
  // single generic failure from a denied/absent RLS delete.
  const { data: existing, error: fetchError } = await supabaseClient
    .from("requests")
    .select("id, status")
    .eq("id", id)
    .maybeSingle();
  if (fetchError) throw new Error(fetchError.message);
  if (!existing) throw new Error("This request could not be found.");
  if (existing.status !== "draft") throw new Error("Only drafts can be deleted.");

  const { error } = await supabaseClient.from("requests").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

// =============================================================================
// HRBP inbox / review
// =============================================================================

/**
 * @param {{page?: number, pageSize?: number, search?: string}} options
 * @returns {Promise<{rows: object[], totalCount: number}>}
 */
async function listHrbpInbox(options) {
  requireSupabase();
  const opts = options || {};
  const range = paginationRange(opts.page, opts.pageSize);

  // Row Level Security (requests_hrbp_read) already scopes this to requests
  // assigned to the signed-in HRBP with status <> 'draft'.
  let query = supabaseClient.from("requests").select("*", { count: "exact" }).neq("status", "draft");

  const search = (opts.search || "").trim();
  if (search) {
    const escaped = search.replace(/[%,]/g, "");
    const orParts = requestNumberSearchParts(escaped)
      .concat(["requester_full_name.ilike.%" + escaped + "%"])
      .concat(categoryKeysMatchingSearch(escaped).map((key) => "category.eq." + key));
    query = query.or(orParts.join(","));
  }

  query = query.order("updated_at", { ascending: false }).range(range.from, range.to);

  const { data, error, count } = await query;
  if (error) throw new Error(error.message);

  const rows = data || [];
  const nameById = await resolveUserNames(rows.flatMap((row) => [row.requester_id, row.assigned_hrbp_id]));
  return { rows: rows.map((row) => withResolvedNames(row, nameById)), totalCount: count || 0 };
}

/**
 * Fires the "submitted -> hrbp_review" transition the first time an HRBP
 * opens a request assigned to them — hrbp_mark_in_review()
 * (supabase/migrations/0004) is a best-effort no-op if the request isn't
 * in 'submitted' status (e.g. re-opening one already under review).
 *
 * @param {string} id
 * @returns {Promise<void>}
 */
async function markRequestInReview(id) {
  requireSupabase();

  const { error } = await supabaseClient.rpc("hrbp_mark_in_review", { p_request_id: id });
  if (error) throw new Error(error.message);
}

/**
 * Writes every per-answer verdict/comment and transitions the request —
 * od_review if every answer is 'sufficient', returned_to_requester
 * otherwise — via hrbp_submit_review() (supabase/migrations/0004, wording-
 * fixed in 0005). Covers both the first review and the "fix and resubmit"
 * path after OD sends it back (status returned_to_hrbp) — same outcome
 * logic either way.
 *
 * @param {string} id
 * @param {Array<{question_key: string, verdict: "sufficient"|"insufficient", comment: string}>} verdicts
 * @param {string} generalComment
 * @returns {Promise<{newStatus: string}>}
 */
async function hrbpSubmitReview(id, verdicts, generalComment, target) {
  requireSupabase();

  const { error } = await supabaseClient.rpc("hrbp_submit_review", {
    p_request_id: id,
    p_verdicts: verdicts,
    p_general_comment: generalComment || null,
    p_target: target || null,
  });
  if (error) throw new Error(error.message);

  return { newStatus: await fetchRequestStatus(id) };
}

// =============================================================================
// OD inbox / review
// =============================================================================

/**
 * @param {{page?: number, pageSize?: number, search?: string}} options
 * @returns {Promise<{rows: object[], totalCount: number}>}
 */
async function listOdInbox(options) {
  requireSupabase();
  const opts = options || {};
  const range = paginationRange(opts.page, opts.pageSize);

  // Row Level Security (requests_od_read) scopes this to requests currently
  // in od_review plus anything OD has ever resolved (od_reviewed) — shown
  // together here (not filtered to od_review only) so approved/rejected
  // requests stay visible instead of disappearing once OD acts on them.
  let query = supabaseClient.from("requests").select("*", { count: "exact" });

  const search = (opts.search || "").trim();
  if (search) {
    const escaped = search.replace(/[%,]/g, "");
    const orParts = requestNumberSearchParts(escaped)
      .concat(["requester_full_name.ilike.%" + escaped + "%"])
      .concat(categoryKeysMatchingSearch(escaped).map((key) => "category.eq." + key));
    query = query.or(orParts.join(","));
  }

  query = query.order("updated_at", { ascending: false }).range(range.from, range.to);

  const { data, error, count } = await query;
  if (error) throw new Error(error.message);

  const rows = data || [];
  const nameById = await resolveUserNames(rows.flatMap((row) => [row.requester_id, row.assigned_hrbp_id]));
  return { rows: rows.map((row) => withResolvedNames(row, nameById)), totalCount: count || 0 };
}

/**
 * Records that an OD team member has opened a request that is in od_review
 * (od_mark_opened(), supabase/migrations/0018) so the OD inbox stops
 * highlighting it as new. Best effort by design: it never throws, so a
 * database that hasn't had 0018 applied yet still opens the review page.
 *
 * @param {string} id
 * @returns {Promise<void>}
 */
async function odMarkOpened(id) {
  try {
    requireSupabase();
    await supabaseClient.rpc("od_mark_opened", { p_request_id: id });
  } catch (error) {
    // ignored on purpose — see above
  }
}

/**
 * @param {string} id
 * @param {"approve" | "reject" | "return_to_hrbp"} decision
 * @param {Array<{question_key: string, verdict: "sufficient"|"insufficient", comment: string}>} verdicts
 * @param {string} generalComment
 * @returns {Promise<{newStatus: string}>}
 */
async function odSubmitReview(id, decision, verdicts, generalComment) {
  requireSupabase();

  const { error } = await supabaseClient.rpc("od_submit_review", {
    p_request_id: id,
    p_decision: decision,
    p_verdicts: verdicts,
    p_general_comment: generalComment || null,
  });
  if (error) throw new Error(error.message);

  return { newStatus: await fetchRequestStatus(id) };
}

/**
 * hrbp_submit_review()/od_submit_review() return void (they're atomic
 * transactions, not readers) — the caller still needs the resulting status
 * to pick the right success-toast message, so this reads it back in one
 * cheap follow-up query rather than changing either RPC's return type.
 *
 * @param {string} id
 * @returns {Promise<string|null>}
 */
async function fetchRequestStatus(id) {
  const { data, error } = await supabaseClient.from("requests").select("status").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  return data ? data.status : null;
}
