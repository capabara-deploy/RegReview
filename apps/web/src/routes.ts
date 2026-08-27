/**
 * Hash routing.
 *
 * Navigation used to be `useState<Page>`, which meant nothing in this product
 * had an address: you could not link a colleague to a finding, paste a document
 * into an audit response, or reload without losing your place. In a tool whose
 * users email each other evidence, that is a missing feature rather than a
 * missing nicety.
 *
 * Hash routing rather than the History API because the app is served as a
 * static site behind a CDN — a real path would 404 on refresh unless every
 * route were rewritten server-side, which is a deployment change this does not
 * need.
 *
 * A route is a page plus an optional target: the object the page should open.
 * Pages ignore targets they do not understand, so a stale link degrades to the
 * right page rather than an error.
 */

export type Page = "run" | "findings" | "procedures" | "changes" | "map";

const PAGES: Page[] = ["run", "findings", "procedures", "changes", "map"];

export interface Route {
  page: Page;
  /** Record id on findings, change id on changes, node id on the map. */
  target: string | null;
}

export const DEFAULT_ROUTE: Route = { page: "findings", target: null };

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  if (!raw) return DEFAULT_ROUTE;
  const [page, ...rest] = raw.split("/");
  if (!page || !PAGES.includes(page as Page)) return DEFAULT_ROUTE;
  // Node ids contain a colon ("rec:abc"), which survives a hash segment intact;
  // rejoining the tail keeps ids that themselves contain slashes usable.
  const target = rest.length > 0 ? decodeURIComponent(rest.join("/")) : null;
  return { page: page as Page, target: target || null };
}

export function formatHash(page: Page, target?: string | null): string {
  return target ? `#/${page}/${encodeURIComponent(target)}` : `#/${page}`;
}

/**
 * Push a route into the address bar.
 *
 * Assigning `location.hash` fires `hashchange`, which is the single place route
 * state is derived from — so navigation, a pasted link and the back button all
 * take exactly the same path through the app.
 */
export function navigateTo(page: Page, target?: string | null): void {
  const next = formatHash(page, target);
  if (window.location.hash !== next) window.location.hash = next;
}

/** Node id helpers, mirroring the ones the graph assigns server-side. */
export const mapNodeForRecord = (recordId: string) => `rec:${recordId}`;
export const mapNodeForChange = (changeId: string) => `chg:${changeId}`;
