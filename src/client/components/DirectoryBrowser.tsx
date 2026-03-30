import { useState } from 'react'

interface DirectoryBrowserProps {
  initialPath: string
  onSelect: (path: string) => void
  onCancel: () => void
}

export function DirectoryBrowser({
  initialPath,
  onSelect,
  onCancel,
}: DirectoryBrowserProps) {
  const [currentPath, setCurrentPath] = useState(initialPath)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="rounded-lg bg-white p-6 shadow-xl">
        <h2 className="mb-4 text-lg font-semibold">Browse Directory</h2>
        <input
          value={currentPath}
          onChange={(e) => setCurrentPath(e.target.value)}
          className="input mb-4 w-full"
          placeholder="Enter directory path"
        />
        <div className="flex gap-2">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => onSelect(currentPath)}
          >
            Select
          </button>
          <button
            type="button"
            className="btn"
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
