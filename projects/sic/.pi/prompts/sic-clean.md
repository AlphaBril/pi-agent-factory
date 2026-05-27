---
description: Clean old SIC session folders
argument-hint: "[max-age-days]"
---
Clean up old session folders from `.pi/sessions/`. 

If a number is provided, show sessions older than that many days and offer to delete them. Otherwise, just list all sessions with their ages.

Call `clean_sessions` with max_age_days=$1 (if provided) and dry_run=true first to preview, then confirm with the user before deleting.

$@
