import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SectionEditor } from './SectionEditor'
import type { Section } from './sourceApi'

const twoSections: Section[] = [
  {
    id: 's1',
    document_id: 'doc1',
    ordinal: 0,
    title: 'Scene One',
    text: 'Content of scene one.',
    page_start: null,
    page_end: null,
    user_corrected: false,
  },
  {
    id: 's2',
    document_id: 'doc1',
    ordinal: 1,
    title: 'Scene Two',
    text: 'Content of scene two.',
    page_start: null,
    page_end: null,
    user_corrected: false,
  },
]

test('renders titles in confirmed view by default', () => {
  render(<SectionEditor documentId="doc1" sections={twoSections} onSave={vi.fn()} />)
  expect(screen.getByText(/Scene One/)).toBeInTheDocument()
  expect(screen.getByText(/Scene Two/)).toBeInTheDocument()
})

test('Edit sections button switches to editable form', async () => {
  const user = userEvent.setup()
  render(<SectionEditor documentId="doc1" sections={twoSections} onSave={vi.fn()} />)
  await user.click(screen.getByRole('button', { name: /edit sections/i }))
  expect(screen.getByDisplayValue('Scene One')).toBeInTheDocument()
  expect(screen.getByDisplayValue('Scene Two')).toBeInTheDocument()
})

test('submits corrected title in ordered payload', async () => {
  const user = userEvent.setup()
  const onSave = vi.fn()

  render(<SectionEditor documentId="doc1" sections={twoSections} onSave={onSave} />)
  await user.click(screen.getByRole('button', { name: /edit sections/i }))

  const firstTitle = screen.getByDisplayValue('Scene One')
  await user.clear(firstTitle)
  await user.type(firstTitle, 'Prologue')

  await user.click(screen.getByRole('button', { name: /save sections/i }))

  expect(onSave).toHaveBeenCalledOnce()
  const payload = onSave.mock.calls[0][0]
  expect(payload).toHaveLength(2)
  expect(payload[0]).toMatchObject({ id: 's1', title: 'Prologue', ordinal: 0 })
  expect(payload[1]).toMatchObject({ id: 's2', title: 'Scene Two', ordinal: 1 })
})

test('unchanged section keeps its original title in payload', async () => {
  const user = userEvent.setup()
  const onSave = vi.fn()

  render(<SectionEditor documentId="doc1" sections={twoSections} onSave={onSave} />)
  await user.click(screen.getByRole('button', { name: /edit sections/i }))
  await user.click(screen.getByRole('button', { name: /save sections/i }))

  const payload = onSave.mock.calls[0][0]
  expect(payload[1]).toMatchObject({ id: 's2', title: 'Scene Two' })
})
