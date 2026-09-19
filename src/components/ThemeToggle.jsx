import { useTheme } from '../theme.js'

// The icon shown is the mode a click will switch *to* — sun while dark
// (click for light), moon while light (click for dark).
export default function ThemeToggle() {
  const [theme, setTheme] = useTheme()
  const isDark = theme === 'dark'
  const label = isDark ? 'Switch to light mode' : 'Switch to dark mode'

  return (
    <button
      type="button"
      className="btn ghost icon"
      title={label}
      aria-label={label}
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
    >
      {isDark ? (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
          <path d="M20.35 14.5a8.4 8.4 0 0 1-9.85-9.85A8.4 8.4 0 1 0 20.35 14.5Z" />
        </svg>
      )}
    </button>
  )
}
