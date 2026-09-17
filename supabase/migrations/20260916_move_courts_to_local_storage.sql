-- ViewPadel: decouple matches from the cloud courts table.
-- Desktop keeps using matches.court_id as the stable local court UUID.
-- Run this migration before deploying the Desktop build that writes court_name.

ALTER TABLE public.matches
  ADD COLUMN IF NOT EXISTS court_name text;

-- Preserve the historical display name before Desktop stops reading courts.
UPDATE public.matches AS matches
SET court_name = courts.name
FROM public.courts AS courts
WHERE matches.court_name IS NULL
  AND matches.court_id = courts.id;

-- Recover the profile scope for legacy matches before the cloud court row becomes optional.
UPDATE public.matches AS matches
SET profile_id = courts.profile_id
FROM public.courts AS courts
WHERE matches.profile_id IS NULL
  AND matches.court_id = courts.id
  AND courts.profile_id IS NOT NULL;

-- court_id remains the local UUID snapshot for compatibility with existing matches,
-- but it must no longer require a row in the cloud courts table.
DO $$
DECLARE
  foreign_key record;
BEGIN
  FOR foreign_key IN
    SELECT constraint_record.conname
    FROM pg_constraint AS constraint_record
    JOIN pg_class AS local_table
      ON local_table.oid = constraint_record.conrelid
    JOIN pg_namespace AS local_schema
      ON local_schema.oid = local_table.relnamespace
    JOIN pg_class AS referenced_table
      ON referenced_table.oid = constraint_record.confrelid
    JOIN pg_namespace AS referenced_schema
      ON referenced_schema.oid = referenced_table.relnamespace
    WHERE constraint_record.contype = 'f'
      AND local_schema.nspname = 'public'
      AND local_table.relname = 'matches'
      AND referenced_schema.nspname = 'public'
      AND referenced_table.relname = 'courts'
  LOOP
    EXECUTE format(
      'ALTER TABLE public.matches DROP CONSTRAINT IF EXISTS %I',
      foreign_key.conname
    );
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS matches_profile_court_start_time_idx
  ON public.matches (profile_id, court_id, start_time);

COMMENT ON COLUMN public.matches.court_id IS
  'Stable local UUID of the Desktop court; no foreign key to public.courts.';
COMMENT ON COLUMN public.matches.court_name IS
  'Historical court name snapshot captured when the match is created.';

-- Desktop only reads public.courts during the one-time legacy migration. Remove the
-- broad public read policy while retaining profile-scoped and service-role policies.
DROP POLICY IF EXISTS select_courts_public ON public.courts;
