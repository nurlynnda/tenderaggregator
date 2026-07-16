import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DaysLeftBadge from '../components/DaysLeftBadge';

describe('DaysLeftBadge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T09:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing when closingDate is null', () => {
    const { container } = render(<DaysLeftBadge closingDate={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows red "Today" when closing today', () => {
    render(<DaysLeftBadge closingDate="2026-07-13" />);
    const el = screen.getByTestId('days-left');
    expect(el).toHaveTextContent('Today');
    expect(el).toHaveClass('bg-red-100');
  });

  it('shows red "Overdue" when the closing date has passed', () => {
    render(<DaysLeftBadge closingDate="2026-07-10" />);
    const el = screen.getByTestId('days-left');
    expect(el).toHaveTextContent('Overdue');
    expect(el).toHaveClass('bg-red-100');
  });

  it('shows orange "Nd Left" when closing within 7 days', () => {
    render(<DaysLeftBadge closingDate="2026-07-18" />);
    const el = screen.getByTestId('days-left');
    expect(el).toHaveTextContent('5d Left');
    expect(el).toHaveClass('bg-orange-100');
  });

  it('shows green "Nd Left" when closing more than 7 days out', () => {
    render(<DaysLeftBadge closingDate="2026-08-01" />);
    const el = screen.getByTestId('days-left');
    expect(el).toHaveTextContent('19d Left');
    expect(el).toHaveClass('bg-green-100');
  });
});
