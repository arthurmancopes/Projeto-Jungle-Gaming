export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  /** UUID (v7 na implementação padrão: ordenável por tempo). */
  next(): string;
}
