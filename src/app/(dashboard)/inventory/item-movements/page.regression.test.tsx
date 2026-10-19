/** @jest-environment jsdom */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockGetMovements = jest.fn();
jest.mock('@/lib/auth/local', () => ({ getClientSession: jest.fn(async () => ({ id: 'reader' })) }));
jest.mock('@/app/actions-client/inventory', () => ({
  getMovementsAction: (...args: unknown[]) => mockGetMovements(...args),
}));
jest.mock('@/components/AccessDenied', () => function MockAccessDenied() {
  return <div>Access denied</div>;
});

import ItemMovementsPage from './page';

describe('native item movement medicine labels', () => {
  beforeEach(() => {
    mockGetMovements.mockReset();
    mockGetMovements.mockResolvedValue({
      success: true,
      data: [
        { id: 1, action: 'COMPLETE_SALE', details: 'Sale sale-42 value 25', drug_names: ['Panadol', 'Brufen'], user_name: 'Cashier' },
        { id: 2, action: 'CREATE_RETURN', details: 'Return ret-42 value 5', drug_names: ['Brufen'], user_name: 'Cashier' },
        { id: 3, action: 'STOCK_ADJUSTMENT', details: 'Updated tenant lot lot-a drug=41', drug_names: ['Augmentin'], user_name: 'Cashier' },
        { id: 4, action: 'ADD_INVENTORY', details: 'native-inventory-create-request=abc; lot_id=lot-b; drug_id=41', drug_names: ['Augmentin'], user_name: 'Cashier' },
        { id: 5, action: 'COMPLETE_SALE', details: 'Sale unknown value 10 من Panadol', drug_names: [], user_name: 'Cashier' },
        { id: 6, action: 'ADD_INVENTORY', details: 'أضاف 2 من سيتريزين', drug_names: [], user_name: 'Cashier' },
      ],
    });
  });

  it('renders verified native names, multiple products, and unknown provenance without guessing', async () => {
    render(<ItemMovementsPage />);
    await waitFor(() => expect(screen.getByText('Panadol، Brufen')).toBeInTheDocument());
    expect(screen.getByText('Brufen')).toBeInTheDocument();
    expect(screen.getAllByText('Augmentin')).toHaveLength(2);
    expect(screen.getByText('---')).toBeInTheDocument();
    expect(screen.getByText('سيتريزين')).toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText('ابحث عن صنف أو عملية...'), 'Augmentin');
    expect(screen.getAllByText('Augmentin')).toHaveLength(2);
    expect(screen.queryByText('Panadol، Brufen')).not.toBeInTheDocument();
  });
});
