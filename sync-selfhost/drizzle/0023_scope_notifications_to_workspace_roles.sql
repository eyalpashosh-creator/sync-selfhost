ALTER TABLE `notifications` ADD `recipient_role` text;
--> statement-breakpoint
UPDATE `notifications`
SET `recipient_role` = CASE
  WHEN `kind` IN ('invite_received', 'draft_accepted', 'draft_declined') THEN 'curator'
  WHEN `kind` IN ('invite_accepted', 'invite_declined', 'draft_uploaded') THEN 'artist'
  WHEN `kind` = 'resolve_requested' THEN COALESCE(
    (SELECT CASE WHEN c.resolve_requested_by_role = 'artist' THEN 'curator' ELSE 'artist' END
     FROM collaborations c WHERE c.id = notifications.invite_id),
    'artist'
  )
  WHEN `user_id` = (SELECT c.curator_user_id FROM collaborations c WHERE c.id = notifications.invite_id) THEN 'curator'
  ELSE 'artist'
END
WHERE `recipient_role` IS NULL;