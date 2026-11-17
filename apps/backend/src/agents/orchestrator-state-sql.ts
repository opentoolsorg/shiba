type Binding = string | number | boolean | null;
type Storage = Pick<DurableObjectStorage, "sql" | "transactionSync">;
type CollectionRow = { collection: string; item_key: string; ordinal: number; value: string };
type Descriptor = { kind: "array" | "record"; size: number };
type Envelope = {
  format: "shiba.orchestrator.sqlite.v1";
  metadata: Record<string, unknown>;
  collections: Record<string, Descriptor>;
};

const FORMAT = "shiba.orchestrator.sqlite.v1";
const STATE_ROW = "cf_state_row_id";

function persist(storage: Storage, state: Record<string, unknown>): Envelope {
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS shiba_orchestrator_collections (
    collection TEXT NOT NULL, item_key TEXT NOT NULL, ordinal INTEGER NOT NULL,
    value TEXT NOT NULL, PRIMARY KEY (collection, item_key))`);
  const previous = new Map(
    [
      ...storage.sql.exec<CollectionRow>(
        "SELECT collection, item_key, ordinal, value FROM shiba_orchestrator_collections",
      ),
    ].map((row) => [JSON.stringify([row.collection, row.item_key]), row]),
  );
  const metadata: Record<string, unknown> = {};
  const collections: Record<string, Descriptor> = Object.create(null);
  for (const [field, value] of Object.entries(state)) {
    if (value === null || typeof value !== "object") {
      Object.defineProperty(metadata, field, { value, enumerable: true });
      continue;
    }
    const array = Array.isArray(value);
    const entries = Object.entries(value);
    collections[field] = { kind: array ? "array" : "record", size: entries.length };
    for (const [ordinal, [key, member]] of entries.entries()) {
      const encoded = JSON.stringify(member);
      const identity = JSON.stringify([field, key]);
      const prior = previous.get(identity);
      if (!prior || prior.value !== encoded || prior.ordinal !== ordinal) {
        storage.sql.exec(
          `INSERT OR REPLACE INTO shiba_orchestrator_collections
          (collection, item_key, ordinal, value) VALUES (?, ?, ?, ?)`,
          field,
          key,
          ordinal,
          encoded,
        );
      }
      previous.delete(identity);
    }
  }
  for (const row of previous.values()) {
    storage.sql.exec(
      "DELETE FROM shiba_orchestrator_collections WHERE collection = ? AND item_key = ?",
      row.collection,
      row.item_key,
    );
  }
  return { format: FORMAT, metadata, collections };
}

function hydrate(storage: Storage, envelope: Envelope): Record<string, unknown> {
  if (
    !envelope.metadata ||
    typeof envelope.metadata !== "object" ||
    Array.isArray(envelope.metadata) ||
    !envelope.collections ||
    typeof envelope.collections !== "object" ||
    Array.isArray(envelope.collections)
  ) {
    throw new Error("Invalid orchestrator SQLite manifest.");
  }
  const rows = [
    ...storage.sql.exec<CollectionRow>(
      "SELECT collection, item_key, ordinal, value FROM shiba_orchestrator_collections ORDER BY collection, ordinal",
    ),
  ];
  const fields = new Map<string, CollectionRow[]>();
  for (const row of rows) {
    const members = fields.get(row.collection) ?? [];
    members.push(row);
    fields.set(row.collection, members);
  }
  const restored = Object.entries(envelope.collections).map(([field, descriptor]) => {
    const members = fields.get(field) ?? [];
    if (
      !descriptor ||
      !["array", "record"].includes(descriptor.kind) ||
      !Number.isSafeInteger(descriptor.size) ||
      descriptor.size < 0 ||
      members.length !== descriptor.size ||
      members.some(
        (row, index) =>
          row.ordinal !== index || (descriptor.kind === "array" && row.item_key !== String(index)),
      )
    ) {
      throw new Error(`Incomplete orchestrator collection: ${field}`);
    }
    const entries = members.map((row) => [row.item_key, JSON.parse(row.value)] as const);
    return [
      field,
      descriptor.kind === "array" ? entries.map(([, value]) => value) : Object.fromEntries(entries),
    ] as const;
  });
  return Object.fromEntries([...Object.entries(envelope.metadata), ...restored]);
}

export function orchestratorStateSql<T>(
  storage: Storage,
  strings: TemplateStringsArray,
  values: Binding[],
  execute: (bindings: Binding[]) => T[],
): T[] {
  const query = strings.join("?").replace(/\s+/g, " ").trim();
  if (values[0] !== STATE_ROW) return execute(values);
  if (query === "INSERT OR REPLACE INTO cf_agents_state (id, state) VALUES (?, ?)") {
    const serialized = values[1];
    if (typeof serialized !== "string") return execute(values);
    const state: unknown = JSON.parse(serialized);
    if (!state || typeof state !== "object" || Array.isArray(state)) return execute(values);
    return storage.transactionSync(() =>
      execute([STATE_ROW, JSON.stringify(persist(storage, state as Record<string, unknown>))]),
    );
  }
  const result = execute(values);
  if (query !== "SELECT state FROM cf_agents_state WHERE id = ?") return result;
  if (
    !result.length &&
    [
      ...storage.sql.exec(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'shiba_orchestrator_collections'",
      ),
    ].length
  )
    throw new Error("Missing orchestrator SQLite manifest.");
  return result.map((row) => {
    if (!row || typeof row !== "object" || !("state" in row) || typeof row.state !== "string")
      return row;
    const state: unknown = JSON.parse(row.state);
    if (!state || typeof state !== "object" || Array.isArray(state)) return row;
    if ("format" in state && state.format === FORMAT) {
      return { ...row, state: JSON.stringify(hydrate(storage, state as Envelope)) };
    }
    storage.transactionSync(() => {
      const envelope = persist(storage, state as Record<string, unknown>);
      storage.sql.exec(
        "UPDATE cf_agents_state SET state = ? WHERE id = ?",
        JSON.stringify(envelope),
        STATE_ROW,
      );
    });
    return row;
  });
}
