import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import BarcodePrinter from '@/components/purchases/BarcodePrinter';

const mockPrint = jest.fn();

jest.mock('react-to-print', () => ({
  useReactToPrint: jest.fn(() => mockPrint),
}));

jest.mock('react-barcode', () => function BarcodeStub({ value }: { value: string }) {
  return <span data-testid="barcode-value">{value}</span>;
});

describe('BarcodePrinter active purchase subcontrol', () => {
  beforeEach(() => jest.clearAllMocks());

  it('renders explicit and fallback barcodes, prints all labels, and exposes close as an accessible action', () => {
    const onClose = jest.fn();
    render(<BarcodePrinter items={[
      {
        id: 11,
        trade_name: 'دواء عربي',
        trade_name_en: 'English Drug',
        barcode: '6221000111',
        selling_price: 25.5,
        expiry_date: '2028-01-31',
      },
      {
        id: 12,
        trade_name: 'Fallback Drug',
        trade_name_en: '',
        barcode: '',
        selling_price: 10,
        expiry_date: '',
      },
    ]} onClose={onClose} />);

    expect(screen.getByText('English Drug')).toBeInTheDocument();
    expect(screen.getByText('Fallback Drug')).toBeInTheDocument();
    expect(screen.getAllByTestId('barcode-value').map(node => node.textContent)).toEqual(['6221000111', 'MD-12']);
    expect(screen.getByText('Price: 25.50')).toBeInTheDocument();
    expect(screen.getByText('Exp: N/A')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'طباعة الكل' }));
    expect(mockPrint).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'إغلاق نافذة طباعة الباركود' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows the dedicated empty state when there are no purchased items to label', () => {
    render(<BarcodePrinter items={[]} onClose={jest.fn()} />);
    expect(screen.getByText('لا توجد أصناف للطباعة')).toBeInTheDocument();
  });
});
