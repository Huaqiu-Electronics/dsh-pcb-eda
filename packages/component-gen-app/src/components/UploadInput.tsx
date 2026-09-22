/**
 * `@huaqiu/component-gen-app` — image upload control (click + paste + drag).
 *
 * Reads a file, downscales it to a thumbnail data URL if needed (bounded by
 * `maxBytes`), and reports both the original file and the data URL to the
 * parent. The parent owns sending it to the server.
 *
 * Drag-and-drop note: the zone has to *claim* the drag. Hosts that install a
 * page-wide file drop target (dsh's attachment plugin does) otherwise either
 * cancel the drag outright — their `dragover` writes `dropEffect = 'none'` into
 * the shared drag data store, which stops `drop` from ever being dispatched —
 * or take the dropped file for themselves at document level. See
 * `utils/drag.ts` for the full mechanism.
 */
import { useCallback, useRef, useState, type DragEvent as ReactDragEvent, type ReactElement } from 'react'
import type { Translate } from '../copy/index.js'
import { dragHasFiles, releasePageDragState } from '../utils/drag.js'

export interface UploadInputProps {
  maxBytes: number
  t: Translate
  disabled?: boolean
  imageDataUrl?: string | null
  /** original file, for the server to store into history. */
  file?: File | null
  onFile: (file: File | null, dataUrl: string | null) => void
}

const MAX_EDGE = 1600

/** Downscale an image file to a data URL bounded in edge + bytes. */
export function fileToDataUrl(file: File, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('failed to read file'))
    reader.onload = () => {
      const src = String(reader.result)
      if (src.length <= maxBytes) { resolve(src); return }
      // Too big as-is — downscale via canvas.
      const img = new Image()
      img.onload = () => {
        const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height))
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(img.width * scale))
        canvas.height = Math.max(1, Math.round(img.height * scale))
        const ctx = canvas.getContext('2d')
        if (!ctx) { reject(new Error('canvas unavailable')); return }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
        let out = canvas.toDataURL('image/jpeg', 0.82)
        // Quality ladder until it fits (or we give up after several tries).
        for (const q of [0.7, 0.55, 0.4]) {
          if (out.length <= maxBytes) break
          out = canvas.toDataURL('image/jpeg', q)
        }
        resolve(out)
      }
      img.onerror = () => reject(new Error('failed to decode image'))
      img.src = src
    }
    reader.readAsDataURL(file)
  })
}

export function UploadInput(props: UploadInputProps): ReactElement {
  const { maxBytes, t, disabled = false, imageDataUrl = null, file = null, onFile } = props
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Enter/leave counter instead of a boolean: the browser fires dragenter and
  // dragleave for *every* element transition inside the zone, so a boolean
  // flickers off whenever the pointer crosses the label, thumbnail or button.
  const dragDepth = useRef(0)

  const accept = useCallback(async (f: File | null): Promise<void> => {
    if (!f) return
    if (f.size > maxBytes) {
      setError(t('upload.imageTooLarge'))
      return
    }
    setError(null)
    try {
      const dataUrl = await fileToDataUrl(f, maxBytes)
      onFile(f, dataUrl)
    } catch (e) {
      setError(String((e as Error)?.message || e))
    }
  }, [maxBytes, onFile, t])

  /** Keep a drag event away from page-wide drop targets (see the module docs). */
  const claim = (ev: ReactDragEvent<HTMLDivElement>): void => {
    ev.stopPropagation()
  }

  /** The drag now belongs to the page again — let its drop targets resume. */
  const release = (ev: ReactDragEvent<HTMLDivElement>): void => {
    if (dragHasFiles(ev.dataTransfer)) releasePageDragState()
  }

  return (
    <div
      className={`cga-upload${dragging ? ' cga-upload--dragging' : ''}`}
      onClick={() => { if (!disabled) inputRef.current?.click() }}
      onDragEnter={(ev) => {
        ev.preventDefault()
        claim(ev)
        dragDepth.current += 1
        if (dragDepth.current === 1) {
          setDragging(true)
          // Take the page's drag state down with us: while the file is over the
          // zone the host's full-viewport drop invitation must not cover it.
          release(ev)
        }
      }}
      onDragOver={(ev) => {
        ev.preventDefault()
        claim(ev)
        // Our verdict, not the host's: a 'none' written by a document-level
        // handler reaches the drag data store too, and the browser cancels the
        // whole drag when the last word on it was 'none'.
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = disabled ? 'none' : 'copy'
        if (!disabled) setDragging(true)
      }}
      onDragLeave={(ev) => {
        // Not claimed: the host's own enter/leave accounting stays balanced
        // when the file is dragged back out of the zone.
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDragging(false)
      }}
      onDrop={(ev) => {
        ev.preventDefault()
        // Claimed for good: the host must not also attach this file to its own
        // draft (the point of the drop is the generator, not the composer).
        claim(ev)
        dragDepth.current = 0
        setDragging(false)
        release(ev)
        if (disabled) return
        void accept(ev.dataTransfer.files?.[0] ?? null)
      }}
      onPaste={(ev) => {
        const item = Array.from(ev.clipboardData?.items ?? []).find((i) => i.type.startsWith('image/'))
        if (item) {
          ev.preventDefault()
          void accept(item.getAsFile())
        }
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        disabled={disabled}
        onChange={(ev) => { void accept(ev.target.files?.[0] ?? null); ev.target.value = '' }}
      />
      {imageDataUrl
        ? (
          <>
            <img className="cga-upload__thumb" src={imageDataUrl} alt="" />
            <div className="cga-upload__text">{file?.name ?? ''}</div>
          </>
        )
        : null}
      <div className="cga-upload__text">
        {imageDataUrl ? t('upload.replace') : t('upload.drop')}
        <br />{t('upload.paste')}
      </div>
      {error ? <div className="cga-upload__text" style={{ color: 'var(--dsw-alias-state-error-primary, red)' }}>{error}</div> : null}
      {!imageDataUrl ? <button type="button" className="cga-upload__browse">{t('upload.browse')}</button> : null}
    </div>
  )
}
