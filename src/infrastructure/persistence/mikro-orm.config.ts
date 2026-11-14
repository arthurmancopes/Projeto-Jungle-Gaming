import { Migrator } from "@mikro-orm/migrations";
import { defineConfig } from "@mikro-orm/postgresql";
import { migrationsList } from "../migrations";
import { schemas } from "./schemas";

export const DEFAULT_DATABASE_URL = "postgres://wagering:wagering@localhost:5432/wagering";

export default defineConfig({
  clientUrl: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
  entities: schemas,
  pool: { min: 2, max: Number(process.env.DB_POOL_MAX ?? 20) },
  extensions: [Migrator],
  migrations: {
    tableName: "schema_migrations",
    migrationsList,
    transactional: true,
    allOrNothing: true,
    snapshot: false,
  },
});
