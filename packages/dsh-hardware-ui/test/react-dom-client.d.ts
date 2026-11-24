/**
 * Types for the one `react-dom/client` API the DOM test uses.
 *
 * This repository installs `react` and `jsdom` but not `@types/react-dom`, and
 * adding a type package for two calls would be heavier than declaring them. The
 * surface is deliberately the minimum: the test mounts, asserts, unmounts.
 *
 * @module
 */
declare module 'react-dom/client' {
  /** A mounted React root. */
  export interface Root {
    render(node: unknown): void
    unmount(): void
  }
  /** Mount a React tree into a container element. */
  export function createRoot(container: Element | DocumentFragment): Root
}
