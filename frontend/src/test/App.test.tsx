import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from '../App';

describe('App', () => {
  it('renders the heading and all three nav links', () => {
    render(<App />);
    expect(screen.getByText('Malaysia Tender Aggregator')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Tenders' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Closed Tenders' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Awarded Tenders' })).toBeInTheDocument();
  });

  it('redirects the root route to Open Tenders, which renders the list', async () => {
    render(<App />);
    expect(await screen.findByText('MENYELENGGARA PERALATAN MAKMAL')).toBeInTheDocument();
  });
});
