import { useEffect, useRef } from 'react'

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
const MOD = isMac ? '⌘' : 'Ctrl'
const ALT = isMac ? '⌥' : 'Alt'

// The editor's keyboard shortcuts, grouped for the help overlay. Editor.jsx's
// key handler implements exactly these.
export const SHORTCUT_GROUPS = [
  {
    title: 'Playback',
    items: [
      [['Space'], 'Play / pause'],
      [['K'], 'Play / pause'],
      [['J'], 'Back 5 seconds'],
      [['L'], 'Forward 5 seconds'],
      [['←'], 'Previous frame'],
      [['→'], 'Next frame'],
      [['Shift', '←'], 'Back 1 second'],
      [['Shift', '→'], 'Forward 1 second'],
      [['↑'], 'Previous edit point'],
      [['↓'], 'Next edit point'],
      [['Home'], 'Go to start'],
      [['End'], 'Go to end'],
    ],
  },
  {
    title: 'Editing',
    items: [
      [[MOD, 'Z'], 'Undo'],
      [[MOD, 'Shift', 'Z'], 'Redo'],
      [[MOD, 'Y'], 'Redo'],
      [['S'], 'Split selected at playhead'],
      [[MOD, 'B'], 'Split selected at playhead'],
      [['['], 'Trim selected start to playhead'],
      [[']'], 'Trim selected end to playhead'],
      [[ALT, '←'], 'Nudge selected 1 frame earlier'],
      [[ALT, '→'], 'Nudge selected 1 frame later'],
      [[ALT, 'Shift', '←'], 'Nudge selected 1 second earlier'],
      [[ALT, 'Shift', '→'], 'Nudge selected 1 second later'],
      [[MOD, 'C'], 'Copy selected'],
      [[MOD, 'X'], 'Cut selected'],
      [[MOD, 'V'], 'Paste at playhead'],
      [[MOD, 'D'], 'Duplicate selected'],
      [['Delete'], 'Delete selected'],
      [['Esc'], 'Deselect'],
    ],
  },
  {
    title: 'Tools',
    items: [
      [['V'], 'Select tool'],
      [['Z'], 'Add zoom at playhead'],
      [['T'], 'Text tool'],
      [['R'], 'Shapes tool'],
      [['B'], 'Add background clip'],
      [['E'], 'Add image element'],
      [['C'], 'Cursor settings'],
    ],
  },
  {
    title: 'View & app',
    items: [
      [['='], 'Zoom timeline in'],
      [['-'], 'Zoom timeline out'],
      [['\\'], 'Reset timeline zoom'],
      [['F'], 'Fullscreen preview'],
      [[MOD, 'E'], 'Export'],
      [['?'], 'Show these shortcuts'],
      [[MOD, '/'], 'Show these shortcuts (also Help menu)'],
    ],
  },
]

export default function ShortcutsOverlay({ onClose, stopHotkey }) {
  const panelRef = useRef(null)
  useEffect(() => panelRef.current?.focus(), [])
  // Capture phase, so Esc/? close this before the editor's own handler sees them.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' || e.key === '?') {
        e.preventDefault()
        e.stopImmediatePropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const groups = [
    {
      title: 'Recording',
      items: [[(stopHotkey || `${MOD}+Shift+2`).split('+'), 'Stop recording (works from any app)']],
    },
    ...SHORTCUT_GROUPS,
  ]
  return (
    <div className="shortcuts-backdrop" onMouseDown={onClose}>
      <div
        className="shortcuts-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        tabIndex={-1}
        ref={panelRef}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="shortcuts-head">
          <h2>Keyboard shortcuts</h2>
          <button className="btn ghost sm shortcuts-close" onClick={onClose}>
            Close <kbd>Esc</kbd>
          </button>
        </div>
        <div className="shortcuts-grid">
          {groups.map((g) => (
            <section key={g.title}>
              <h3>{g.title}</h3>
              <dl>
                {g.items.map(([keys, label]) => (
                  <div className="shortcut-row" key={label + keys.join('+')}>
                    <dt>{label}</dt>
                    <dd>
                      {keys.map((k) => (
                        <kbd key={k}>{k}</kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
