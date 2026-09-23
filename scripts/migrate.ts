import { openDatabase, migrate } from "../src/db.js";

const db = openDatabase();
const applied = migrate(db);
console.log(applied.length ? `已应用迁移版本: ${applied.join(", ")}` : "数据库已是最新");
db.close();
