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
});
