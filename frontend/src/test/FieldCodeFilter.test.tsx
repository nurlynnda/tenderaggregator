import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import FieldCodeFilter from '../components/FieldCodeFilter';

describe('FieldCodeFilter', () => {
  it('shows the full tree on focus, indented by depth', async () => {
    render(<FieldCodeFilter value="" onChange={vi.fn()} />);
    await userEvent.click(screen.getByLabelText(/field code/i));
    expect(await screen.findByText(/01 — Penerbitan Dan Penyiaran/)).toBeInTheDocument();
  });

  it('narrows the list when typing a code prefix', async () => {
    render(<FieldCodeFilter value="" onChange={vi.fn()} />);
    const input = screen.getByLabelText(/field code/i);
    await userEvent.click(input);
    await userEvent.type(input, '2208');
    expect(await screen.findByText(/220801/)).toBeInTheDocument();
    expect(screen.queryByText(/010101/)).not.toBeInTheDocument();
  });

  it('narrows the list when typing a name fragment', async () => {
    render(<FieldCodeFilter value="" onChange={vi.fn()} />);
    const input = screen.getByLabelText(/field code/i);
    await userEvent.click(input);
    await userEvent.type(input, 'hotel');
    expect(await screen.findByText(/Hotel\/ Resort/)).toBeInTheDocument();
  });

  it('calls onChange with the selected code and closes the dropdown', async () => {
    const onChange = vi.fn();
    render(<FieldCodeFilter value="" onChange={onChange} />);
    const input = screen.getByLabelText(/field code/i);
    await userEvent.click(input);
    await userEvent.type(input, '220801');
    await userEvent.click(await screen.findByText(/220801 — Kawalan Keselamatan/));
    expect(onChange).toHaveBeenCalledWith('220801');
  });

  it('shows the selected code + name in the input when closed', () => {
    render(<FieldCodeFilter value="220801" onChange={vi.fn()} />);
    expect(screen.getByLabelText(/field code/i)).toHaveValue('220801 — Kawalan Keselamatan (Perlu lesen KDN)');
  });

  it('shows a Clear control when a value is selected, which resets to empty', async () => {
    const onChange = vi.fn();
    render(<FieldCodeFilter value="220801" onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: /clear/i }));
    expect(onChange).toHaveBeenCalledWith('');
  });
});
