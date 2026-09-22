/**
 * `@huaqiu/component-gen-app` — page-level drag-state interop.
 *
 * The app is rendered inside hosts that own a *page-wide* file drop target
 * (dsh's attachment plugin listens on `document` for dragenter/dragover/
 * dragleave/drop and paints a full-screen "drop to attach" invitation). Two
 * properties of that pattern matter to any nested drop zone:
 *
 *  - `dragover` writes `dataTransfer.dropEffect = 'none'` whenever the host
 *    refuses the drop (no session, composer busy, …). `dropEffect` lives on the
 *    drag data store shared by the whole drag, so the host's verdict outranks
 *    the nested zone's: Chromium then cancels the drag operation and the `drop`
 *    event is never dispatched anywhere on the page. The nested zone is dead
 *    even though its own `dragover` called `preventDefault()`.
 *  - The host counts dragenter/dragleave to drive that invitation, and only
 *    clears the counter from its own `drop`, `dragleave`, or window `dragend`.
 *    A drag of OS files fires **no** `dragend` ("dragstart and dragend are not
 *    fired when dragging a file into the browser from the OS" — MDN, File drag
 *    and drop), so a nested zone that swallows the drop leaves the host's
 *    invitation dimming the screen forever.
 *
 * A nested zone therefore has to do two things: keep its own drag events to
 * itself (`stopPropagation`, done by the drop zone) and tell the page when the
 * drag has moved onto it / been consumed, which is what this module is for.
 */

/**
 * Broadcast "this file drag is no longer yours" to page-wide drop targets.
 *
 * Dispatched on `document.body` with a Files-carrying `dataTransfer`, which is
 * the shape page-wide drop targets test for, and at the viewport origin, which
 * is how they recognise "the pointer left the page" and drop their drag state.
 * Holding a page-wide target's enter/leave counter at zero while the pointer is
 * over our own drop zone is also what lets the zone be seen: dsh's invitation
 * paints a blurred full-viewport mask, and it is the host's own handler that
 * has to take it back down.
 *
 * Idempotent and a no-op in hosts without a page-wide drop target (the
 * standalone build, SSR, environments without `DataTransfer`).
 */
export function releasePageDragState(): void {
  if (typeof document === 'undefined' || !document.body) return
  // A plain `Event` carrying the same shape, so this works in every engine
  // (notably jsdom, which implements neither `DragEvent` nor `DataTransfer`).
  const event = new Event('dragleave', { bubbles: true, cancelable: true })
  Object.assign(event, { clientX: 0, clientY: 0, dataTransfer: dragStateTransfer() })
  document.body.dispatchEvent(event)
}

/** Minimal Files payload page-wide drop targets recognise. */
function dragStateTransfer(): unknown {
  try {
    const transfer = new DataTransfer()
    // The `types` list only reports `Files` once a file is actually held.
    transfer.items.add(new File([], 'drag-state'))
    return transfer
  } catch {
    return { types: ['Files'] }
  }
}

/**
 * True when a drag carries files (as opposed to text or an in-page element
 * being dragged). Guards the drag-state broadcast so text drags over the
 * upload zone do not disturb hosts tracking their own drags.
 */
export function dragHasFiles(dataTransfer: DataTransfer | null | undefined): boolean {
  if (!dataTransfer) return false
  const types = dataTransfer.types
  if (!types) return false
  return Array.from(types).some((type) => type === 'Files' || type === 'application/x-moz-file')
}
