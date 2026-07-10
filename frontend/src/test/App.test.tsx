import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

  it('renders a Settings link pinned in the nav, leading to the Settings page', async () => {
    render(<App />);
    await userEvent.click(screen.getByRole('link', { name: 'Settings' }));
    expect(await screen.findByText('Data Sources')).toBeInTheDocument();
  });

  it('renders a Dashboard link pinned first in the nav, leading to the Dashboard page', async () => {
    render(<App />);
    await userEvent.click(screen.getByRole('link', { name: 'Dashboard' }));
    expect(await screen.findByText('Spend by Ministry')).toBeInTheDocument();
  });
});
