import * as React from "react"

// The room sidebar leaves the layout below 821px, and on a phone held
// sideways: that is wider than 820px but too short for a sidebar beside the
// call. Keep in sync with the `phone` variant in styles.css.
export const PHONE_QUERY = "(max-width: 820px), (max-height: 500px) and (max-width: 1000px)"

function useMediaQuery(query: string) {
  const [matches, setMatches] = React.useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  )

  React.useEffect(() => {
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    mql.addEventListener("change", onChange)
    onChange()
    return () => mql.removeEventListener("change", onChange)
  }, [query])

  return matches
}

/** Phone-sized window, portrait or landscape: drawers instead of columns. */
export function useIsMobile() {
  return useMediaQuery(PHONE_QUERY)
}
