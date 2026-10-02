import React from 'react';
import { render } from '@testing-library/react';
import { TableSkeleton } from './skeleton';

describe('TableSkeleton rendering', () => {
  it('renders deterministic widths across rerenders', () => {
    const { container, rerender } = render(<TableSkeleton rows={2} columns={3} />);
    const firstWidths = Array.from(container.querySelectorAll<HTMLElement>('[style]')).map(node => node.style.width);

    rerender(<TableSkeleton rows={2} columns={3} />);
    const secondWidths = Array.from(container.querySelectorAll<HTMLElement>('[style]')).map(node => node.style.width);

    expect(secondWidths).toEqual(firstWidths);
  });
});
