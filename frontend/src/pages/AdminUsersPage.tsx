import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchAdminUsers, updateUserRole } from '../api/client';
import type { Role } from '../api/types';

export default function AdminUsersPage() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const { data: users } = useQuery({ queryKey: ['admin-users'], queryFn: fetchAdminUsers });
  const roleMutation = useMutation({
    mutationFn: (params: { id: string; role: Role }) => updateUserRole(params.id, params.role),
    onMutate: () => setError(null),
    onError: (err: unknown) => {
      setError(err instanceof Error ? err.message : 'Could not update role. Please try again.');
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['admin-users'] }),
  });

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="font-semibold text-lg">Manage users</h1>
      {error && <div role="alert" className="text-sm text-red-700">{error}</div>}
      <div className="border border-[#e0e0e0] rounded-lg divide-y">
        {(users ?? []).map((u) => (
          <div key={u.id} className="p-4 flex items-center justify-between gap-4">
            <div>
              <div className="font-medium">{u.name}</div>
              <div className="text-xs text-gray-500">
                <span>{u.email}</span> · joined {u.createdAt.slice(0, 10)}
              </div>
            </div>
            <label className="text-sm">
              <span className="sr-only">Role for {u.email}</span>
              <select
                aria-label={`Role for ${u.email}`}
                value={u.role}
                onChange={(e) => roleMutation.mutate({ id: u.id, role: e.target.value as Role })}
                className="border border-[#e0e0e0] rounded-md px-2 py-1"
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
            </label>
          </div>
        ))}
      </div>
    </div>
  );
}
