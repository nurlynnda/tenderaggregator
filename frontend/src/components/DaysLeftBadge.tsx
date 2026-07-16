import { daysUntil } from '../lib/dateRange';

interface Props {
  closingDate: string | null;
}

export default function DaysLeftBadge({ closingDate }: Props) {
  if (closingDate === null) return null;
  const days = daysUntil(closingDate);

  let color: string;
  let label: string;
  if (days < 0) {
    color = 'bg-red-100 text-red-700';
    label = 'Overdue';
  } else if (days === 0) {
    color = 'bg-red-100 text-red-700';
    label = 'Today';
  } else if (days <= 7) {
    color = 'bg-orange-100 text-orange-700';
    label = `${days}d Left`;
  } else {
    color = 'bg-green-100 text-green-700';
    label = `${days}d Left`;
  }

  return (
    <span
      data-testid="days-left"
      className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium whitespace-nowrap ${color}`}
    >
      {label}
    </span>
  );
}
