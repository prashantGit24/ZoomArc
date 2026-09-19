import { useEffect, useState } from 'react'

const LABEL = {
  queued: 'Queued',
  rendering: 'Exporting',
  done: 'Exported',
  failed: 'Failed',
  canceled: 'Canceled',
}

/**
 * Lives above both views: exports keep running when you leave the editor, so
 * their progress has to be reachable from anywhere.
 */
export default function ExportTray() {
  const [jobs, setJobs] = useState([])
  const [open, setOpen] = useState(true)

  useEffect(() => {
    window.api.listExports().then(setJobs).catch(() => {})
    return window.api.onExportsChanged(setJobs)
  }, [])

  if (jobs.length === 0) return null

  const active = jobs.filter((j) => j.state === 'queued' || j.state === 'rendering')
  const finished = jobs.length - active.length

  return (
    <div className="tray">
      <button className="tray-head" onClick={() => setOpen((v) => !v)}>
        <span className="tray-title">
          {active.length > 0
            ? `Exporting ${active.length} ${active.length === 1 ? 'video' : 'videos'}`
            : 'Exports'}
        </span>
        <span className="tray-meta">{open ? '▾' : '▴'}</span>
      </button>

      {open && (
        <div className="tray-body">
          {jobs.map((j) => {
            const pct = j.total ? Math.min(100, Math.round((j.done / j.total) * 100)) : 0
            return (
              <div key={j.id} className={`job ${j.state}`}>
                <div className="row between">
                  <strong title={j.name}>{j.name}</strong>
                  <span className="tray-meta">
                    {j.state === 'rendering' ? `${pct}%` : LABEL[j.state]}
                  </span>
                </div>
                {j.state === 'rendering' && (
                  <div className="bar">
                    <i style={{ width: `${pct}%` }} />
                  </div>
                )}
                {j.error && <div className="job-error">{j.error}</div>}
                <div className="row">
                  {(j.state === 'queued' || j.state === 'rendering') && (
                    <button className="btn ghost sm" onClick={() => window.api.cancelExport(j.id)}>
                      Cancel
                    </button>
                  )}
                  {j.state === 'done' && (
                    <button className="btn ghost sm" onClick={() => window.api.reveal(j.outPath)}>
                      Show in Finder
                    </button>
                  )}
                </div>
              </div>
            )
          })}
          {finished > 0 && (
            <button className="btn ghost sm" onClick={() => window.api.clearFinishedExports()}>
              Clear finished
            </button>
          )}
        </div>
      )}
    </div>
  )
}
