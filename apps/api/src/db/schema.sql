-- Omniflow API schema (slice). Idempotent: safe to run on every start.

CREATE TABLE IF NOT EXISTS orgs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  chain_id     integer NOT NULL,
  account      text NOT NULL,          -- Kernel account (checksummed)
  validator    text NOT NULL,          -- WeightedECDSAValidator
  escrow       text NOT NULL,
  token        text NOT NULL,
  threshold    integer NOT NULL CHECK (threshold > 0),
  auto_refund_days integer,            -- default for payouts; NULL = never
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_id, account)
);

CREATE TABLE IF NOT EXISTS approvers (
  org_id   uuid NOT NULL REFERENCES orgs(id),
  address  text NOT NULL,
  weight   integer NOT NULL CHECK (weight > 0),
  PRIMARY KEY (org_id, address)
);

CREATE TABLE IF NOT EXISTS payouts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES orgs(id),
  title        text NOT NULL,
  status       text NOT NULL DEFAULT 'draft',
  auto_refund_days integer,            -- per-payout override; NULL = take org default
  created_at   timestamptz NOT NULL DEFAULT now(),
  closed_at    timestamptz
);

CREATE TABLE IF NOT EXISTS payout_rows (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_id    uuid NOT NULL REFERENCES payouts(id),
  row_key      text NOT NULL,
  name         text NOT NULL,
  email        text,
  address      text,
  chain_id     integer NOT NULL,
  amount       numeric(78,0) NOT NULL CHECK (amount > 0),
  status       text NOT NULL,
  batch_id     uuid,
  deposit_id   text,
  claim_signer text,
  fail_reason  text,
  tx_hash      text,
  auto_refund_at timestamptz,         -- NULL = never
  UNIQUE (payout_id, row_key)
);

CREATE TABLE IF NOT EXISTS batches (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_id    uuid NOT NULL REFERENCES payouts(id),
  batch_no     integer NOT NULL,
  kind         text NOT NULL DEFAULT 'pay' CHECK (kind IN ('pay', 'revoke')),
  nonce        numeric(78,0) NOT NULL,
  manifest     jsonb NOT NULL,
  call_data    text NOT NULL,
  approve_hash text NOT NULL,          -- callDataAndNonceHash
  status       text NOT NULL,          -- collecting | ready_to_submit | submitted | mined | failed
  final_op     jsonb,                  -- op draft given to the final signer
  user_op_hash text,
  tx_hash      text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payout_id, batch_no)         -- double-send guard, layer 3
);

CREATE TABLE IF NOT EXISTS approvals (
  batch_id   uuid NOT NULL REFERENCES batches(id),
  approver   text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('approve', 'final')),
  signature  text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id, approver)
);

-- ciphertext of the claim key lives here only until the claim email is sent, then the row is deleted.
CREATE TABLE IF NOT EXISTS claim_keys (
  row_id     uuid PRIMARY KEY REFERENCES payout_rows(id),
  iv         text NOT NULL,
  ciphertext text NOT NULL,
  tag        text NOT NULL
);

CREATE TABLE IF NOT EXISTS emails (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  row_id    uuid NOT NULL REFERENCES payout_rows(id),
  kind      text NOT NULL,
  sent_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (row_id, kind)
);

-- Indexer idempotency: each log is applied once.
CREATE TABLE IF NOT EXISTS applied_logs (
  chain_id  integer NOT NULL,
  tx_hash   text NOT NULL,
  log_index integer NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index)
);

CREATE TABLE IF NOT EXISTS indexer_cursor (
  chain_id   integer PRIMARY KEY,
  last_block numeric(78,0) NOT NULL
);

-- ---------------------------------------------------------------- users, members, setup, audit

CREATE TABLE IF NOT EXISTS users (
  did        text PRIMARY KEY,
  email      text,
  wallet     text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Roles: admin (members, settings), operator (role A: prepares payouts), approver (role B: signs).
CREATE TABLE IF NOT EXISTS org_members (
  org_id     uuid NOT NULL REFERENCES orgs(id),
  email      text NOT NULL,
  did        text,
  roles      text[] NOT NULL,
  status     text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active','removed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, email)
);

-- Flow 1: an organisation account being set up — approvers join, confirm the set, then it is deployed.
CREATE TABLE IF NOT EXISTS org_setups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  chain_id    integer NOT NULL,
  threshold   integer NOT NULL CHECK (threshold > 0),
  status      text NOT NULL DEFAULT 'collecting' CHECK (status IN ('collecting','confirming','deployed','cancelled')),
  account     text,
  salt        text NOT NULL,
  created_by  text NOT NULL,
  creator_email text NOT NULL,
  operators   text[] NOT NULL DEFAULT '{}',
  auto_refund_days integer,
  org_id      uuid REFERENCES orgs(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS org_setup_approvers (
  setup_id     uuid NOT NULL REFERENCES org_setups(id),
  email        text NOT NULL,
  weight       integer NOT NULL CHECK (weight > 0),
  wallet       text,
  confirmation text,
  PRIMARY KEY (setup_id, email)
);

-- who did what. Append-only.
CREATE TABLE IF NOT EXISTS audit_log (
  id       bigserial PRIMARY KEY,
  org_id   uuid,
  actor    text,
  action   text NOT NULL,
  details  jsonb,
  at       timestamptz NOT NULL DEFAULT now()
);

-- a details form link per row. Only the hash of the token is stored.
CREATE TABLE IF NOT EXISTS detail_forms (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  row_id     uuid NOT NULL REFERENCES payout_rows(id),
  token_hash text UNIQUE NOT NULL,
  expires_at timestamptz NOT NULL,
  filled_at  timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE payout_rows ADD COLUMN IF NOT EXISTS details_source text;   -- 'csv' | 'form' | 'address_book' | 'repeat'
ALTER TABLE payout_rows ADD COLUMN IF NOT EXISTS category text;

-- address book, filled by hand and from paid rows.
CREATE TABLE IF NOT EXISTS address_book (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES orgs(id),
  name       text NOT NULL,
  email      text,
  address    text,
  chain_id   integer NOT NULL,
  category   text,
  last_amount numeric(78,0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

-- recurring payouts create a draft from a template payout; approval stays mandatory.
CREATE TABLE IF NOT EXISTS schedules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES orgs(id),
  title        text NOT NULL,
  template_payout_id uuid NOT NULL REFERENCES payouts(id),
  every        text NOT NULL CHECK (every IN ('week','month')),
  next_run_at  timestamptz NOT NULL,
  active       boolean NOT NULL DEFAULT true,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE batches DROP CONSTRAINT IF EXISTS batches_kind_check;
ALTER TABLE batches ADD CONSTRAINT batches_kind_check CHECK (kind IN ('pay','revoke','rekey'));
ALTER TABLE payout_rows ADD COLUMN IF NOT EXISTS executed_at timestamptz;   -- block time of the batch
ALTER TABLE payout_rows ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
ALTER TABLE payout_rows ADD COLUMN IF NOT EXISTS rekey_pending boolean NOT NULL DEFAULT false;
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS schedule_id uuid;
