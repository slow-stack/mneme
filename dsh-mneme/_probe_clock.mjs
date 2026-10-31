
import { createStore } from "./src/store.js";
import { createService } from "./src/service.js";
const store = createStore(":memory:");
const service = createService(store, {});
const a = service.saveWithDedupe({ type: "project", title: "A", content: "内容A 关于主题X", importance: 3 }).memory;
const b = service.saveWithDedupe({ type: "project", title: "B", content: "内容B 关于主题X", importance: 3 }).memory;
console.log("a.updated_at", a.updated_at, "b.updated_at", b.updated_at, "wall", new Date().toISOString());
console.log("ledger fn?", typeof service.saveConflictReviewed, typeof service.loadConflictReviewed);
store.close();
