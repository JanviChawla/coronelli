import { render, screen } from '@testing-library/react'
import App from './App'

test('renders coronelli heading', () => {
  render(<App />)
  expect(screen.getByRole('heading', { name: /coronelli/i })).toBeInTheDocument()
})
