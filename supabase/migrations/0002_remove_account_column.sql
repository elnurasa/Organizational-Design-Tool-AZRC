-- =============================================================================
-- 0002_remove_account_column.sql
-- -----------------------------------------------------------------------------
-- Drops the "account" column from managers/hrbps/od. The Admin Panel no
-- longer collects or displays it (Full Name / Job Title / .../ Mail /
-- Password is now the complete field set) — sign-in was always email-based,
-- so this has no effect on authentication.
--
-- Run this once in the Supabase Dashboard -> SQL Editor, after
-- 0001_admin_panel.sql. Dropping the column also drops its UNIQUE
-- constraint/index automatically.
-- =============================================================================

alter table managers drop column account;
alter table hrbps drop column account;
alter table od drop column account;
