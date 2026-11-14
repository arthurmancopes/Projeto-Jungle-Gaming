/** Tokens de injeção: os casos de uso são classes puras, montadas por factories no módulo. */
export const ORM = Symbol("ORM");
export const SQS_CLIENT = Symbol("SQS_CLIENT");
export const UNIT_OF_WORK = Symbol("UNIT_OF_WORK");
export const CREATE_WALLET = Symbol("CREATE_WALLET");
export const SUBMIT_WAGER = Symbol("SUBMIT_WAGER");
export const GET_WALLET = Symbol("GET_WALLET");
export const GET_TRANSACTION = Symbol("GET_TRANSACTION");
export const LIST_LEDGER = Symbol("LIST_LEDGER");
export const RECONCILE_WALLET = Symbol("RECONCILE_WALLET");
export const PROVIDER_IDENTITY = Symbol("PROVIDER_IDENTITY");
export const PUBLISH_OUTBOX = Symbol("PUBLISH_OUTBOX");
export const RETRY_PENDING_REFERENCES = Symbol("RETRY_PENDING_REFERENCES");
export const LOGGER = Symbol("LOGGER");
export const RUNTIME_OPTIONS = Symbol("RUNTIME_OPTIONS");

export interface RuntimeOptions {
  /** false sobe só a API HTTP (usado nos testes da API e com WORKERS_ENABLED=false). */
  workers: boolean;
}
