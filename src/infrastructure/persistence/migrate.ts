import { MikroORM } from "@mikro-orm/postgresql";
import config from "./mikro-orm.config";

/** Uso: bun src/infrastructure/persistence/migrate.ts <up|down|status> */
const command = process.argv[2] ?? "status";

const orm = await MikroORM.init(config);
try {
  const migrator = orm.getMigrator();
  switch (command) {
    case "up": {
      const applied = await migrator.up();
      console.log(applied.length ? `applied: ${applied.map((m) => m.name).join(", ")}` : "nothing to apply");
      break;
    }
    case "down": {
      const reverted = await migrator.down();
      console.log(reverted.length ? `reverted: ${reverted.map((m) => m.name).join(", ")}` : "nothing to revert");
      break;
    }
    case "status": {
      const executed = await migrator.getExecutedMigrations();
      const pending = await migrator.getPendingMigrations();
      console.log(`executed: ${executed.map((m) => m.name).join(", ") || "-"}`);
      console.log(`pending:  ${pending.map((m) => m.name).join(", ") || "-"}`);
      break;
    }
    default:
      console.error(`unknown command "${command}" (use up | down | status)`);
      process.exitCode = 1;
  }
} finally {
  await orm.close(true);
}
