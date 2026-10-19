import { act, render, screen } from '@testing-library/react';
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table';
import TableScrollContainer from '@/components/ui/TableScrollContainer';

it('adds one named keyboard stop only when a shared table actually overflows', () => {
  const { container } = render(
    <TableScrollContainer>
      <Table scrollRegionLabel="تفاصيل الأصناف"><TableBody><TableRow><TableCell>صنف</TableCell></TableRow></TableBody></Table>
    </TableScrollContainer>,
  );
  expect(screen.queryByRole('region', { name: 'تفاصيل الأصناف' })).not.toBeInTheDocument();
  const viewport = container.querySelector('table')?.parentElement;
  expect(viewport).not.toBeNull();
  Object.defineProperty(viewport, 'scrollWidth', { configurable: true, value: 900 });
  Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 350 });
  act(() => { window.dispatchEvent(new Event('resize')); });
  const scrollViewport = screen.getByRole('region', { name: 'تفاصيل الأصناف' });
  expect(scrollViewport).toHaveAttribute('tabindex', '0');
  expect(scrollViewport.querySelector('table')).toBeInTheDocument();
  expect(screen.getAllByRole('region')).toHaveLength(1);
});
