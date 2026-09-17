/**
 * Wire fixtures for the hq-edge netlist route.
 *
 * ── Why these are not hand-written ──────────────────────────────────────────
 * The bug this guards against was invisible to the old tests precisely because
 * they asserted on a hand-written `{ netlist: { components: [], nets: [] } }`
 * literal that hq-edge never actually emitted. These objects are byte-exact
 * captures of `toJson()` output from the REAL generated schema
 * (`hq-edge/platform/sdk/ts/src/generated/hq/ir/schematic/v1/netlist_pb.ts`),
 * produced with `@bufbuild/protobuf` 2.15.0.
 *
 * To regenerate / verify, from the hq-edge repo:
 *
 *   import { create, toJson } from '@bufbuild/protobuf';
 *   import { GetNetListResponseSchema, SchematicNetlistSchema } from
 *     './platform/sdk/ts/src/generated/hq/ir/schematic/v1/netlist_pb.js';
 *
 *   const populated = create( GetNetListResponseSchema, {
 *     result: { case: 'netlist', value: create( SchematicNetlistSchema, {...} ) },
 *   } );
 *
 *   // current hq-edge (semantic result extracted before the HTTP boundary):
 *   console.log( JSON.stringify( { netlist: toJson( SchematicNetlistSchema,
 *     populated.result.value ) } ) );
 *
 *   // legacy hq-edge (envelope serialized — DOUBLE nested):
 *   console.log( JSON.stringify( { netlist: toJson( GetNetListResponseSchema,
 *     populated ) } ) );
 *
 * Note how proto3 JSON omits empty/default fields: an empty netlist serializes
 * as `{}`, not `{ "components": [], "nets": [] }`. That is why the parser treats
 * `undefined` as an empty list.
 */

/** A populated netlist, as CURRENT hq-edge emits it: one level. */
export const POPULATED_NETLIST_BODY = {
  netlist: {
    components: [
      {
        referenceDesignators: ['R1'],
        value: '10k',
        footprint: 'R_0603',
      },
    ],
    nets: [
      {
        name: 'GND',
        pinReferences: [{ referenceDesignator: 'R1', pinNumber: '2' }],
      },
    ],
  },
} as const;

/**
 * A populated netlist as LEGACY hq-edge emitted it.
 *
 * `routes/netlist.ts` used to serialize the whole `GetNetListResponse`, whose
 * payload is `oneof result { netlist | empty }` — so proto3 JSON emitted
 * `netlist` a second time. DSH read one level and saw an empty design.
 */
export const LEGACY_POPULATED_NETLIST_BODY = {
  netlist: {
    netlist: {
      components: [
        {
          referenceDesignators: ['R1'],
          value: '10k',
          footprint: 'R_0603',
        },
      ],
      nets: [
        {
          name: 'GND',
          pinReferences: [{ referenceDesignator: 'R1', pinNumber: '2' }],
        },
      ],
    },
  },
} as const;

/** A genuinely empty design, as CURRENT hq-edge emits it. */
export const EMPTY_NETLIST_BODY = { netlist: {} } as const;

/** A genuinely empty design, as LEGACY hq-edge emitted it. */
export const LEGACY_EMPTY_NETLIST_BODY = { netlist: { netlist: {} } } as const;

/**
 * What the host returns when the `result` oneof is unset (no handler could
 * provide the scope). hq-edge maps that to HTTP 412, so this body is only ever
 * seen if hq-edge itself is stale — the plugin must not report it as an empty
 * design either way.
 */
export const UNSET_RESULT_NETLIST_BODY = { netlist: {} } as const;
