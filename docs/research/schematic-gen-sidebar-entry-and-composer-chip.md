# “Schematic Gen” sidebar toolbutton → composer chip

> Companion to
> `hq-edge/docs/research/eda-selection-in-dsh-inputbox.md` (the ambient
> “Current Selection” chip). Same question, different trigger: here the chip is
> **user-gestured** — it appears because someone clicked a sidebar toolbutton,
> not because the host changed state.
>
> **Deliverable:** research + plan. **No production files were modified.**
>
> Goal: `@huaqiu/dsh-tool-schematic-gen` contributes a sidebar toolbutton like
> `component-gen-app` does; clicking **“Schematic Gen”** puts a chip reading
> **“Generate schematic”** into the composer (visually the same thing `@`
> produces), and the agent's prompt learns that the schematic-gen tool was
> chosen — all without touching DSH source.

---

## 0. Pinned sources

| Repo | Commit | Date | Role |
|---|---|---|---|
| `deepseek-harness` (DSH) | `7eac7881c6` | 2026-09-22 | Composer / `@` pipeline / slots / services / system prompt |
| `dsh-pcb-eda` | `91ba77e` | 2026-10-10 | Plugin family (`@huaqiu/*`) |

---

## 1. Executive summary

1. **A real `@`-chip can be inserted programmatically.** `SessionInput` — the
   per-session input facade reachable as
   `ctx.conversation.input.for(actx)` — exposes
   `insertReference(ref, span)` on its *frozen* face. Clicking a button can
   drop a genuine `ReferenceChipNode` into the Lexical draft. No DSH patch, no
   DOM forgery. (§4)
2. **The chip alone carries the prompt contribution.** The submit plane expands
   every chip through the owning source's `codec.serialize(ref)` and splices
   the result into the user message at the chip's offset. So
   “the user chose Schematic Gen” reaches the model **as part of the prompt
   text**, not as a system-prompt aside. (§5.1)
3. **Registering an `@` source is mandatory, and is a bonus, not a cost.**
   `serializeReference` rejects a chip whose source is missing or codec-less —
   **the send blocks rather than silently degrading**. Once registered, the
   same entry is also reachable by typing `@`, sitting beside
   *Files & folders* / *Sessions* in the menu. That *is* “like the other @”.
   (§4.2)
4. **The sidebar button has three routes, none perfect.** The
   `component-gen-app` position (between *New Session* and the workspace
   browser) has **no slot** — `dsh-tool-symbol-footprint` gets there by
   self-healing DOM injection. `sidebar.footer.action` is a real slot but sits
   at the foot. `sidebar.panellist` is a real, currently **empty** slot in the
   right region, but it is coupled to a central `main` panel. (§3)
5. **This is the mirror image of the “Current Selection” case.** There the
   state is ambient and un-gestured → `systemPrompt.section` is the only
   carrier. Here the state *is* a gesture → `codec.serialize` is the natural
   carrier, and `systemPrompt.section` demotes to standing tool guidance. (§5.3)

---

## 2. What `component-gen-app` actually does today

`component-gen-app` is **not** a DSH plugin. It is a portable React app
(`packages/component-gen-app`) hosted by the plugin
`@huaqiu/dsh-tool-symbol-footprint`, which owns two pieces:

**a) The workspace — a real slot** (`workspace.tsx:294-298`):

```ts
const Overlay = (): JSX.Element => <WorkspaceOverlay ports={ports} />
disposers.push(slots.inject('shell.overlay', () => slots.register(
  { name: 'shell.overlay', id: 'huaqiu-component-gen' }, Overlay) as () => void))
```

**b) The two sidebar rows — DOM injection** (`workspace.tsx:263-292` →
`sidebar-entry.ts` → `sidebar-entry-core.ts`). The core states the constraint
outright (`sidebar-entry-core.ts:6-11`):

```
 * dsh's sidebar shell exposes no slot an external plugin can register into,
 * so the entry row is injected between the shell's New Session button and the
 * workspace browser. The injection self-heals: a MutationObserver watches the
 * sidebar root and re-inserts the row whenever a React re-render displaces it
 * (re-insertion happens in the same frame, before paint, so no flicker).
```

Mechanically it: builds a detached `<button>` carrying
`data-hqcg-symbol-entry` / `data-dsh-plugin` / `data-dsh-part="sidebar-entry"`;
finds the sidebar root via `[data-pane="sidebar"]` → the element owning
`[class*="logoRow"]`; inserts relative to the New Session button against a
*family* selector list so sibling plugins keep a stable order; and re-places on
mutation. `mountSidebarEntry` is DOM-level idempotent
(`sidebar-entry-core.ts:143-145`).

**That comment is now half-outdated.** `sidebar.panellist` exists as a real
list slot in `ui-sidebar` — it simply has **zero occupants** in the shipped
composition (§3.2).

**`dsh-tool-schematic-gen` today registers only tool cards**
(`src/client/index.ts:165-171`): two keyed `tool.call.toolview` entries for
`generate_schematic_from_description` and `generate_system_module_graph`. It
has no sidebar presence and no composer presence.

---

## 3. Route A/B/C — where the “Schematic Gen” button goes

### 3.1 `sidebar.footer.action` — real slot, wrong place

`packages/client/ui-sidebar/src/client/contract/slots.ts:50` —
`kind: 'list'`, `scope: 'root'`, `replaceRisk: 'none'`. Occupants:
`client-ui-cordis CordisPanel id 'cordis-panel'`, and **`@huaqiu/dsh-auth`
already registers one** (`dsh-auth/src/client/index.tsx:172`):

```ts
disposers.push(slots.inject('sidebar.footer.action', () => slots.register(
  { name: 'sidebar.footer.action', id: 'huaqiu-auth' }, HuaqiuAuthSidebarAction) as () => void))
```

Occupant props are only `{ wide: boolean }` — you render the whole row, so the
click handler is yours. **Cheapest sanctioned route**, but the row lands beside
*Settings* at the sidebar foot, not beside *封装生成 / Symbol 生成*.

### 3.2 `sidebar.panellist` — real slot, right place, wrong semantics

```ts
/**
 * Global panel icons. Each list id addresses the matching main panel;
 * the sidebar owns the button and resolves its label from list metadata.
 */
'sidebar.panellist': { kind: 'list'; scope: 'root'; owner: SidebarPanelIconOwnerProps }
```

Rendering (`ui-sidebar/src/client/SidebarRoot.tsx:242-251`) is a `<nav>` above
the workspace browser — the region that matches. But `PanelRow` hardwires
`onClick={() => { selectPanel(id) }}` (line 68), and
`LayoutController.selectPanel` **throws if the id has no `main` occupant**
(`ui-layout/src/client/service.ts:68-71`):

```ts
if (panelId !== null && !this.hasMainPanel(panelId)) {
  throw new Error(`layout.selectPanel: main panel "${panelId}" is not registered`)
}
```

So `sidebar.panellist` buys you a button only by also shipping a central panel
(`main`, `key: <same id>`; the reserved `conversation` key is the only one with
a Session binding — `slot-catalog`: “other keys receive no Session binding”).
That is exactly the “launch a standalone surface” the requirement removes.
**Use only if you want a Schematic Gen landing panel.**

### 3.3 DOM injection — the `component-gen` precedent

Copy `sidebar-entry-core.ts` and `sidebar-entry.ts`. Gives exact visual parity
and the `onToggle` hook is a plain closure, so it can do *anything* — including
inserting a chip instead of opening an overlay.

**Recommendation:** extract `sidebar-entry-core.ts` into a shared
`@huaqiu/dsh-sidebar-entry` package consumed by both
`dsh-tool-symbol-footprint` and `dsh-tool-schematic-gen` (one copy of the
MutationObserver/IPC-bundle-purity policy, one family ordering list). Fall back
to §3.1 if foot placement is acceptable.

---

## 4. Getting “Generate schematic” *into* the composer

### 4.1 Why the `@` menu alone is not enough

From the companion report: `TriggerChar = '/' | '@'`
(`ui-input-trigger/src/types.ts:34`) and the menu opens only *after* the user
types the char. The programmatic opener is
`InputTriggerController.toggleSource(source, hit)`
(`controller.ts:145-164`) — note its doc: *“The supplied hit is a **synthetic
selection span** rather than a typed trigger token, but picks deliberately
reuse the ordinary source callback and scoped input mutation pipeline.”*
DSH itself uses it for the `/` command button
(`ui-conversation/src/client/apply.ts:375-386`). But it still only *opens* a
menu — a `pick` must follow, and `pick` needs a `ready` group (async).

### 4.2 The direct path: `insertReference` on the frozen `SessionInput` face

`packages/client/ui-conversation/src/client/contract/input.ts:190-229`:

```ts
/** The scoped-event application verbs: the hub's bail listeners call these,
 *  and the boolean answer IS the event's bail value. */
export interface InputTarget {
  /** Replace the trigger span with one reference chip (span-CAS'd). */
  insertReference(ref: ReferenceInsert, span: TokenSpan): boolean
}
export interface SessionInput extends InputTarget { /* setDraft, submit, notify, state … */ }
export interface SessionInputResolver {
  /** Resolve the facade for one session-scope ctx. */
  for(actx: Context): SessionInput
}
```

Provided as `ctx.conversation.input` (`service.ts:184`, `hub.ts:67`).
Implementation (`facade.ts:499-514`):

```ts
insertReference(ref: ReferenceInsert, span: TokenSpan): boolean {
  const phase = this.core.state.phase
  if (phase !== 'plain' && phase !== 'claimed') return false
  if (span.draftRev !== this.rev) return false
  …
  applied = $replaceDetectSpanWithNodes(span, nodes)
```

**Collapsed spans are legal.** `selectSpan` accepts `span.start === span.end`
(`span-map.ts:64`: `if (span.start < 0 || span.start > span.end …) return null`)
and `resolvePoint` maps any offset in `[0, detectLength]`. So a zero-width span
at the document end is an *append*.

**Reaching it from a plugin:**

```ts
const sessions     = ctx.get('sessions')                        // ISessions
const conversation = ctx.get('conversation')                    // IConversation
const sessionId    = sessions.list.getSnapshot().current        // SessionListState.current
const actx         = sessions.scope(sessionId)                  // sessions.ts:103
                  ?? sessions.binding(sessionId)?.ctx           // sessions.ts:122
const input        = conversation.input.for(actx)
```

`scope(id)` is documented as *“Resolve an Agent-scoped context view
(use-and-discard)”* — exactly the handle `for()` wants.

**Coordinate systems.** `TokenSpan` is in **detect** coordinates (a chip is one
`U+FFFC`); `InputState.draft` / `Occurrence.offset|length` are in **clipboard**
coordinates (a chip is its `clipboardText`). Convert, or simply append:

```ts
const st = input.state.getSnapshot()          // InputState: draft, draftRev, phase, occurrences
const shrink = st.occurrences.reduce((n, o) => n + (o.length - 1), 0)
const end = st.draft.length - shrink          // detect length of the whole draft

const ok = input.insertReference(
  { source: 'schematic-gen', ref: 'generate', label: 'Generate schematic',
    clipboardText: '@schematic-gen' /* appearance omitted on purpose — see below */ },
  { start: end, end, draftRev: st.draftRev },
)
if (!ok) { /* phase busy or CAS miss → re-read state and retry once */ }
```

**`appearance` omitted is the right choice.**
`ReferenceChip.tsx` renders the `@` marker when `appearance === undefined`:

```tsx
{appearance === undefined
  ? <span className={css.marker} aria-hidden>@</span>
  : <ReferenceIcon kind={appearance} size={14} className={css.icon} />}
<span className={css.label}>{label}</span>
```

That is literally “the same thing `@` produces” — `@ Generate schematic`.

### 4.3 The source registration (mandatory)

`ui-input-trigger/src/types.ts` — `InputTriggerSource`:

```ts
export interface InputTriggerSource {
  readonly trigger: TriggerChar            // '/' | '@'
  readonly name: string                    // unique per trigger; duplicate throws
  readonly order?: number
  readonly showGroupTitle?: boolean
  candidates(session, req): Promise<readonly InputTriggerCandidate[]>
  header?(session, req): readonly InputTriggerCrumb[] | undefined
  onPick(pick: InputTriggerPick): PickOutcome
  matchSpace?(session, token): PickOutcome
  matchEnter?(session, line, signal, envelope): Promise<PickOutcome>
  warm?(session): void
  lexicon?(session): readonly string[] | undefined
  subscribeLexicon?(session, listener): () => void
  openReference?(session, reference): boolean
  /** Reference codec; required for sources producing insert outcomes. */
  readonly codec?: ReferenceCodec
}
export interface ReferenceCodec {
  clipboardText(ref: string): string
  serialize(ref: string, signal: AbortSignal): Promise<string>
}
```

Multiple sources may share a trigger char — `registerSource` only rejects a
duplicate `(trigger, name)` pair (`service.ts:55-57`), and **DSH ships a second
`@` source itself**: `packages/extensions/ui-cordis/src/client/index.ts:150-170`
registers `{ trigger: '@', name: 'cordis' }` whose
`onPick` returns `{ text: `@${candidate.name} ` }`. Registration order is menu
group order (`service.ts:96`).

```ts
export const inject = ['slots','sessions','huaqiuAuth','conversation','inputTriggers','locale']
…
const inputTriggers = ctx.get('inputTriggers') as InputTriggerServiceContract
ctx.effect(() => inputTriggers.registerSource({
  trigger: '@', name: 'schematic-gen', order: 10,
  showGroupTitle: true,
  candidates: () => Promise.resolve([
    { name: 'Generate schematic', icon: 'file',
      description: 'Generate a KiCad schematic from a description' },
  ]),
  onPick: () => ({ insert: { source: 'schematic-gen', ref: 'generate',
                             label: 'Generate schematic',
                             clipboardText: '@schematic-gen' } }),
  codec: {
    clipboardText: () => '@schematic-gen',
    serialize: () => Promise.resolve(SERIALIZED),   // see §5.1
  },
}), 'schematic-gen: @ source')
```

Registering the source also buys the typed path for free: the user can type
`@` and pick **Generate schematic** from a group beside *Files & folders*.

### 4.4 Fallback if `insertReference` proves too brittle

`InputActions` (what every session-scope slot component receives as
`inputActions`) is deliberately narrow — `contract/input.ts:238`:

```ts
export interface InputActions {
  setDraft(text: string): void
  addAttachments(ids): boolean
  removeAttachment(id): void
  pruneAttachments(ids): void
  submit(): void
}
```

No chip verb. But `setDraft` + the `lexicon` hook gives a **look-alike**: a
`@name` token whose name is on the lexicon is decorated by a Lexical entity
transform with the chip styling (`text-ref.ts`, `decorations.ts`):

```
 * a `/name` or `@name` token whose name is on the trigger's lexicon …
 * Pure derivation — editing the text out of match shape simply drops the range next scan.
const TEXT_REF_RE = /(^|\s)([/@])([\w-]+)/g
```

Cost: the token must be `[\w-]+`, so `@schematic-gen`, not
`@Generate schematic`. Also `setDraft` *replaces* the whole draft
(`facade.ts:274`) — you must read `useInput()`/state and append — and it strips
`U+FFFC`/`U+E100–E11D`, so chips can never be forged this way. Acceptable
degradation; **not** the primary plan.

---

## 5. Contributing to the agent prompt

### 5.1 Primary: `codec.serialize` (the chip *is* the prompt)

`facade.ts:721-761` — before the sink, every occurrence is expanded through the
owning source and spliced over its clipboard range:

```ts
const occurrences = this.projection.occurrences
…
void Promise.all(occurrences.map(async (o) => {
  if (inputTriggers === undefined) throw new Error(`no serializer for reference source "${o.source}"`)
  return { offset: o.offset, length: o.length,
           text: await inputTriggers.serializeReference(o.source, o.ref, attempt.signal) }
})).then((parts) => {
  let out = ''; let cursor = 0
  for (const part of parts) {
    out += draft.slice(cursor, part.offset) + part.text
    cursor = part.offset + part.length
  }
  out += draft.slice(cursor)
  this.settleSink(attempt, this.deps.defaultSink(out.trim(), attachmentIds, mode, attempt.signal))
}, (error) => { … this.settleDetachedFailure(attempt, message) })
```

and `controller.ts:300-306`:

```ts
serializeReference(source: string, ref: string, signal: AbortSignal): Promise<string> {
  const owner = this.deps.roster.all().find(s => s.name === source)
  if (owner?.codec === undefined) {
    return Promise.reject(new Error(`slash: no serializer for reference source "${source}"`))
  }
  return owner.codec.serialize(ref, signal)
}
```

Two consequences worth internalising:

- **A chip with no codec is a hard failure, not a silent downgrade** — the whole
  send blocks with `no serializer for reference source "schematic-gen"`. The
  source registration is load-bearing, not decorative.
- Whatever `serialize` returns lands **at the chip's position in the user
  message**, which is exactly where the agent needs it.

Suggested payload (keep it short and imperative; the two tools are already in
the model's tool list):

```
<schematic-gen intent="generate_schematic_from_description">
The user opened the Schematic Gen entry and asked for a schematic to be
generated. Call `generate_schematic_from_description` with their description;
use `generate_system_module_graph` only when they ask for a multi-module /
system-level design. Do not hand-write .kicad_sch content.
</schematic-gen>
```

### 5.2 Secondary: `systemPrompt.section` for standing guidance

`packages/core/system-prompt/src/index.ts` — the provider is re-evaluated at
every prompt assembly, so returning `''` removes the section. Shipped proof
(`packages/plan/plan-mode/src/index.ts:212-221`):

```ts
ctx.systemPrompt.section({
  name: 'plan:policy',
  order: ctx.systemPrompt.getSectionOrder('PLAN_POLICY'),
  text: (context) => {
    if (context.agent === undefined) return ''
    const pending = this.pendingIntents.get(context.agent.session)
    return (pending?.active ?? this.loggedActive(context.agent.session)) ? this.section : ''
  },
})
```

Put this in the **node half** of `dsh-tool-schematic-gen`, next to
`ctx.tools.register(tool)` (`src/index.ts:108`). It is the right vehicle for
*“here is when to prefer schematic-gen over hand-writing a schematic”* —
always-on policy. It is the **wrong** vehicle for *“the user clicked the button
just now”*, because the system prompt cannot express per-turn intent.

### 5.3 Why this differs from the “Current Selection” design

| | Current Selection (companion report) | Schematic Gen (this report) |
|---|---|---|
| Origin | Host state push (EDA → hq-edge → plugin → web) | User click |
| Lifetime | Appears/disappears with host state | Lives in the draft until sent or deleted |
| Chip placement | `conversation.input.dock` (ambient, above the composer) | inside the Lexical draft (a real chip) |
| New RPC | yes — `SubscribeSelection` | none |
| Prompt carrier | `systemPrompt.section` (evaluated per step) | `codec.serialize` (spliced into the user turn) |
| Removal | provider returns `''` | user deletes the chip |

Same UI grammar, opposite plumbing. If both ship, the dock chip and the inline
chip can coexist without collision — different slots, different lifetimes.

### 5.4 Optional: `matchEnter` / `matchSpace`

If typing `@schematic-gen` and hitting Enter should *claim* the submission the
way `/<command>` does, implement `matchEnter` (and `matchSpace` for the
space-settled path). `ui-reference` and the command source are the models.
Skip for v1 — the chip + typed-pick path already covers it.

---

## 6. Implementation plan

| # | Change | File(s) |
|---|---|---|
| 1 | New shared package `@huaqiu/dsh-sidebar-entry` (moved verbatim from `dsh-tool-symbol-footprint/src/client/sidebar-entry-core.ts`); both plugins depend on it | `packages/dsh-sidebar-entry/**` |
| 2 | `dsh-tool-schematic-gen` client half: mount one row, `data-hqcg-schematic-entry`, label `原理图生成` / `Schematic Gen`, localized like the symbol/footprint rows (`translateFor(currentLang)` + `<html lang>` observer) | `src/client/sidebar-entry.ts`, `src/client/index.ts` |
| 3 | `onToggle` → insert the chip (§4.2) instead of opening an overlay; no `shell.overlay` entry at all | `src/client/index.ts` |
| 4 | Register the `@` / `schematic-gen` source with `candidates` + `onPick` + `codec` (§4.3) | `src/client/index.ts` |
| 5 | `inject` grows to `['slots','sessions','huaqiuAuth','conversation','inputTriggers','locale']` | `src/client/index.ts` |
| 6 | Node half: `ctx.systemPrompt.section({ name: 'huaqiu:schematic-gen', … })` for standing tool guidance | `src/index.ts` |
| 7 | Guard both halves when `conversation` / `inputTriggers` are absent (standalone DSH, HQ Edge host) — degrade to “no chip”, never throw | both |
| 8 | Tests: client-bundle purity (`inputTriggers` is structural-only), span-CAS retry, codec-present-or-send-blocks | `test/**` |

`cordis.patch.yml` needs no change for the client half (the node-half `inject`
is untouched); the client entry is declared by
`package.json → dsh.client.inject: ['@deepseek-ai/dsh-client-runtime']`, already
present.

---

## 7. Risks and open decisions

1. **`insertReference` is on the frozen face but is not what slot components
   get.** Slot occupants receive the narrower `InputActions`
   (`contract/input.ts:238`). The plugin must go through
   `ctx.conversation.input.for(actx)` from its own `apply()` — i.e. the button's
   click handler must be wired to a service the plugin owns, not to slot props.
   A DOM-injected row (§3.3) makes this trivial; a `sidebar.footer.action`
   occupant (§3.1) would need the same closure captured at `apply()` time.
2. **Coordinate conversion is the sharpest edge.** Detect vs clipboard
   coordinates differ per chip; getting the append offset wrong silently moves
   the chip. Mitigation: append only (document end), and re-read
   `state.getSnapshot()` immediately before the call so `draftRev` is fresh;
   retry once on `false`.
3. **`sessions.list.getSnapshot().current` may be `undefined`** (no session /
   Hero view). The button should disable, or call `sessions.create()` first —
   a product decision. `conversation.input.dock` is `scope: 'session'`, so the
   companion design silently has no chip in that state; here we must choose.
4. **The “no codec” failure mode is loud.** If the source registration is
   skipped or disposed while a chip is in the draft, the send fails with
   `no serializer for reference source "schematic-gen"`. Dispose order matters:
   never dispose the source while `ctx.effect` still holds chips.
5. **`sidebar.panellist` stays unused by design here.** Registering it without a
   `main` panel makes the shipped `selectPanel` throw. If the HQ Edge
   deployment ever wants a Schematic Gen central panel, revisit — the button
   then comes free.
6. **Deleting the chip** is the only way to retract the choice. If product wants
   a second click on the toolbutton to *remove* it, scan
   `state.occurrences` for `source === 'schematic-gen'` and remove — there is no
   public verb for it; the cheapest honest version is `setDraft(state.draft)`
   minus that occurrence's clipboard range.
