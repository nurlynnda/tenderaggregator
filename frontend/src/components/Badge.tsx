interface Props {
  label: string;
  colorKey?: string;
}

const COLOR_MAP: Record<string, string> = {
  quotation: 'bg-blue-100 text-blue-700',
  tender: 'bg-purple-100 text-purple-700',
  myprocurement: 'bg-teal-100 text-teal-700',
  span: 'bg-indigo-100 text-indigo-700',
  kwsp: 'bg-amber-100 text-amber-700',
};
const NEUTRAL = 'bg-gray-100 text-gray-700';

export default function Badge({ label, colorKey }: Props) {
  const key = (colorKey ?? label).toLowerCase();
  const className = COLOR_MAP[key] ?? NEUTRAL;
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium whitespace-nowrap ${className}`}>
      {label}
    </span>
  );
}
