# Serializing Protobuf Responses

Skill responses are protobuf message objects from `@bufbuild/protobuf`. **Do not use `JSON.stringify()` directly** on RPC results — it throws on `BigInt` fields and produces empty objects for oneof ADT fields.

## Recommended helpers (RPC responses)

```typescript
import { toJson, toJsonString } from "@huaqiu/hqeda";
// Also available from @huaqiu/huaqiu-client in this package's template.

// Plain JSON object (BigInts → strings)
const jsonObj = toJson(result);

// Formatted JSON string
const jsonStr = toJsonString(result, { prettySpaces: 2 });

// Include zero-valued fields
const full = toJsonString(result, { alwaysEmitImplicit: true });
```

These helpers handle:

- **BigInt fields** — converted to strings (protobuf JSON convention)
- **oneof fields** — serialized as `{ case, value }` ADT objects
- **Well-known types** — `Timestamp` → ISO string, `Duration` → `"Ns"` format, `Struct` → plain object
- **bytes fields** — base64-encoded strings
- **Zero-value omission** — empty fields excluded by default (protobuf default)

## Common mistake (protobuf messages)

```typescript
// Wrong — throws "Do not know how to serialize a BigInt"
JSON.stringify(result);

// Correct
toJsonString(result);
```

## Snapshot / position BigInt (raw traversal)

Even after you pull fields out of a snapshot (e.g. `pin.position.x/y`), those
coordinates are still **`bigint`**. If you build a plain object and call
`JSON.stringify` without a replacer, you hit:

```text
TypeError: Do not know how to serialize a BigInt
```

Use a replacer whenever you stringify **extracted** snapshot data (not only
whole RPC messages):

```typescript
const bigIntSafe = (_k: string, v: unknown) =>
  typeof v === "bigint" ? String(v) : v;

console.log(JSON.stringify(row, bigIntSafe, 2));
```

Prefer `toJsonString` for full RPC responses; use the replacer for hand-built
summaries from `GetSnapshot` fields.
