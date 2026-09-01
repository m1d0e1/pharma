import React from 'react';
import { render, screen } from '@testing-library/react';
import TableScrollContainer from '@/components/ui/TableScrollContainer';

describe('TableScrollContainer Component', () => {
  it('renders children properly', () => {
    render(
      <TableScrollContainer>
        <table data-testid="test-table">
          <tbody>
            <tr>
              <td>Cell 1</td>
              <td>Cell 2</td>
            </tr>
          </tbody>
        </table>
      </TableScrollContainer>
    );

    expect(screen.getByTestId('test-table')).toBeInTheDocument();
    expect(screen.getByText('Cell 1')).toBeInTheDocument();
  });

  it('renders with custom classNames', () => {
    const { container } = render(
      <TableScrollContainer className="custom-table-class" containerClassName="custom-container-class">
        <table>
          <tbody>
            <tr><td>Sample</td></tr>
          </tbody>
        </table>
      </TableScrollContainer>
    );

    expect(container.querySelector('.custom-table-class')).toBeInTheDocument();
    expect(container.querySelector('.custom-container-class')).toBeInTheDocument();
  });
});
