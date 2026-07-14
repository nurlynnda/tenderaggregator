import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import AboutPage from '../pages/AboutPage';

describe('AboutPage', () => {
  it('renders an About heading', () => {
    render(<AboutPage />);
    expect(screen.getByRole('heading', { name: 'About' })).toBeInTheDocument();
  });

  it('links to all three data sources', () => {
    render(<AboutPage />);
    expect(screen.getByRole('link', { name: /myprocurement/i })).toHaveAttribute(
      'href',
      expect.stringContaining('myprocurement.treasury.gov.my'),
    );
    expect(screen.getByRole('link', { name: /span/i })).toHaveAttribute(
      'href',
      expect.stringContaining('span.gov.my'),
    );
    expect(screen.getByRole('link', { name: /kwsp/i })).toHaveAttribute(
      'href',
      expect.stringContaining('kwsp.gov.my'),
    );
  });

  it('states the app is not an official government service', () => {
    render(<AboutPage />);
    expect(screen.getByText(/not (an )?official/i)).toBeInTheDocument();
  });
});
