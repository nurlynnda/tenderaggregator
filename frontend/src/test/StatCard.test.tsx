import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import StatCard from '../components/StatCard';

describe('StatCard', () => {
  it('renders the label and value', () => {
    render(<StatCard label="Open Tenders" value={128} />);
    expect(screen.getByText('Open Tenders')).toBeInTheDocument();
    expect(screen.getByText('128')).toBeInTheDocument();
  });

  it('renders a string value as-is', () => {
    render(<StatCard label="Awarded" value="—" />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('applies an extra className to the card root for callers that need to widen it', () => {
    render(<StatCard label="Total Awarded Value" value="RM 144,178,825,811.57" className="col-span-2" />);
    expect(screen.getByText('Total Awarded Value').parentElement).toHaveClass('col-span-2');
  });
});
