import type { MigrationObject } from "@mikro-orm/core";
import { Migration20261114000001_InitialSchema } from "./Migration20261114000001_InitialSchema";

/** Lista explícita (em ordem): evita descoberta por glob e funciona igual em qualquer runtime. */
export const migrationsList: MigrationObject[] = [
  { name: "Migration20261114000001_InitialSchema", class: Migration20261114000001_InitialSchema },
];
