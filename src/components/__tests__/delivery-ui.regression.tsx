import { render, screen } from '@testing-library/react';
import DeliveryManagementClient from '@/components/sales/DeliveryManagementClient';

jest.mock('@/app/actions-client/delivery', () => ({
  getPendingDeliveriesAction: jest.fn(async () => ({
    success: true,
    data: [{
      id: 'delivery-1',
      total_amount: 20,
      created_at: '2026-09-17T10:00:00.000Z',
      patient_name: null,
      patient_phone: null,
      patient_address: null,
    }],
  })),
  closeDeliveryInvoiceAction: jest.fn(),
}));

describe('delivery management controls', () => {
  it('does not advertise an unimplemented F10 shortcut on the close button', async () => {
    render(<DeliveryManagementClient />);

    const closeButton = await screen.findByRole('button', { name: 'إغلاق وتأكيد' });
    expect(closeButton).toBeInTheDocument();
    expect(closeButton).not.toHaveTextContent('F10');
  });
});
