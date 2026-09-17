import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import BilingualManagementClient from '@/components/inventory/BilingualManagementClient';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';

jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(),
  hasUserPermissionSync: jest.fn(),
}));

const mutation = jest.fn(async () => ({ success: true }));

describe('shared bilingual master-data permissions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getClientSession as jest.Mock).mockResolvedValue({ id: 'staff', role: 'pharmacist' });
    (hasUserPermissionSync as jest.Mock).mockReturnValue(false);
  });

  it('keeps read-only data visible but hides mutation controls without can_manage_inventory', async () => {
    render(
      <BilingualManagementClient
        initialData={[{ id: 1, name_ar: 'View only', name_en: 'VIEW ONLY' }]}
        title="Usage"
        iconName="Info"
        onAdd={mutation}
        onUpdate={mutation}
        onDelete={mutation}
      />
    );

    expect(screen.getByText('View only')).toBeInTheDocument();
    await waitFor(() => expect(getClientSession).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /Usage/ })).not.toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('shows mutation controls when can_manage_inventory is granted', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({ id: 'owner', role: 'owner' });
    (hasUserPermissionSync as jest.Mock).mockReturnValue(true);

    render(
      <BilingualManagementClient
        initialData={[{ id: 1, name_ar: 'Managed', name_en: 'MANAGED' }]}
        title="Usage"
        iconName="Info"
        onAdd={mutation}
        onUpdate={mutation}
        onDelete={mutation}
      />
    );

    expect(await screen.findByRole('button', { name: /Usage/ })).toBeInTheDocument();
  });

});
