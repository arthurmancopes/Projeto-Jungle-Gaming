import { Migration } from "@mikro-orm/migrations";

/**
 * Schema inicial. As garantias de unicidade, imutabilidade e não-negatividade
 * vivem aqui, em constraints do banco — o código de aplicação é só a primeira defesa.
 */
export class Migration20261114000001_InitialSchema extends Migration {
  override async up(): Promise<void> {
    // ------------------------------------------------------------- wallets
    this.addSql(`
      CREATE TABLE wallets (
        id          uuid          PRIMARY KEY,
        player_id   uuid          NOT NULL,
        currency    char(3)       NOT NULL,
        balance     numeric(20,2) NOT NULL,
        version     integer       NOT NULL,
        created_at  timestamptz   NOT NULL,
        updated_at  timestamptz   NOT NULL,
        CONSTRAINT wallets_player_currency_uq   UNIQUE (player_id, currency),
        CONSTRAINT wallets_balance_non_negative CHECK (balance >= 0),
        CONSTRAINT wallets_version_positive     CHECK (version >= 1),
        CONSTRAINT wallets_currency_iso         CHECK (currency ~ '^[A-Z]{3}$')
      );
    `);

    // -------------------------------------------------- wager_transactions
    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                 uuid          PRIMARY KEY,
        provider_id                        text          NOT NULL,
        external_transaction_id            text          NOT NULL,
        idempotency_key                    text          NOT NULL,
        payload_hash                       char(64)      NOT NULL,
        wallet_id                          uuid          NOT NULL REFERENCES wallets (id),
        player_id                          uuid          NOT NULL,
        round_id                           text          NOT NULL,
        game_id                            text          NOT NULL,
        kind                               text          NOT NULL,
        amount                             numeric(20,2) NOT NULL,
        currency                           char(3)       NOT NULL,
        reference_external_transaction_id  text,
        reference_transaction_id           uuid          REFERENCES wager_transactions (id),
        status                             text          NOT NULL,
        failure_code                       text,
        observed_balance                   numeric(20,2),
        reference_attempts                 integer       NOT NULL DEFAULT 0,
        next_reference_attempt_at          timestamptz,
        created_at                         timestamptz   NOT NULL,
        processed_at                       timestamptz,
        CONSTRAINT wager_tx_idempotency_key_uq UNIQUE (idempotency_key),
        CONSTRAINT wager_tx_provider_external_uq UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT wager_tx_kind_valid CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        CONSTRAINT wager_tx_status_valid CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        CONSTRAINT wager_tx_amount_non_negative CHECK (amount >= 0),
        CONSTRAINT wager_tx_currency_iso CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT wager_tx_reversal_requires_reference
          CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT wager_tx_failure_has_code
          CHECK (status NOT IN ('REJECTED','FAILED') OR failure_code IS NOT NULL),
        CONSTRAINT wager_tx_processed_reversal_has_reference
          CHECK (NOT (status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')) OR reference_transaction_id IS NOT NULL),
        CONSTRAINT wager_tx_pending_has_schedule
          CHECK (status <> 'PENDING_REFERENCE' OR next_reference_attempt_at IS NOT NULL)
      );
    `);

    // Uma referência só pode ser revertida uma vez (por REFUND ou por ROLLBACK).
    this.addSql(`
      CREATE UNIQUE INDEX wager_tx_single_reversal_uq
        ON wager_transactions (reference_transaction_id)
        WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED';
    `);
    // Fila do worker de referências pendentes.
    this.addSql(`
      CREATE INDEX wager_tx_pending_reference_idx
        ON wager_transactions (next_reference_attempt_at)
        WHERE status = 'PENDING_REFERENCE';
    `);
    this.addSql(`CREATE INDEX wager_tx_wallet_idx ON wager_transactions (wallet_id, created_at);`);

    // ----------------------------------------------- wallet_ledger_entries
    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id              uuid          PRIMARY KEY,
        seq             bigserial     NOT NULL,
        wallet_id       uuid          NOT NULL REFERENCES wallets (id),
        transaction_id  uuid          NOT NULL REFERENCES wager_transactions (id),
        direction       text          NOT NULL,
        amount          numeric(20,2) NOT NULL,
        currency        char(3)       NOT NULL,
        balance_before  numeric(20,2) NOT NULL,
        balance_after   numeric(20,2) NOT NULL,
        created_at      timestamptz   NOT NULL,
        CONSTRAINT ledger_seq_uq UNIQUE (seq),
        CONSTRAINT ledger_one_entry_per_tx_wallet_uq UNIQUE (transaction_id, wallet_id),
        CONSTRAINT ledger_direction_valid CHECK (direction IN ('DEBIT','CREDIT')),
        CONSTRAINT ledger_amount_positive CHECK (amount > 0),
        CONSTRAINT ledger_balances_non_negative CHECK (balance_before >= 0 AND balance_after >= 0),
        CONSTRAINT ledger_arithmetic CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
          (direction = 'DEBIT'  AND balance_after = balance_before - amount)
        )
      );
    `);
    // Paginação por cursor e reconciliação.
    this.addSql(`CREATE INDEX ledger_wallet_seq_idx ON wallet_ledger_entries (wallet_id, seq);`);

    // Ledger append-only: UPDATE e DELETE são bloqueados no banco.
    this.addSql(`
      CREATE FUNCTION forbid_ledger_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only (% not allowed)', TG_OP
          USING ERRCODE = 'restrict_violation';
      END;
      $$ LANGUAGE plpgsql;
    `);
    this.addSql(`
      CREATE TRIGGER ledger_immutable
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();
    `);

    // ------------------------------------------------------ inbox_messages
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name  text         NOT NULL,
        message_id     text         NOT NULL,
        payload_hash   char(64)     NOT NULL,
        received_at    timestamptz  NOT NULL,
        processed_at   timestamptz,
        CONSTRAINT inbox_messages_pk PRIMARY KEY (consumer_name, message_id)
      );
    `);

    // ----------------------------------------------------- outbox_messages
    this.addSql(`
      CREATE TABLE outbox_messages (
        id               uuid         PRIMARY KEY,
        aggregate_id     uuid         NOT NULL,
        event_type       text         NOT NULL,
        payload          jsonb        NOT NULL,
        occurred_at      timestamptz  NOT NULL,
        attempts         integer      NOT NULL DEFAULT 0,
        next_attempt_at  timestamptz,
        published_at     timestamptz,
        CONSTRAINT outbox_attempts_non_negative CHECK (attempts >= 0)
      );
    `);
    // O publisher só enxerga pendentes; o índice parcial mantém a busca barata.
    this.addSql(`
      CREATE INDEX outbox_pending_idx
        ON outbox_messages (occurred_at)
        WHERE published_at IS NULL;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS outbox_messages;`);
    this.addSql(`DROP TABLE IF EXISTS inbox_messages;`);
    this.addSql(`DROP TABLE IF EXISTS wallet_ledger_entries;`);
    this.addSql(`DROP FUNCTION IF EXISTS forbid_ledger_mutation();`);
    this.addSql(`DROP TABLE IF EXISTS wager_transactions;`);
    this.addSql(`DROP TABLE IF EXISTS wallets;`);
  }
}
