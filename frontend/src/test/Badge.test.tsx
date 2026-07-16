import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import Badge from '../components/Badge';

describe('Badge', () => {
  it('renders the label text', () => {
    render(<Badge label="quotation" />);
    expect(screen.getByText('quotation')).toBeInTheDocument();
  });

  it('applies a known color for a recognized colorKey (case-insensitive)', () => {
    render(<Badge label="Quotation" colorKey="Quotation" />);
    expect(screen.getByText('Quotation')).toHaveClass('bg-orange-100');
  });

  it('falls back to a neutral gray style for an unrecognized colorKey', () => {
    render(<Badge label="060501" colorKey="060501" />);
    expect(screen.getByText('060501')).toHaveClass('bg-gray-100');
  });

  it('uses the label itself as the color key when colorKey is omitted', () => {
    render(<Badge label="span" />);
    expect(screen.getByText('span')).toHaveClass('bg-indigo-100');
  });
});
