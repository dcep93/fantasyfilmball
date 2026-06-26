export function yearFromSearch<T extends string>(search: string, years: readonly T[], fallback: T): T {
  const year = new URLSearchParams(search).get("year");
  return years.includes(year as T) ? (year as T) : fallback;
}

export function replaceYearQuery(year: string) {
  const url = new URL(window.location.href);
  url.searchParams.set("year", year);
  window.history.pushState(null, "", `${url.pathname}${url.search}${url.hash}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
