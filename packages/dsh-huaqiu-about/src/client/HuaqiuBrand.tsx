/**
 * HuaQiu brand mark — self-contained copy (SVG) so the About plugin does not
 * depend on another plugin's client bundle at runtime.
 */
import { createElement } from 'react'

export function HuaqiuBrandMark({ size, className }: { size: number; className?: string }): React.ReactElement {
  return createElement(
    'svg',
    {
      'aria-hidden': true,
      className,
      height: size,
      style: { display: 'block', flex: 'none' },
      viewBox: '0 0 974.25 974.25',
      width: size,
      xmlns: 'http://www.w3.org/2000/svg',
    },
    createElement('path', {
      d: 'M865.67,758.67a107,107,0,1,0,107,107A107,107,0,0,0,865.67,758.67Z',
      fill: '#c7000b',
      fillRule: 'evenodd',
    }),
    createElement('path', {
      d: 'M744.11,0h-514C103.56,0,0,103.56,0,230.14v514C0,870.69,103.56,974.25,230.14,974.25h514c3.34,0,6.66-.06,10-.21a155.66,155.66,0,0,1-40-143.56H230.14a86.63,86.63,0,0,1-86.37-86.37v-514a86.63,86.63,0,0,1,86.37-86.37h514a86.61,86.61,0,0,1,86.37,86.37V714.06a156.93,156.93,0,0,1,35.19-4A155.1,155.1,0,0,1,974,754c.15-3.28.21-6.6.21-9.92v-514C974.25,103.56,870.69,0,744.11,0Z',
      fill: '#c7000b',
      fillRule: 'evenodd',
    }),
    createElement('polygon', {
      points: '735.67 735.65 735.67 238.59 591.9 238.59 591.9 415.24 382.39 415.24 382.39 238.59 238.62 238.59 238.62 735.65 382.39 735.65 382.39 559.01 591.9 559.01 591.9 735.65 735.67 735.65',
      fill: '#c7000b',
      fillRule: 'evenodd',
    }),
  )
}
