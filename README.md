# Organizational Design Tool

Azerconnect Group's tool for structural change requests (new departments, units and positions, reporting-line changes, closures, merges and splits, renames). A manager files a request, an HRBP reviews every answer, and the OD team makes the final decision.

```
Manager  ──submits──▶  HRBP review  ──all sufficient──▶  OD review  ──▶  Approved / Rejected
   ▲                       │                                  │
   └────returned───────────┘◀────────returned to HRBP─────────┘
```

A static front end (plain HTML, CSS and JavaScript, no build step) talking directly to Supabase.

| Part | What it is |
|---|---|
| `*.html`, `css/`, `js/` | The app. One page per screen; `js/request-service.js` is the only file that reads or writes request data. |
| `supabase/migrations/` | The whole database: tables, Row Level Security, status rules and the workflow functions. |
| `supabase/functions/admin-api/` | Edge Function for the few things that need the `service_role` key: resolving a signed-in user's role and the Admin Panel's user management. |

## Run it locally

```bash
python devserver.py
```

Then open <http://localhost:8080>. `js/config.js` holds the Supabase project URL and the **anon** key (public by design — Row Level Security is what protects the data).

## Set up Supabase

1. Create a project and put its URL and anon key in `js/config.js`.
2. Run every file in `supabase/migrations/` **in numeric order** (`0001` … `0018`) in the SQL Editor. Each one is safe to re-run.
3. Deploy the Edge Function with JWT verification off (it verifies tokens itself):
   `supabase functions deploy admin-api --no-verify-jwt`
4. Create the first Admin through the function's one-time `bootstrapAdmin` action (set the `BOOTSTRAP_KEY` secret only for that run, then delete it).

## Starting clean (before handing the tool to users)

`supabase/maintenance/reset_request_data.sql` deletes every request and its answers, approval trail and review history for all users, and restarts numbering at ORG-0001. User accounts and settings are kept. It is **not** a migration — run it once, by hand, in the SQL Editor; it cannot be undone.

## Who can do what

Enforced by the database, not the pages:

- **Manager** — creates and edits their own request while it is a draft or has been returned to them; can withdraw a returned one.
- **HRBP** — sees requests assigned to them; marks each answer sufficient or insufficient; forwards to OD or returns to the manager.
- **OD** — sees requests that reached OD review; approves, rejects or returns to the HRBP.
- **Admin** — manages accounts in the Admin Panel (an extra permission on top of a role).
- Every history of a request is kept: each reviewer's insufficient answers are archived (`hrbp_verdict_history`, `od_verdict_history`) before the next review or a manager's edit can overwrite them. What HRBP and OD say to each other is never shown to the manager.

## Notes

- `apps-script/` and the three helper pages `bootstrap-setup.html`, `bulk-import-managers.html` and `bulk-reset-passwords.html` are from the earlier Google Apps Script backend, which the corporate network blocks. They are kept for reference and do not work.
- `managers_import_data.json` (real employee data) is git-ignored and must never be committed.
