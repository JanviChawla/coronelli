export type Phase =
  | 'preflight'
  | 'ready'
  | 'cataloging'
  | 'catalog-review'
  | 'evidence-ready'
  | 'extracting'
  | 'inspecting'
  | 'synthesizing'
  | 'done'
  | 'error'

export type StepStatus = 'done' | 'active' | 'running' | 'locked'

export interface Toast {
  id: string
  message: string
  kind: 'info' | 'success' | 'warn'
}
