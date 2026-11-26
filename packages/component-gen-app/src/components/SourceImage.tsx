/**
 * `@huaqiu/component-gen-app` — uploaded source image thumbnail.
 *
 * Renders the user's upload at a bounded size and opens a full-screen
 * lightbox on click (mask click / Esc closes). Shared by the dimension
 * editor and the result stage so both can zoom the source image.
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import type { Translate } from '../copy/index.js'

export interface SourceImageProps {
  src: string
  t: Translate
}

export function SourceImage({ src, t }: SourceImageProps): ReactElement {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, close])

  return (
    <>
      <button
        type="button"
        className="cga-source__thumb"
        title={t('upload.sourceImage')}
        aria-label={t('upload.sourceImage')}
        onClick={() => setOpen(true)}
      >
        <img className="cga-source__img" src={src} alt={t('upload.sourceImage')} />
      </button>
      {open
        ? createPortal(
          <div className="cga-lightbox" role="dialog" aria-modal="true" onClick={close}>
            <img
              className="cga-lightbox__img"
              src={src}
              alt={t('upload.sourceImage')}
              onClick={(ev) => ev.stopPropagation()}
            />
          </div>,
          document.body,
        )
        : null}
    </>
  )
}
