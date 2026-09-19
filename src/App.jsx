import { useEffect, useState } from 'react'
import Recorder from './views/Recorder.jsx'
import Editor from './views/Editor.jsx'
import ExportTray from './views/ExportTray.jsx'

export default function App() {
  const [take, setTake] = useState(null)
  const [takes, setTakes] = useState([])

  const refreshTakes = () => window.api.listTakes().then(setTakes).catch(() => {})
  useEffect(() => {
    refreshTakes()
    // Only macOS's hiddenInset titlebar needs room reserved for the overlaid
    // traffic-light buttons — see the .titlebar padding-left rule in styles.css.
    window.api
      .platformInfo()
      .then(({ platform }) => document.documentElement.setAttribute('data-platform', platform))
      .catch(() => {})
  }, [])

  return (
    <>
      {take ? (
        <Editor
          take={take}
          onBack={() => {
            setTake(null)
            refreshTakes()
          }}
        />
      ) : (
        <Recorder takes={takes} onTake={setTake} onRefresh={refreshTakes} />
      )}
      <ExportTray />
    </>
  )
}
