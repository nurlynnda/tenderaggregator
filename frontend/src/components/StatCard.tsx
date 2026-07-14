interface Props {
  label: string;
  value: string | number;
  className?: string;
}

export default function StatCard({ label, value, className = '' }: Props) {
  return (
    <div className={`bg-white border border-gray-200 rounded-lg shadow-sm p-4 flex-auto min-w-0 ${className}`}>
      <div className="text-xs text-gray-500 truncate">{label}</div>
      <div className="text-lg font-semibold mt-1 break-words">{value}</div>
    </div>
  );
}
