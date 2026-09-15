import { render, screen } from '@testing-library/react'
import App from './App'

test('renders coronelli brand', () => {
  render(<App />)
  expect(screen.getByText(/coronelli/i)).toBeInTheDocument()
})
