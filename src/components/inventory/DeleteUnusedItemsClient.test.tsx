import { fireEvent, render, screen } from '@testing-library/react';
import DeleteUnusedItemsClient, { DELETE_ITEMS_PAGE_SIZE } from './DeleteUnusedItemsClient';

describe('DeleteUnusedItemsClient pagination', () => {
  it('keeps the large catalogue DOM bounded while retaining access to later items', () => {
    const items = Array.from({ length: DELETE_ITEMS_PAGE_SIZE + 1 }, (_, index) => ({
      id: index + 1,
      trade_name: `دواء ${index + 1}`,
      official_price: 1,
      is_medicine: 1,
    }));

    render(<DeleteUnusedItemsClient initialItems={items} onDelete={jest.fn()} />);
    expect(screen.getAllByRole('button', { name: /^حذف / })).toHaveLength(DELETE_ITEMS_PAGE_SIZE);

    fireEvent.click(screen.getByRole('button', { name: 'التالي' }));
    expect(screen.getByText(`#${DELETE_ITEMS_PAGE_SIZE + 1}`)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^حذف / })).toHaveLength(1);
  });
});
