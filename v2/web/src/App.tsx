import { useState } from 'react'
import { type Document } from './api/client'
import LibraryScene from './features/library/LibraryScene'
import WorkflowPanel from './features/workflow/WorkflowPanel'
import AtlasScene from './features/atlas/AtlasScene'

type AppState =
  | { screen: 'library' }
  | { screen: 'workflow'; documentId: string }
  | { screen: 'atlas'; documentId: string }

export default function App() {
  const [state, setState] = useState<AppState>({ screen: 'library' })

  return (
    <div style={{ width: '100%', height: '100vh', position: 'relative' }}>
      <LibraryScene
        onExplore={(docId) => setState({ screen: 'workflow', documentId: docId })}
        onImport={(_file, _meta) => {
          // LibraryScene handles the upload; it refreshes its own list.
          // After upload completes the user can click Explore from the new planet.
        }}
      />

      {state.screen === 'workflow' && (
        <WorkflowPanel
          documentId={state.documentId}
          onClose={() => setState({ screen: 'library' })}
          onOpenAtlas={() => setState({ screen: 'atlas', documentId: state.documentId })}
        />
      )}

      {state.screen === 'atlas' && (
        <AtlasScene
          documentId={state.documentId}
          onClose={() => setState({ screen: 'workflow', documentId: state.documentId })}
        />
      )}
    </div>
  )
}
