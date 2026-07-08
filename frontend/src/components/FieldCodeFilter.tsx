import { useMemo, useState } from 'react';
import { FIELD_CODE_TREE, flattenFieldCodes } from '@tms/shared';

interface Props {
  value: string;
  onChange: (code: string) => void;
}

const FLAT = flattenFieldCodes(FIELD_CODE_TREE);

export default function FieldCodeFilter({ value, onChange }: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);

  const filtered = useMemo(() => {
    const needle = query.trim();
    if (!needle) return FLAT;
    const lower = needle.toLowerCase();
    return FLAT.filter((n) => n.code.startsWith(needle) || n.name.toLowerCase().includes(lower));
  }, [query]);

  const selected = FLAT.find((n) => n.code === value);
  const displayValue = open ? query : selected ? `${selected.code} — ${selected.name}` : '';

  return (
    <div className="relative flex flex-col text-sm gap-1">
      <label htmlFor="field-code-input">Field Code</label>
      <input
        id="field-code-input"
        className="border rounded-md px-2 py-2"
        placeholder="All"
        value={displayValue}
        onFocus={() => { setOpen(true); setQuery(''); }}
        onChange={(e) => setQuery(e.target.value)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {value && (
        <button
          type="button"
          className="text-xs text-blue-700 underline text-left"
          onMouseDown={() => { onChange(''); setQuery(''); }}
        >
          Clear
        </button>
      )}
      {open && (
        <ul className="absolute top-full z-10 mt-1 max-h-64 w-96 overflow-y-auto border rounded-md bg-white shadow-lg">
          {filtered.map((n) => (
            <li key={n.code}>
              <button
                type="button"
                className="w-full text-left px-2 py-1 hover:bg-blue-50"
                style={{ paddingLeft: `${8 + (n.path.length - 1) * 16}px` }}
                onMouseDown={() => { onChange(n.code); setQuery(''); setOpen(false); }}
              >
                {n.code} — {n.name}
              </button>
            </li>
          ))}
          {filtered.length === 0 && <li className="px-2 py-1 text-gray-500">No matches</li>}
        </ul>
      )}
    </div>
  );
}
