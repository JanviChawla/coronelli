import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CandidateQueue } from './CandidateQueue'
import type { Candidate } from './candidateApi'

const entityCandidate: Candidate = {
  id: 'c1',
  extraction_run_id: 'r1',
  section_id: 'sec1',
  kind: 'entity',
  payload: { name: 'Casterbridge', type: 'settlement' },
  status: 'explicit',
  confidence: 0.9,
  excerpt: 'The village of Casterbridge lay amid the cornfields.',
  rationale: 'Named place.',
  review_state: 'proposed',
  ordinal: 0,
  temporal_interpretation: 'static',
  first_revealed_at_section_id: null,
  relation_kind: null,
  relation_target_id: null,
}

const claimCandidate: Candidate = {
  id: 'c2',
  extraction_run_id: 'r1',
  section_id: 'sec1',
  kind: 'claim',
  payload: { subject: 'Casterbridge', predicate: 'NORTH_OF', object: 'Forest' },
  status: 'inferred',
  confidence: 0.75,
  excerpt: 'The forest lay to the south.',
  rationale: 'Direction inferred.',
  review_state: 'proposed',
  ordinal: 1,
  temporal_interpretation: 'static',
  first_revealed_at_section_id: null,
  relation_kind: null,
  relation_target_id: null,
}

const reviewOkResponse = {
  event: {
    id: 'ev1',
    candidate_id: 'c1',
    action: 'approve',
    canonical_entity_id: 'ent1',
    canonical_claim_id: null,
    canonical_travel_rule_id: null,
    created_at: '2026-01-01T00:00:00Z',
  },
  canonical_entity: { id: 'ent1', name: 'Casterbridge' },
  canonical_claim: null,
}

function mockFetch(...responses: object[]) {
  let call = 0
  vi.spyOn(global, 'fetch').mockImplementation(() => {
    const body = responses[call] ?? responses[responses.length - 1]
    call++
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response)
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

test('renders source excerpt for a candidate', async () => {
  mockFetch([entityCandidate])
  render(<CandidateQueue sectionId="sec1" sectionTitle="Chapter I" />)
  await waitFor(() =>
    expect(screen.getByText(/Casterbridge lay amid the cornfields/i)).toBeInTheDocument(),
  )
})

test('renders explicit status badge', async () => {
  mockFetch([entityCandidate])
  render(<CandidateQueue sectionId="sec1" sectionTitle="Chapter I" />)
  await waitFor(() => expect(screen.getByText('explicit')).toBeInTheDocument())
})

test('renders provisional badge for proposed candidates', async () => {
  mockFetch([entityCandidate])
  render(<CandidateQueue sectionId="sec1" sectionTitle="Chapter I" />)
  await waitFor(() => expect(screen.getByText('provisional')).toBeInTheDocument())
})

test('clicking Approve candidate calls review API with approve', async () => {
  const user = userEvent.setup()
  mockFetch([entityCandidate], reviewOkResponse)
  render(<CandidateQueue sectionId="sec1" sectionTitle="Chapter I" />)
  await waitFor(() => screen.getByRole('button', { name: /approve candidate/i }))

  await user.click(screen.getByRole('button', { name: /approve candidate/i }))

  expect(global.fetch).toHaveBeenCalledTimes(2)
  const [url, opts] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[1]
  expect(url).toContain('/api/candidates/c1/review')
  expect(JSON.parse((opts as RequestInit).body as string)).toMatchObject({ action: 'approve' })
})

test('clicking Challenge candidate calls review API with reject', async () => {
  const user = userEvent.setup()
  mockFetch([entityCandidate], { ...reviewOkResponse, event: { ...reviewOkResponse.event, action: 'reject' } })
  render(<CandidateQueue sectionId="sec1" sectionTitle="Chapter I" />)
  await waitFor(() => screen.getByRole('button', { name: /challenge candidate/i }))

  await user.click(screen.getByRole('button', { name: /challenge candidate/i }))

  const [, opts] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[1]
  expect(JSON.parse((opts as RequestInit).body as string)).toMatchObject({ action: 'reject' })
})

test('clicking Defer candidate calls review API with defer', async () => {
  const user = userEvent.setup()
  mockFetch([entityCandidate], { ...reviewOkResponse, event: { ...reviewOkResponse.event, action: 'defer' } })
  render(<CandidateQueue sectionId="sec1" sectionTitle="Chapter I" />)
  await waitFor(() => screen.getByRole('button', { name: /defer candidate/i }))

  await user.click(screen.getByRole('button', { name: /defer candidate/i }))

  const [, opts] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[1]
  expect(JSON.parse((opts as RequestInit).body as string)).toMatchObject({ action: 'defer' })
})

test('editing name and approving sends edited_payload', async () => {
  const user = userEvent.setup()
  mockFetch([entityCandidate], reviewOkResponse)
  render(<CandidateQueue sectionId="sec1" sectionTitle="Chapter I" />)
  await waitFor(() => screen.getByRole('button', { name: /edit & approve/i }))

  await user.click(screen.getByRole('button', { name: /edit & approve/i }))

  const nameInput = screen.getByRole('textbox', { name: /candidate name/i })
  await user.clear(nameInput)
  await user.type(nameInput, 'Casterton')

  await user.click(screen.getByRole('button', { name: /approve candidate/i }))

  const [, opts] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[1]
  const body = JSON.parse((opts as RequestInit).body as string)
  expect(body.action).toBe('approve')
  expect(body.edited_payload).toMatchObject({ name: 'Casterton' })
})

test('shows empty state when no candidates', async () => {
  mockFetch([])
  render(<CandidateQueue sectionId="sec1" sectionTitle="Chapter I" />)
  await waitFor(() =>
    expect(screen.getByText(/no candidates extracted/i)).toBeInTheDocument(),
  )
})

test('shows candidate count summary', async () => {
  mockFetch([entityCandidate, claimCandidate])
  render(<CandidateQueue sectionId="sec1" sectionTitle="Chapter I" />)
  await waitFor(() => expect(screen.getByText(/2 candidates/i)).toBeInTheDocument())
})
