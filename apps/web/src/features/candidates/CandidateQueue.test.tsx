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
  display_summary: 'Casterbridge (settlement)',
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
  display_summary: 'Casterbridge NORTH_OF Forest',
}

const reviewOk = {
  event: { id: 'ev1', candidate_id: 'c1', action: 'approve', canonical_entity_id: 'ent1', canonical_claim_id: null, canonical_travel_rule_id: null, created_at: '2026-01-01T00:00:00Z' },
  canonical_entity: { id: 'ent1', name: 'Casterbridge' },
  canonical_claim: null,
}

function mockFetch(...responses: object[]) {
  let call = 0
  vi.spyOn(global, 'fetch').mockImplementation(() => {
    const body = responses[Math.min(call, responses.length - 1)]
    call++
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response)
  })
}

afterEach(() => vi.restoreAllMocks())

// ── Default confirmed view ─────────────────────────────────────────────────

test('renders candidate summary without review buttons by default', async () => {
  mockFetch([entityCandidate])
  render(<CandidateQueue sectionId="sec1" sectionTitle="Chapter I" />)
  await waitFor(() => expect(screen.getByText(/Casterbridge/)).toBeInTheDocument())
  expect(screen.queryByRole('button', { name: /reject/i })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /defer/i })).not.toBeInTheDocument()
})

test('shows Approve all proposed as the primary action', async () => {
  mockFetch([entityCandidate])
  render(<CandidateQueue sectionId="sec1" sectionTitle="Chapter I" />)
  await waitFor(() => screen.getByRole('button', { name: /approve all proposed/i }))
})

test('shows candidate count in approve button', async () => {
  mockFetch([entityCandidate, claimCandidate])
  render(<CandidateQueue sectionId="sec1" sectionTitle="Chapter I" />)
  await waitFor(() => expect(screen.getByRole('button', { name: /approve all proposed \(2\)/i })).toBeInTheDocument())
})

// ── Approve all ────────────────────────────────────────────────────────────

test('Approve all proposed calls review API for each proposed candidate', async () => {
  const user = userEvent.setup()
  mockFetch([entityCandidate, claimCandidate], reviewOk, reviewOk)
  render(<CandidateQueue sectionId="sec1" sectionTitle="Chapter I" />)
  await waitFor(() => screen.getByRole('button', { name: /approve all proposed/i }))

  await user.click(screen.getByRole('button', { name: /approve all proposed/i }))

  await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(3))
  const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
  expect(JSON.parse((calls[1][1] as RequestInit).body as string)).toMatchObject({ action: 'approve' })
  expect(JSON.parse((calls[2][1] as RequestInit).body as string)).toMatchObject({ action: 'approve' })
})

// ── Challenge exception workflow ───────────────────────────────────────────

test('Challenge button reveals excerpt and exception actions', async () => {
  const user = userEvent.setup()
  mockFetch([entityCandidate])
  render(<CandidateQueue sectionId="sec1" sectionTitle="Chapter I" />)
  await waitFor(() => screen.getByRole('button', { name: /challenge/i }))

  await user.click(screen.getByRole('button', { name: /challenge/i }))

  expect(screen.getByText(/Casterbridge lay amid the cornfields/i)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /reject/i })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /defer/i })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /edit & approve/i })).toBeInTheDocument()
})

test('Reject in challenge view calls review API with reject', async () => {
  const user = userEvent.setup()
  mockFetch([entityCandidate], { ...reviewOk, event: { ...reviewOk.event, action: 'reject' } })
  render(<CandidateQueue sectionId="sec1" sectionTitle="Chapter I" />)
  await waitFor(() => screen.getByRole('button', { name: /challenge/i }))

  await user.click(screen.getByRole('button', { name: /challenge/i }))
  await user.click(screen.getByRole('button', { name: /reject/i }))

  const [, opts] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[1]
  expect(JSON.parse((opts as RequestInit).body as string)).toMatchObject({ action: 'reject' })
})

test('Defer in challenge view calls review API with defer', async () => {
  const user = userEvent.setup()
  mockFetch([entityCandidate], { ...reviewOk, event: { ...reviewOk.event, action: 'defer' } })
  render(<CandidateQueue sectionId="sec1" sectionTitle="Chapter I" />)
  await waitFor(() => screen.getByRole('button', { name: /challenge/i }))

  await user.click(screen.getByRole('button', { name: /challenge/i }))
  await user.click(screen.getByRole('button', { name: /defer/i }))

  const [, opts] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[1]
  expect(JSON.parse((opts as RequestInit).body as string)).toMatchObject({ action: 'defer' })
})

test('Cancel in challenge view hides exception actions', async () => {
  const user = userEvent.setup()
  mockFetch([entityCandidate])
  render(<CandidateQueue sectionId="sec1" sectionTitle="Chapter I" />)
  await waitFor(() => screen.getByRole('button', { name: /challenge/i }))

  await user.click(screen.getByRole('button', { name: /challenge/i }))
  expect(screen.getByRole('button', { name: /reject/i })).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: /cancel/i }))
  expect(screen.queryByRole('button', { name: /reject/i })).not.toBeInTheDocument()
})

// ── Edit & approve exception workflow ──────────────────────────────────────

test('Edit & approve opens edit form with existing name', async () => {
  const user = userEvent.setup()
  mockFetch([entityCandidate])
  render(<CandidateQueue sectionId="sec1" sectionTitle="Chapter I" />)
  await waitFor(() => screen.getByRole('button', { name: /challenge/i }))

  await user.click(screen.getByRole('button', { name: /challenge/i }))
  await user.click(screen.getByRole('button', { name: /edit & approve/i }))

  expect(screen.getByRole('textbox', { name: /candidate name/i })).toHaveValue('Casterbridge')
})

test('editing name and approving sends edited_payload', async () => {
  const user = userEvent.setup()
  mockFetch([entityCandidate], reviewOk)
  render(<CandidateQueue sectionId="sec1" sectionTitle="Chapter I" />)
  await waitFor(() => screen.getByRole('button', { name: /challenge/i }))

  await user.click(screen.getByRole('button', { name: /challenge/i }))
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

// ── Other states ───────────────────────────────────────────────────────────

test('shows empty state when no candidates', async () => {
  mockFetch([])
  render(<CandidateQueue sectionId="sec1" sectionTitle="Chapter I" />)
  await waitFor(() => expect(screen.getByText(/no candidates extracted/i)).toBeInTheDocument())
})

test('approved candidates still show Challenge button', async () => {
  const approved = { ...entityCandidate, review_state: 'approved' }
  mockFetch([approved])
  render(<CandidateQueue sectionId="sec1" sectionTitle="Chapter I" />)
  await waitFor(() => expect(screen.getByRole('button', { name: /challenge/i })).toBeInTheDocument())
  expect(screen.queryByRole('button', { name: /approve all proposed/i })).not.toBeInTheDocument()
})

test('terminal states (rejected, deferred) hide Challenge button', async () => {
  const rejected = { ...entityCandidate, review_state: 'rejected' }
  mockFetch([rejected])
  render(<CandidateQueue sectionId="sec1" sectionTitle="Chapter I" />)
  await waitFor(() => expect(screen.getByText(/Casterbridge/)).toBeInTheDocument())
  expect(screen.queryByRole('button', { name: /challenge/i })).not.toBeInTheDocument()
})
