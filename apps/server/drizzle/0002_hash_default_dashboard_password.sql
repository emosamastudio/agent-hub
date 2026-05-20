UPDATE "projects"
SET "dashboard_password_hash" = NULL
WHERE "dashboard_password_hash" = 'admin';
