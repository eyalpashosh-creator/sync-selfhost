UPDATE curator_profiles
SET invite_credits_remaining = max(
  0,
  CASE invite_plan WHEN 'starter' THEN 5 ELSE 20 END - (
    SELECT count(*)
    FROM collaborations
    WHERE collaborations.curator_user_id = curator_profiles.user_id
      AND collaborations.accepted_at IS NOT NULL
      AND collaborations.accepted_at >= unixepoch(datetime(curator_profiles.invite_credits_reset_at / 1000, 'unixepoch', '-1 month')) * 1000
  )
)
WHERE invite_plan IN ('starter', 'growth');
--> statement-breakpoint
CREATE TRIGGER collaborations_accept_credit_guard
BEFORE UPDATE OF status ON collaborations
WHEN OLD.status = 'invited' AND NEW.status = 'accepted'
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM curator_profiles
      WHERE user_id = NEW.curator_user_id
        AND (invite_plan = 'professional' OR invite_credits_remaining > 0)
    )
    THEN RAISE(ABORT, 'invite credits exhausted')
  END;

  UPDATE curator_profiles
  SET invite_credits_remaining = invite_credits_remaining - 1
  WHERE user_id = NEW.curator_user_id
    AND invite_plan IN ('starter', 'growth')
    AND invite_credits_remaining > 0;
END;
