/**
 * Dark/light mode: a plain attribute on <html> (read by every CSS custom
 * property in styles.css) plus a localStorage mirror so the choice survives
 * a relaunch. index.html applies the stored value inline, before React (or
 * even the stylesheet) loads, so there is no flash of the wrong theme.
 *
 * State lives in one React Context, not one useState per <ThemeToggle> — the
 * Recorder and Editor each mount their own toggle, and two independent
 * useState instances silently raced each other (whichever mounted/unmounted
 * last would re-derive its own initial value and stomp the other's write),
 * so the choice could flip back to dark right after being set. A single
 * provider makes that structurally impossible: there is exactly one value.
 */
// createElement, not JSX — this file keeps the .js extension (every import
// site references it as 'theme.js'), and Vite's default esbuild loader only
// parses JSX syntax in .jsx/.tsx files.
import { createContext, createElement, useContext, useEffect, useState } from 'react'

const KEY = 'zoomarc:theme'
export const THEMES = ['dark', 'light']

export function getStoredTheme() {
  try {
    const saved = localStorage.getItem(KEY)
    return THEMES.includes(saved) ? saved : null
  } catch {
    return null // localStorage can throw in a locked-down webview; fall back below
  }
}

function persist(theme) {
  try {
    localStorage.setItem(KEY, theme)
  } catch {
    /* non-fatal: the toggle still works for the rest of the session */
  }
}

const ThemeContext = createContext(null)

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(
    () => getStoredTheme() || document.documentElement.getAttribute('data-theme') || 'dark',
  )

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    persist(theme)
  }, [theme])

  return createElement(ThemeContext.Provider, { value: [theme, setTheme] }, children)
}

/** Current theme state, plus a setter that also persists and updates the DOM. */
export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider')
  return ctx
}
