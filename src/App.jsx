import { useEffect, useState } from 'react'
import Recorder from './views/Recorder.jsx'
import Editor from './views/Editor.jsx'
import ExportTray from './views/ExportTray.jsx'
import ShortcutsOverlay from './components/ShortcutsOverlay.jsx'

export default function App() {
  const [take, setTake] = useState(null)
  const [takes, setTakes] = useState([])
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [stopHotkey, setStopHotkey] = useState(null)

  // Help > Keyboard Shortcuts in the app menu.
  useEffect(() => window.api.onShowShortcuts(() => setShowShortcuts(true)), [])

  const refreshTakes = () => window.api.listTakes().then(setTakes).catch(() => {})
  useEffect(() => {
    refreshTakes()
    // Only macOS's hiddenInset titlebar needs room reserved for the overlaid
    // traffic-light buttons — see the .titlebar padding-left rule in styles.css.
    window.api
      .platformInfo()
      .then(({ platform, stopHotkey }) => {
        document.documentElement.setAttribute('data-platform', platform)
        setStopHotkey(stopHotkey)
      })
      .catch(() => {})
  }, [])

  return (
    <>
      {take ? (
        <Editor
          take={take}
          showShortcuts={showShortcuts}
          setShowShortcuts={setShowShortcuts}
          onBack={() => {
            setTake(null)
            refreshTakes()
          }}
        />
      ) : (
        <Recorder takes={takes} onTake={setTake} onRefresh={refreshTakes} />
      )}
      <ExportTray />
      {showShortcuts && <ShortcutsOverlay stopHotkey={stopHotkey} onClose={() => setShowShortcuts(false)} />}
    </>
  )
}
