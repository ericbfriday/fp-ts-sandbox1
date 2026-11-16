/**
 * Default-condition stub for `@friday-friday/next`. Importing the root entry outside a
 * react-server environment throws immediately (Design Report §5.1: server helpers are
 * react-server-only). Client helpers live at `@friday-friday/next/client`.
 */
throw new Error(
  "@friday-friday/next: the root entry is server-only (react-server). Use '@friday-friday/next/client' in client components."
)
