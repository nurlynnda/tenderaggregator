interface Props {
  label: string;
  value: string | number;
}

export default function StatCard({ label, value }: Props) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-sm p-4 min-w-0">
      <div className="text-xs text-gray-500 truncate">{label}</div>
      <div className="text-xs font-semibold mt-1 break-words">{value}</div>
    </div>
  );
}
